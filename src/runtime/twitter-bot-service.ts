import { TwitterApi } from "twitter-api-v2";
import {
  AgentService,
  AGENT_DEFAULTS,
  CACHE_TIMEOUTS,
  createPluginModuleLogger,
  createRuntimeId,
  kvService,
  LogStorage,
  RateLimitManager,
  type TwitterConfig,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";
import { XService } from "../x-service";
import { PollingManager } from "./twitter/polling-manager";
import { TwitterCommandHandler } from "./twitter/twitter-command-handler";
import { ContentGenerator } from "./twitter/content-generator";
import type { TwitterUser } from "./twitter/types";

const logger = createPluginModuleLogger("TwitterBotService");

/** Extended Twitter config with autonomous posting fields not in base TwitterConfig */
interface TwitterExtendedConfig extends TwitterConfig {
  enableStreaming?: boolean;
  enableAutonomousPosting?: boolean;
  postingIntervalMinutes?: number;
  maxPostsPerDay?: number;
  postingHours?: string;
  requireApprovalForAutonomous?: boolean;
  twitter?: Record<string, unknown>;
  advanced?: {
    replySettings?: {
      requireApprovalForReplies?: boolean;
    };
  } & TwitterConfig['advanced'];
}

/** Cached Twitter user info */
interface TwitterUserInfo {
  id: string;
  username: string;
}

export interface TwitterMessage {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{
    type: string;
    id: string;
  }>;
  public_metrics?: {
    retweet_count: number;
    like_count: number;
    reply_count: number;
    quote_count: number;
  };
}

interface PendingNotification {
  id: string;
  type: "tweet_approval" | "reply_approval";
  platform: "twitter";
  timestamp: string;
  status: "pending";
  content: {
    text?: string;
    targetUser?: string;
    originalTweet?: string;
    reason?: string;
    mediaUrls?: string[];
  };
  metadata?: Record<string, unknown>;
}

interface LlmGenerationSummary {
  template?: string;
  promptLength: number;
  rawResponseLength: number;
  cleanedResponseLength: number;
  generatedAt: string;
}

function summarizeLlmGeneration(metadata: {
  template?: string;
  prompt: string;
  rawResponse: string;
  cleanedResponse: string;
  timestamp: string;
}): LlmGenerationSummary {
  return {
    template: metadata.template,
    promptLength: metadata.prompt.length,
    rawResponseLength: metadata.rawResponse.length,
    cleanedResponseLength: metadata.cleanedResponse.length,
    generatedAt: metadata.timestamp,
  };
}

function sanitizePendingNotification(
  notification: PendingNotification,
): PendingNotification {
  const metadata = notification.metadata;
  if (!metadata) {
    return notification;
  }

  const llmGeneration = metadata.llmGeneration;
  const llmMetadata = metadata.llmMetadata;
  const generationSource =
    llmGeneration &&
    typeof llmGeneration === "object" &&
    !Array.isArray(llmGeneration)
      ? (llmGeneration as Record<string, unknown>)
      : llmMetadata &&
          typeof llmMetadata === "object" &&
          !Array.isArray(llmMetadata)
        ? (llmMetadata as Record<string, unknown>)
        : null;

  if (!generationSource) {
    return notification;
  }

  const prompt = typeof generationSource.prompt === "string"
    ? generationSource.prompt
    : "";
  const rawResponse = typeof generationSource.rawResponse === "string"
    ? generationSource.rawResponse
    : "";
  const cleanedResponse = typeof generationSource.cleanedResponse === "string"
    ? generationSource.cleanedResponse
    : "";
  const sanitizedGeneration: Record<string, unknown> = {
    ...generationSource,
    promptLength:
      typeof generationSource.promptLength === "number"
        ? generationSource.promptLength
        : prompt.length,
    rawResponseLength:
      typeof generationSource.rawResponseLength === "number"
        ? generationSource.rawResponseLength
        : rawResponse.length,
    cleanedResponseLength:
      typeof generationSource.cleanedResponseLength === "number"
        ? generationSource.cleanedResponseLength
        : cleanedResponse.length,
  };
  delete sanitizedGeneration.prompt;
  delete sanitizedGeneration.rawResponse;
  delete sanitizedGeneration.cleanedResponse;

  const sanitizedMetadata: Record<string, unknown> = {
    ...metadata,
    llmGeneration: sanitizedGeneration,
  };
  delete sanitizedMetadata.llmMetadata;

  return {
    ...notification,
    metadata: sanitizedMetadata,
  };
}

export class TwitterBotService {
  private client: TwitterApi | null = null;
  private stream: unknown = null;
  private isConnected: boolean = false;
  private isStreaming: boolean = false;
  private env: ServerEnv;
  private config: TwitterExtendedConfig;
  private agentService: AgentService;
  private logStorage: LogStorage;
  private autonomousPostingInterval: ReturnType<typeof setInterval> | null = null;
  private userInfoCache: { data: TwitterUserInfo; timestamp: number } | null = null;
  private readonly USER_CACHE_TTL = CACHE_TIMEOUTS.userInfo;

  // Modular services
  private pollingManager: PollingManager | null = null;
  private rateLimitManager: RateLimitManager;
  private commandHandler: TwitterCommandHandler | null = null;
  private contentGenerator: ContentGenerator;

  constructor(env: ServerEnv, config: TwitterConfig) {
    this.env = env;
    this.config = config;
    this.agentService = new AgentService(env);
    this.logStorage = LogStorage.getInstance();
    this.rateLimitManager = RateLimitManager.getInstance();
    this.contentGenerator = new ContentGenerator(this.agentService);
  }

  async start(): Promise<void> {
    logger.info("🐦 Starting Twitter bot...");

    if (this.isConnected) {
      logger.info("🔗 Already connected");
      return;
    }

    try {
      // Check if streaming is enabled - only validate credentials with API if needed
      const enableStreaming = this.config.enableStreaming ?? false;

      await this.connect(enableStreaming);

      // Only start streaming if enabled
      if (enableStreaming) {
        await this.startStreaming();
      }

      logger.info("✅ Twitter bot started successfully");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("❌ Failed to start Twitter bot:", {
        error: err.message,
        code: (error as Record<string, unknown>)?.code,
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info("🛑 Stopping Twitter bot...");

    this.isConnected = false;
    this.isStreaming = false;

    // Stop polling if active
    if (this.pollingManager) {
      await this.pollingManager.stopPolling();
      this.pollingManager = null;
    }

    if (this.stream) {
      try {
        await (this.stream as { close(): Promise<void> }).close();
        this.stream = null;
      } catch (error) {
        logger.error("Error closing Twitter stream:", error);
      }
    }

    this.stopAutonomousPosting();
    this.client = null;
    this.rateLimitManager.clear();
    this.userInfoCache = null;

    logger.info("✅ Twitter bot stopped");
  }

  private async connect(validateWithAPI: boolean = true): Promise<void> {
    try {
      // Validate credentials
      const hasApiKey = !!this.config.apiKey;
      const hasApiSecret = !!this.config.apiSecret;
      const hasAccessToken = !!this.config.accessToken;
      const hasAccessSecret = !!this.config.accessSecret;

      logger.info("🔑 Validating credentials:", {
        hasApiKey,
        hasApiSecret,
        hasAccessToken,
        hasAccessSecret,
        validateWithAPI,
      });

      if (!hasApiKey || !hasApiSecret || !hasAccessToken || !hasAccessSecret) {
        throw new Error("Missing required Twitter credentials");
      }

      this.client = new TwitterApi({
        appKey: this.config.apiKey,
        appSecret: this.config.apiSecret,
        accessToken: this.config.accessToken,
        accessSecret: this.config.accessSecret,
      });

      // Only test connection with API call if needed (for streaming)
      // For autonomous-only mode, skip API call to avoid rate limits
      if (validateWithAPI) {
        const me = await this.client.v2.me();

        logger.info(`✅ Connected as @${me.data.username}`);

        // Cache user info with timestamp
        this.userInfoCache = {
          data: {
            id: me.data.id,
            username: me.data.username,
          },
          timestamp: Date.now(),
        };

        // Track this API call
        this.rateLimitManager.trackAPIUsage("me");
      } else {
        logger.info(
          "✅ Twitter client initialized (skipping API validation for autonomous-only mode)",
        );
      }

      this.isConnected = true;

      // Initialize command handler
      this.commandHandler = new TwitterCommandHandler(
        this.agentService,
        this.config,
        this.tweet.bind(this),
        this.replyToTweet.bind(this),
        this.createApprovalNotification.bind(this),
      );

      // Initialize content generator config
      if (this.config.twitter) {
        this.contentGenerator.setConfig(this.config.twitter as unknown as Parameters<typeof this.contentGenerator.setConfig>[0]);
      }

      // Start autonomous posting if enabled
      this.startAutonomousPosting();
    } catch (error) {
      const errObj = error as Record<string, unknown>;
      const errMessage = error instanceof Error ? error.message : String(error);
      const errCode = errObj?.code || errObj?.statusCode;
      logger.error("❌ Connection failed:", {
        message: errMessage,
        code: errCode,
      });

      // Enhanced error messages
      let message = errMessage || "Failed to connect to Twitter";
      if (errCode === 401) {
        message = "Authentication failed - check your API credentials";
      } else if (errCode === 403) {
        message = "Access forbidden - check app permissions";
      } else if (errCode === 429) {
        message = "Rate limit exceeded - wait before retrying";
      }

      const enhancedError = new Error(message) as Error & { code?: unknown };
      enhancedError.code = errCode;
      throw enhancedError;
    }
  }

  private async startStreaming(): Promise<void> {
    if (!this.client || this.isStreaming) return;

    try {
      // Get our user ID for filtering mentions - use cache to avoid API calls
      const userInfo = await this.getCachedUserInfo();
      if (!userInfo) {
        throw new Error("Failed to get user information");
      }
      const myUserId = userInfo.id;
      const myUsername = userInfo.username;

      this.logStorage.addLog("info", "Starting optimized Twitter polling", {
        platform: "twitter",
        userId: myUserId,
        username: myUsername,
      });

      this.isStreaming = true;

      // Initialize polling manager and start polling
      this.pollingManager = new PollingManager(
        this.client,
        this.rateLimitManager,
        this.logStorage,
      );

      await this.pollingManager.startPolling(
        myUserId,
        myUsername,
        this.handleMention.bind(this),
      );
    } catch (error) {
      this.logStorage.addLog("error", "Failed to start Twitter polling", {
        error,
        platform: "twitter",
      });
      throw error;
    }
  }

  private async handleTweet(tweetData: { data?: TwitterMessage; includes?: { users?: TwitterUser[] } }): Promise<void> {
    try {
      const tweet = tweetData.data;
      const author = tweetData.includes?.users?.[0];

      if (!tweet || !author) {
        this.logStorage.addLog("debug", "Incomplete tweet data received", {
          platform: "twitter",
        });
        return;
      }

      // Get our user info to avoid responding to ourselves - use cache
      const userInfo = await this.getCachedUserInfo();
      if (userInfo && author.id === userInfo.id) {
        this.logStorage.addLog("debug", "Ignoring own tweet", {
          platform: "twitter",
        });
        return;
      }

      this.logStorage.addLog("info", "Twitter mention received", {
        author: author.username,
        tweetId: tweet.id,
        content:
          tweet.text.substring(0, 50) + (tweet.text.length > 50 ? "..." : ""),
        platform: "twitter",
      });

      await this.handleMention(tweet, author);
    } catch (error) {
      this.logStorage.addLog("error", "Error handling tweet", {
        error,
        platform: "twitter",
      });
    }
  }

  private async handleMention(
    tweet: TwitterMessage,
    author: TwitterUser,
  ): Promise<void> {
    try {
      this.logStorage.addLog("info", "Processing Twitter mention", {
        author: author.username,
        tweetId: tweet.id,
        platform: "twitter",
      });

      // Clean the tweet text (remove mentions of our bot) - use cache
      const userInfo = await this.getCachedUserInfo();
      const cleanText = tweet.text
        .replace(new RegExp(`@${userInfo?.username}\\s*`, "gi"), "")
        .trim();

      if (!cleanText) {
        // If no content after removing mention, send a greeting
        await this.replyToTweet(tweet.id, "Hello! How can I help you today?");
        return;
      }

      // Check for Twitter-specific commands using command handler
      if (this.commandHandler) {
        const commandResult = await this.commandHandler.handleCommand(
          cleanText,
          author,
          tweet.id,
        );
        if (commandResult.handled) {
          return; // Command was handled, no need to process as regular message
        }
      }

      // Get agent response
      const agentId = AGENT_DEFAULTS.ID;
      const response = await this.agentService.processMessage(
        agentId,
        cleanText,
        {
          platform: "twitter",
          userId: author.id,
          username: author.username,
          channelId: tweet.conversation_id || tweet.id,
        },
      );

      if (response.text) {
        // Clean the response text
        let replyText = this.cleanContent(response.text);

        // Twitter has a 280 character limit
        if (replyText.length > 280) {
          replyText = replyText.substring(0, 277) + "...";
        }

        // Check if approval is required for replies
        const requireApproval =
          this.config.advanced?.replySettings
            ?.requireApprovalForReplies || false;

        await this.replyWithApproval(
          tweet.id,
          replyText,
          requireApproval,
          tweet.text, // original tweet
          author.username, // target user
        );
      }
    } catch (error) {
      this.logStorage.addLog("error", "Error processing Twitter mention", {
        error,
        platform: "twitter",
      });

      try {
        await this.replyToTweet(
          tweet.id,
          "Sorry, I encountered an error processing your message. Please try again!",
        );
      } catch (replyError) {
        this.logStorage.addLog("error", "Failed to send error reply", {
          error: replyError,
          platform: "twitter",
        });
      }
    }
  }

  private async replyToTweet(tweetId: string, text: string): Promise<boolean> {
    try {
      if (!this.client || !this.isConnected) {
        logger.error("❌ Reply failed - no client or not connected");
        return false;
      }

      logger.info("📡 Posting Twitter reply", {
        originalTweetId: tweetId,
        textLength: text.length,
        textPreview: text.substring(0, 50) + (text.length > 50 ? "..." : ""),
      });

      const result = await this.client.v2.reply(text, tweetId);

      logger.info("✅ Reply sent successfully", {
        replyId: result.data.id,
        originalTweetId: tweetId,
      });

      return true;
    } catch (error) {
      logger.error("❌ Reply failed:", {
        error: error instanceof Error ? error.message : String(error),
        originalTweetId: tweetId,
        textPreview: text.substring(0, 50) + "...",
      });
      return false;
    }
  }

  /**
   * Post a tweet using the centralized XService
   * This method delegates to XService which handles rate limiting and error handling
   * @deprecated Use XService.tweet() directly for new code
   */
  public async tweet(
    text: string,
    options?: { mediaUrls?: string[] },
  ): Promise<boolean> {
    logger.info("[TwitterBotService] Delegating tweet to XService", {
      textLength: text.length,
      textPreview: text.substring(0, 50) + "...",
      hasMedia: !!(options?.mediaUrls && options.mediaUrls.length > 0),
      mediaCount: options?.mediaUrls?.length || 0,
    });

    const xService = XService.getInstance();
    const result = await xService.tweet(text, options);

    if (result.success) {
      this.logStorage.addLog("info", "✅ Tweet sent successfully", {
        tweetId: result.tweetId,
        text: text,
        platform: "twitter",
        textLength: text.length,
        success: true,
      });
      return true;
    } else {
      this.logStorage.addLog("error", "❌ Tweet failed", {
        error: result.error,
        platform: "twitter",
        textPreview: text.substring(0, 50) + "...",
        textLength: text.length,
      });
      return false;
    }
  }

  public isRunning(): boolean {
    return this.isConnected && this.isStreaming;
  }

  public getStatus(): {
    connected: boolean;
    streaming: boolean;
    username?: string;
    autonomousPosting?: {
      enabled: boolean;
      postsToday: number;
      nextPostTime?: number;
      frequency?: string;
    };
    rateLimitStatus?: {
      mentions: { count: number; resetTime: number };
      search: { count: number; resetTime: number };
      tweet: { count: number; resetTime: number };
    };
    lastActivity?: {
      lastTweet?: string;
      lastError?: string;
      lastPollTime?: number;
    };
  } {
    const autonomousEnabled =
      this.config.enableAutonomousPosting || false;

    // Calculate next post time if autonomous posting is enabled
    let nextPostTime: number | undefined;
    if (autonomousEnabled && this.autonomousPostingInterval) {
      const intervalMinutes = this.config.postingIntervalMinutes || 60;
      nextPostTime = Date.now() + intervalMinutes * 60 * 1000;
    }

    // Get rate limit status from RateLimitManager and convert to expected format
    const convertRateLimitStatus = (endpoint: string) => {
      const status = this.rateLimitManager.getRateLimitStatus(endpoint);
      if (!status) return { count: 0, resetTime: 0 };
      return {
        count: status.count,
        resetTime: Date.now() + status.resetIn * 1000, // Convert resetIn (seconds) to timestamp
      };
    };

    const rateLimitStatus = {
      mentions: convertRateLimitStatus("mentions_timeline"),
      search: convertRateLimitStatus("search"),
      tweet: convertRateLimitStatus("tweet"),
    };

    // Get polling status if available
    const pollingStatus = this.pollingManager?.getStatus();

    return {
      connected: this.isConnected,
      streaming: this.isStreaming,
      username: this.userInfoCache?.data?.username || this.config.username,
      autonomousPosting: autonomousEnabled
        ? {
            enabled: true,
            postsToday: 0, // NOTE: Could be tracked in future if needed
            nextPostTime,
          }
        : undefined,
      rateLimitStatus,
      lastActivity: {
        lastPollTime: pollingStatus?.lastPollTime
          ? new Date(pollingStatus.lastPollTime).getTime()
          : undefined,
      },
    };
  }

  public async tweetWithApproval(
    text: string,
    requireApproval: boolean = false,
    llmMetadata?: {
      template?: string;
      prompt: string;
      rawResponse: string;
      cleanedResponse: string;
      timestamp: string;
    },
    mediaUrls?: string[],
  ): Promise<boolean> {
    try {
      if (requireApproval) {
        // Create notification for approval with LLM metadata and media
        await this.createApprovalNotification(text, {
          type: "tweet_approval",
          platform: "twitter",
          reason: "Autonomous tweet requires approval",
          llmMetadata,
          mediaUrls,
        });

        logger.info("🔔 Tweet queued for approval", {
          template: llmMetadata?.template,
          textPreview: text.substring(0, 50),
          hasMedia: !!(mediaUrls && mediaUrls.length > 0),
          mediaCount: mediaUrls?.length || 0,
        });
        this.logStorage.addLog("info", "🔔 Tweet queued for approval", {
          platform: "twitter",
          text: text.substring(0, 50),
          template: llmMetadata?.template,
          hasMedia: !!(mediaUrls && mediaUrls.length > 0),
        });

        return true; // Successfully queued
      } else {
        // Send immediately with media
        return await this.tweet(text, { mediaUrls });
      }
    } catch (error) {
      logger.error("Failed to queue tweet for approval:", error);
      return false;
    }
  }

  private async replyWithApproval(
    tweetId: string,
    text: string,
    requireApproval: boolean = false,
    originalTweet?: string,
    targetUser?: string,
  ): Promise<boolean> {
    try {
      if (requireApproval) {
        // Create notification for approval
        await this.createApprovalNotification(text, {
          type: "reply_approval",
          platform: "twitter",
          reason: "Reply requires approval",
          originalTweet,
          targetUser,
          originalTweetId: tweetId,
        });

        logger.info("🔔 Reply queued for approval");
        this.logStorage.addLog("info", "🔔 Reply queued for approval", {
          platform: "twitter",
          replyToTweetId: tweetId,
          text: text.substring(0, 50),
        });

        return true; // Successfully queued
      } else {
        // Send immediately
        return await this.replyToTweet(tweetId, text);
      }
    } catch (error) {
      logger.error("Failed to queue reply for approval:", error);
      return false;
    }
  }

  private startAutonomousPosting(): void {
    try {
      const enableAutonomousPosting =
        this.config.enableAutonomousPosting ?? false;

      logger.info("🤖 Checking autonomous posting:", {
        enabled: enableAutonomousPosting,
        intervalMinutes: this.config.postingIntervalMinutes,
        maxPostsPerDay: this.config.maxPostsPerDay,
        postingHours: this.config.postingHours,
      });

      if (!enableAutonomousPosting) {
        logger.info("❌ Autonomous posting disabled");
        return;
      }

      const intervalMinutes = Math.max(
        this.config.postingIntervalMinutes || 60,
        15,
      ); // Minimum 15 minutes

      logger.info(
        `🤖 Starting autonomous posting (${intervalMinutes} min intervals)`,
      );

      // Start the interval
      this.autonomousPostingInterval = setInterval(
        async () => {
          try {
            await this.generateAndPostTweet();
          } catch (error) {
            logger.error(
              "❌ FATAL: Autonomous tweet generation failed in interval:",
              {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                errorType: error instanceof Error ? error.constructor.name : typeof error,
              },
            );
          }
        },
        intervalMinutes * 60 * 1000,
      );
      this.autonomousPostingInterval.unref?.();

      // Generate first tweet immediately (5 second delay for startup)
      const initialDelay = 5 * 1000; // 5 seconds - immediate for testing

      logger.info(
        "⏰ First autonomous tweet will be generated in 5 seconds...",
      );

      const initialTimeout = setTimeout(async () => {
        try {
          logger.info("🚀 Triggering first autonomous tweet generation NOW!");
          await this.generateAndPostTweet();
        } catch (error) {
          logger.error("❌ FATAL: First autonomous tweet generation failed:", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
          });
        }
      }, initialDelay);
      initialTimeout.unref?.();
    } catch (error) {
      logger.error("❌ Failed to start autonomous posting:", error);
    }
  }

  private stopAutonomousPosting(): void {
    if (this.autonomousPostingInterval) {
      clearInterval(this.autonomousPostingInterval);
      this.autonomousPostingInterval = null;
      logger.info("🛑 Stopped autonomous posting");
    }
  }

  private async generateAndPostTweet(): Promise<void> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      logger.info("🎯 ============================================");
      logger.info("🎯 AUTONOMOUS TWEET GENERATION STARTED", {
        timestamp,
        connected: this.isConnected,
      });
      logger.info("🎯 ============================================");

      if (!this.isConnected) {
        logger.warn("⚠️ SKIPPED: Bot not connected", {
          timestamp,
          reason: "not_connected",
        });
        return;
      }

      const enableAutonomousPosting =
        this.config.enableAutonomousPosting ?? false;

      if (!enableAutonomousPosting) {
        logger.warn("❌ SKIPPED: Autonomous posting disabled", {
          timestamp,
          reason: "disabled_in_config",
        });
        this.stopAutonomousPosting();
        return;
      }

      // Check posting hours if configured
      const postingHours = this.config.postingHours || "0-23";
      const [start, end] = postingHours.split("-").map(Number);
      if (start !== undefined && end !== undefined) {
        const currentHour = new Date().getHours();

        if (currentHour < start || currentHour > end) {
          logger.info("⏰ SKIPPED: Outside posting hours", {
            timestamp,
            reason: "outside_posting_hours",
            allowedHours: `${start}-${end}`,
            currentHour,
          });
          return;
        }

        logger.info("✅ Within posting hours", {
          allowedHours: `${start}-${end}`,
          currentHour,
        });
      }

      // Check rate limits using RateLimitManager
      if (this.rateLimitManager.shouldRateLimit("tweet", 250)) {
        const status = this.rateLimitManager.getRateLimitStatus("tweet");
        logger.warn("⚠️ SKIPPED: Rate limited", {
          timestamp,
          reason: "rate_limited",
          resetIn: status?.resetIn ? `${status.resetIn}s` : "unknown",
          callsUsed: status?.count || 0,
        });
        return;
      }

      logger.info("✅ Rate limit check passed");

      // Generate content using ContentGenerator with templates
      logger.info("📝 STEP 1: Generating content with AI using templates");
      logger.info("════════════════════════════════════════════════");

      const aiStartTime = Date.now();
      let result;
      try {
        result = await this.contentGenerator.generateTweetContent();

        logger.info("📨 AI GENERATION DETAILS:");
        logger.info("  Template Type:", result.metadata.template);
        logger.info("  Prompt Length:", result.metadata.prompt.length);
        logger.info("════════════════════════════════════════════════");
      } catch (error) {
        const aiDuration = Date.now() - aiStartTime;
        logger.error("❌ AI REQUEST FAILED:");
        logger.error("════════════════════════════════════════════════");
        logger.error("  Error:", error instanceof Error ? error.message : String(error));
        logger.error("  Error Type:", error instanceof Error ? error.constructor.name : typeof error);
        logger.error("  Duration:", `${aiDuration}ms`);
        logger.error("  Stack:", error instanceof Error ? error.stack : undefined);
        logger.error("════════════════════════════════════════════════");
        throw error;
      }
      const aiDuration = Date.now() - aiStartTime;

      logger.info("🤖 STEP 2: AI response received");
      logger.info("════════════════════════════════════════════════");
      logger.info("📬 AI RESPONSE DETAILS:");
      logger.info("  Success:", !!result.text);
      logger.info("  Response Time:", `${aiDuration}ms`);
      logger.info("  Response Length:", result.text?.length || 0);
      logger.info("  Template:", result.metadata.template);
      logger.info("  Raw Response Length:", result.metadata.rawResponse.length);
      logger.info("════════════════════════════════════════════════");

      if (result.text) {
        let tweetText = result.text;

        logger.info("🧹 STEP 3: Content cleaned", {
          originalLength: result.metadata.rawResponse.length,
          cleanedLength: tweetText.length,
          wasTruncated: false,
        });

        // Twitter has a 280 character limit
        if (tweetText.length > 280) {
          const originalLength = tweetText.length;
          tweetText = tweetText.substring(0, 277) + "...";
          logger.warn("✂️ Content truncated to fit Twitter limit", {
            originalLength,
            truncatedLength: tweetText.length,
            limit: 280,
          });
        }

        // Check if approval is required (configurable via TWITTER_REQUIRE_APPROVAL env var)
        const requireApproval =
          this.config.requireApprovalForAutonomous ?? true;

        logger.info("📝 STEP 4: Tweet draft ready", {
          length: tweetText.length,
          requireApproval,
          willAutoPost: !requireApproval,
          template: result.metadata.template,
          preview: tweetText.substring(0, 80) + "...",
        });

        // Generate image for thirst trap tweets
        let mediaUrls: string[] | undefined;
        if (result.metadata.template === "thirst_trap") {
          try {
            logger.info("🖼️ Generating thirst trap image with ComfyUI");
            const image = await this.contentGenerator.generateThirstTrapImage();
            if (image) {
              // Use saved URL if available, otherwise use direct URL
              mediaUrls = [image.savedUrl || image.url];
              logger.info("✅ Thirst trap image generated", {
                url: mediaUrls[0].substring(0, 100),
                saved: !!image.savedUrl,
              });
            } else {
              logger.warn(
                "⚠️ Failed to generate thirst trap image, posting without media",
              );
            }
          } catch (imageError) {
            logger.error("❌ Image generation error", {
              error: imageError instanceof Error ? imageError.message : String(imageError),
            });
            // Continue without image
          }
        }

        const approvalStartTime = Date.now();
        await this.tweetWithApproval(
          tweetText,
          requireApproval,
          result.metadata,
          mediaUrls,
        );
        const approvalDuration = Date.now() - approvalStartTime;

        const totalDuration = Date.now() - startTime;
        logger.info("✅ STEP 5: Notification created successfully", {
          approvalTime: `${approvalDuration}ms`,
          totalTime: `${totalDuration}ms`,
        });

        logger.info("🎯 ============================================");
        logger.info("🎯 AUTONOMOUS TWEET GENERATION COMPLETED", {
          timestamp: new Date().toISOString(),
          totalDuration: `${totalDuration}ms`,
          status: "success",
          nextAction: "awaiting_user_approval",
        });
        logger.info("🎯 ============================================");
      } else {
        const totalDuration = Date.now() - startTime;
        logger.warn("⚠️ FAILED: No content generated by AI", {
          timestamp,
          totalDuration: `${totalDuration}ms`,
          reason: "empty_ai_response",
        });

        logger.info("🎯 ============================================");
        logger.info("🎯 AUTONOMOUS TWEET GENERATION FAILED", {
          timestamp: new Date().toISOString(),
          totalDuration: `${totalDuration}ms`,
          status: "failed",
          reason: "no_content_generated",
        });
        logger.info("🎯 ============================================");
      }
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("❌ AUTONOMOUS TWEET GENERATION ERROR", {
        timestamp,
        totalDuration: `${totalDuration}ms`,
        error: errMsg,
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });

      logger.info("🎯 ============================================");
      logger.info("🎯 AUTONOMOUS TWEET GENERATION FAILED", {
        timestamp: new Date().toISOString(),
        totalDuration: `${totalDuration}ms`,
        status: "error",
        error: errMsg,
      });
      logger.info("🎯 ============================================");
    }
  }

  private async getCachedUserInfo(): Promise<{
    id: string;
    username: string;
  } | null> {
    // Check if cache is valid
    if (
      this.userInfoCache &&
      Date.now() - this.userInfoCache.timestamp < this.USER_CACHE_TTL
    ) {
      return this.userInfoCache.data;
    }

    // Cache expired or doesn't exist, fetch new info
    if (this.client && this.isConnected) {
      try {
        const me = await this.client.v2.me();
        this.userInfoCache = {
          data: {
            id: me.data.id,
            username: me.data.username,
          },
          timestamp: Date.now(),
        };

        // Track this API call
        this.rateLimitManager.trackAPIUsage("me");

        return this.userInfoCache.data;
      } catch (error) {
        logger.error("Failed to fetch user info:", error);
        // Return stale cache if available
        return this.userInfoCache?.data || null;
      }
    }

    return this.userInfoCache?.data || null;
  }

  private cleanContent(text: string): string {
    // Remove thinking tags and their content
    let cleanedText = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

    // Remove any remaining XML-like tags
    cleanedText = cleanedText.replace(/<[^>]+>/g, "");

    // Clean up whitespace
    cleanedText = cleanedText.trim().replace(/\s+/g, " ");

    // Remove any leading/trailing quotes that might be artifacts
    cleanedText = cleanedText.replace(/^["']|["']$/g, "");

    return cleanedText.trim();
  }

  private async createApprovalNotification(
    content: string,
    metadata: {
      type: "tweet_approval" | "reply_approval";
      platform: "twitter";
      reason: string;
      originalTweetId?: string;
      targetUser?: string;
      originalTweet?: string;
      mediaUrls?: string[];
      llmMetadata?: {
        template?: string;
        prompt: string;
        rawResponse: string;
        cleanedResponse: string;
        timestamp: string;
      };
    },
  ): Promise<void> {
    try {
      const { llmMetadata, ...notificationMetadata } = metadata;
      const notification: PendingNotification = {
        id: createRuntimeId("twitter"),
        type: metadata.type,
        platform: "twitter",
        timestamp: new Date().toISOString(),
        status: "pending",
        content: {
          text: content,
          reason: metadata.reason,
          originalTweet: metadata.originalTweet || metadata.originalTweetId,
          targetUser: metadata.targetUser,
          mediaUrls: metadata.mediaUrls,
        },
        metadata: {
          ...notificationMetadata,
          llmGeneration: llmMetadata
            ? summarizeLlmGeneration(llmMetadata)
            : undefined,
        },
      };

      const existingNotifications = ((await kvService.get("notifications")) as {
        notifications: PendingNotification[];
      }) || {
        notifications: [],
      };
      existingNotifications.notifications = existingNotifications.notifications.map(
        sanitizePendingNotification,
      );

      // Add new notification
      existingNotifications.notifications.unshift(notification);

      // Keep only last 100 notifications
      if (existingNotifications.notifications.length > 100) {
        existingNotifications.notifications =
          existingNotifications.notifications.slice(0, 100);
      }

      // Save back to KV using unified kvService
      await kvService.set("notifications", existingNotifications);

      logger.info("📋 Created notification for approval:", {
        type: metadata.type,
        id: notification.id,
        contentLength: content.length,
      });

      this.logStorage.addLog("info", "📋 Created approval notification", {
        platform: "twitter",
        type: metadata.type,
        notificationId: notification.id,
      });
    } catch (error) {
      logger.error("Failed to create notification:", error);
      this.logStorage.addLog("error", "Failed to create notification", {
        platform: "twitter",
        error,
      });
    }
  }
}
