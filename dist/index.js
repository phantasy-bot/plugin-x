// src/x-plugin.ts
import {
  BasePlugin
} from "@phantasy/agent/plugins";
import {
  createPluginModuleLogger as createPluginModuleLogger2
} from "@phantasy/agent/plugin-runtime";

// src/x-service.ts
import { TwitterApi } from "twitter-api-v2";
import {
  createPluginModuleLogger,
  createRuntimeId,
  fetchWithTimeout,
  kvService,
  PlatformConfigService
} from "@phantasy/agent/plugin-runtime";
var logger = createPluginModuleLogger("XService");
var XService = class _XService {
  client = null;
  config = null;
  // User info cache (to avoid repeated API calls for dashboard widget)
  userInfoCache = null;
  USER_INFO_CACHE_TTL = 5 * 60 * 1e3;
  // 5 minutes
  // Rate limit tracking
  lastRateLimitError = null;
  RATE_LIMIT_COOLDOWN = 15 * 60 * 1e3;
  // 15 minutes cooldown after rate limit
  requestCount = 0;
  requestWindowStart = Date.now();
  REQUEST_WINDOW = 15 * 60 * 1e3;
  // 15 minute window
  MAX_REQUESTS_PER_WINDOW = 10;
  // Conservative limit for Free tier
  // Singleton instance
  static instance = null;
  /**
   * Get the singleton instance of XService
   * @returns The XService singleton instance
   */
  static getInstance() {
    if (!_XService.instance) {
      _XService.instance = new _XService();
    }
    return _XService.instance;
  }
  /**
   * Private constructor to enforce singleton pattern
   */
  constructor() {
  }
  summarizeMediaUrl(mediaUrl) {
    try {
      return new URL(mediaUrl).origin;
    } catch {
      return "[unparseable-url]";
    }
  }
  /**
   * Check if X/Twitter credentials are configured
   * This method does NOT make any API calls - it only checks configuration
   * @public
   * @returns True if credentials exist in platform config, false otherwise
   */
  async hasCredentials() {
    try {
      const platformConfig = await PlatformConfigService.getInstance().get("twitter");
      if (!platformConfig) {
        return false;
      }
      return !!(platformConfig.apiKey && platformConfig.apiSecret && platformConfig.accessToken && platformConfig.accessSecret);
    } catch (error) {
      logger.debug("[XService] Error checking credentials:", error);
      return false;
    }
  }
  /**
   * Get cached user info (avoids repeated API calls for dashboard widget)
   * @public
   * @returns Cached user info if available and fresh, null otherwise
   */
  getCachedUserInfo() {
    if (!this.userInfoCache) {
      return null;
    }
    const now = Date.now();
    if (now - this.userInfoCache.timestamp > this.USER_INFO_CACHE_TTL) {
      this.userInfoCache = null;
      return null;
    }
    return this.userInfoCache.data;
  }
  /**
   * Get the Twitter API client (initializes if needed)
   * @public
   * @returns TwitterApi client or null if credentials not available
   */
  async getClient() {
    if (this.client) {
      return this.client;
    }
    const loaded = await this.loadCredentials();
    if (!loaded || !this.config) {
      return null;
    }
    this.client = new TwitterApi({
      appKey: this.config.apiKey,
      appSecret: this.config.apiSecret,
      accessToken: this.config.accessToken,
      accessSecret: this.config.accessSecret
    });
    return this.client;
  }
  /**
   * Load credentials from platform config service
   * @private
   * @returns True if credentials were loaded successfully, false otherwise
   */
  async loadCredentials() {
    try {
      const platformConfig = await PlatformConfigService.getInstance().get("twitter");
      if (!platformConfig) {
        logger.warn(
          "[XService] X/Twitter platform not configured. Configure credentials in Platforms > Twitter."
        );
        return false;
      }
      if (!platformConfig.apiKey || !platformConfig.apiSecret || !platformConfig.accessToken || !platformConfig.accessSecret) {
        logger.warn(
          "[XService] Missing X/Twitter credentials. Add API credentials in Platforms > Twitter."
        );
        return false;
      }
      this.config = {
        apiKey: platformConfig.apiKey,
        apiSecret: platformConfig.apiSecret,
        accessToken: platformConfig.accessToken,
        accessSecret: platformConfig.accessSecret
      };
      logger.info(
        "[XService] \u2705 Credentials loaded successfully (Platform enabled: " + (platformConfig.enabled ? "yes" : "no") + ")"
      );
      return true;
    } catch (error) {
      logger.error("[XService] Failed to load credentials:", error);
      return false;
    }
  }
  /**
   * Initialize Twitter API client only when needed (lazy initialization pattern)
   * Prevents rate limiting by avoiding unnecessary API calls on startup
   * @private
   * @returns True if client is ready, false if initialization failed
   */
  async ensureClient() {
    if (this.client) {
      return true;
    }
    const hasCredentials = await this.loadCredentials();
    if (!hasCredentials || !this.config) {
      return false;
    }
    try {
      this.client = new TwitterApi({
        appKey: this.config.apiKey,
        appSecret: this.config.apiSecret,
        accessToken: this.config.accessToken,
        accessSecret: this.config.accessSecret
      });
      logger.info("[XService] \u2705 Client initialized");
      return true;
    } catch (error) {
      logger.error("[XService] Failed to initialize client:", error);
      return false;
    }
  }
  /**
   * Get current rate limit status for display in UI
   * @public
   * @returns Rate limit status information
   */
  getRateLimitStatus() {
    const now = Date.now();
    if (this.lastRateLimitError) {
      const timeSinceError = now - this.lastRateLimitError;
      if (timeSinceError < this.RATE_LIMIT_COOLDOWN) {
        const minutesRemaining = Math.ceil(
          (this.RATE_LIMIT_COOLDOWN - timeSinceError) / 6e4
        );
        const resetAt = new Date(
          this.lastRateLimitError + this.RATE_LIMIT_COOLDOWN
        ).toLocaleTimeString();
        return {
          isLimited: true,
          reason: "Twitter rate limit (429 error)",
          resetAt,
          minutesRemaining
        };
      }
    }
    if (now - this.requestWindowStart <= this.REQUEST_WINDOW) {
      if (this.requestCount >= this.MAX_REQUESTS_PER_WINDOW) {
        const minutesUntilReset = Math.ceil(
          (this.REQUEST_WINDOW - (now - this.requestWindowStart)) / 6e4
        );
        const resetAt = new Date(
          this.requestWindowStart + this.REQUEST_WINDOW
        ).toLocaleTimeString();
        return {
          isLimited: true,
          reason: "Request budget exhausted",
          resetAt,
          minutesRemaining: minutesUntilReset,
          requestCount: this.requestCount,
          requestLimit: this.MAX_REQUESTS_PER_WINDOW
        };
      }
    }
    return {
      isLimited: false,
      requestCount: this.requestCount,
      requestLimit: this.MAX_REQUESTS_PER_WINDOW
    };
  }
  /**
   * Check if we're currently rate limited
   * @private
   * @returns True if rate limited, false otherwise
   */
  isRateLimited() {
    if (this.lastRateLimitError) {
      const timeSinceError = Date.now() - this.lastRateLimitError;
      if (timeSinceError < this.RATE_LIMIT_COOLDOWN) {
        const minutesRemaining = Math.ceil(
          (this.RATE_LIMIT_COOLDOWN - timeSinceError) / 6e4
        );
        logger.warn(
          `[XService] Still in rate limit cooldown. Wait ${minutesRemaining} more minutes.`
        );
        return true;
      } else {
        this.lastRateLimitError = null;
      }
    }
    const now = Date.now();
    if (now - this.requestWindowStart > this.REQUEST_WINDOW) {
      this.requestCount = 0;
      this.requestWindowStart = now;
    }
    if (this.requestCount >= this.MAX_REQUESTS_PER_WINDOW) {
      const minutesUntilReset = Math.ceil(
        (this.REQUEST_WINDOW - (now - this.requestWindowStart)) / 6e4
      );
      logger.warn(
        `[XService] Request budget exhausted (${this.requestCount}/${this.MAX_REQUESTS_PER_WINDOW}). Reset in ${minutesUntilReset} minutes.`
      );
      return true;
    }
    return false;
  }
  /**
   * Track a request for rate limiting purposes
   * @private
   */
  trackRequest() {
    this.requestCount++;
    logger.debug(
      `[XService] Request tracked: ${this.requestCount}/${this.MAX_REQUESTS_PER_WINDOW}`
    );
  }
  /**
   * Record a rate limit error
   * @private
   */
  recordRateLimitError() {
    this.lastRateLimitError = Date.now();
    logger.warn(
      `[XService] Rate limit hit. Entering ${this.RATE_LIMIT_COOLDOWN / 6e4} minute cooldown.`
    );
  }
  /**
   * Post a tweet immediately to X (Twitter)
   *
   * @param text - Tweet content (max 280 characters)
   * @returns Promise with result object containing:
   *   - success: Whether the tweet was posted
   *   - tweetId: ID of the posted tweet (if successful)
   *   - error: Error message (if failed)
   *
   * @example
   * ```typescript
   * const result = await xService.tweet("Hello World!");
   * if (result.success) {
   *   logger.info(`Tweet posted with ID: ${result.tweetId}`);
   * } else {
   *   logger.error(`Failed: ${result.error}`);
   * }
   * ```
   */
  async tweet(text, options) {
    try {
      if (this.isRateLimited()) {
        return {
          success: false,
          error: "Rate limit protection: Please wait before posting. The system will automatically retry when the limit resets."
        };
      }
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Tweet text cannot be empty"
        };
      }
      if (text.length > 280) {
        return {
          success: false,
          error: `Tweet is too long (${text.length} characters). Maximum is 280 characters.`
        };
      }
      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "X/Twitter service not configured. Please add your API credentials in Settings."
        };
      }
      const mediaIds = [];
      if (options?.mediaUrls && options.mediaUrls.length > 0) {
        for (const mediaUrl of options.mediaUrls) {
          try {
            logger.info("[XService] Uploading media from URL", {
              mediaOrigin: this.summarizeMediaUrl(mediaUrl)
            });
            const mediaResponse = await fetchWithTimeout(mediaUrl, {
              timeout: 3e4
            });
            if (!mediaResponse.ok) {
              logger.error("[XService] Failed to fetch media", {
                mediaOrigin: this.summarizeMediaUrl(mediaUrl),
                status: mediaResponse.status
              });
              continue;
            }
            const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());
            const mediaId = await this.client.v1.uploadMedia(mediaBuffer, {
              mimeType: mediaResponse.headers.get("content-type") || "image/png"
            });
            mediaIds.push(mediaId);
            logger.info("[XService] Media uploaded successfully", {
              mediaId
            });
          } catch (uploadError) {
            logger.error("[XService] Failed to upload media", {
              error: uploadError instanceof Error ? uploadError.message : String(uploadError),
              mediaOrigin: this.summarizeMediaUrl(mediaUrl)
            });
          }
        }
      }
      const tweetPayload = { text };
      if (mediaIds.length > 0) {
        tweetPayload.media = { media_ids: mediaIds };
      }
      const result = await this.client.v2.tweet(tweetPayload);
      this.trackRequest();
      logger.info("[XService] \u2705 Tweet posted successfully", {
        tweetId: result.data.id,
        length: text.length
      });
      return {
        success: true,
        tweetId: result.data.id
      };
    } catch (error) {
      logger.error("[XService] Failed to post tweet:", error);
      const twitterError = error;
      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        this.recordRateLimitError();
        return {
          success: false,
          error: "Rate limit exceeded. Please wait 15 minutes before posting again. The system will track this and prevent further attempts during the cooldown period."
        };
      }
      if (twitterError?.code === 401 || twitterError?.statusCode === 401) {
        return {
          success: false,
          error: "Authentication failed. Please check your X API credentials."
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to post tweet"
      };
    }
  }
  async fetchTweetMetrics(tweetIds) {
    const ids = Array.from(
      new Set(tweetIds.map((id) => id.trim()).filter(Boolean))
    ).slice(0, 100);
    if (ids.length === 0) {
      return [];
    }
    const clientReady = await this.ensureClient();
    if (!clientReady || !this.client) {
      return [];
    }
    const response = await this.client.v2.tweets(ids, {
      "tweet.fields": ["public_metrics"]
    });
    const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
    return (response.data || []).map((tweet) => ({
      tweetId: tweet.id,
      capturedAt,
      metrics: {
        impressions: typeof tweet.public_metrics?.impression_count === "number" ? tweet.public_metrics.impression_count : void 0,
        likes: tweet.public_metrics?.like_count,
        replies: tweet.public_metrics?.reply_count,
        shares: typeof tweet.public_metrics?.retweet_count === "number" || typeof tweet.public_metrics?.quote_count === "number" ? (tweet.public_metrics?.retweet_count || 0) + (tweet.public_metrics?.quote_count || 0) : void 0
      }
    }));
  }
  /**
   * Delete a tweet by its ID
   *
   * @param tweetId - The ID of the tweet to delete
   * @returns Promise with result object containing:
   *   - success: Whether the tweet was deleted
   *   - error: Error message (if failed)
   *
   * @example
   * ```typescript
   * const result = await xService.deleteTweet("1234567890");
   * if (result.success) {
   *   logger.info("Tweet deleted successfully");
   * }
   * ```
   */
  async deleteTweet(tweetId) {
    try {
      if (!tweetId || tweetId.trim().length === 0) {
        return {
          success: false,
          error: "Tweet ID is required"
        };
      }
      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "X/Twitter service not configured."
        };
      }
      await this.client.v2.deleteTweet(tweetId);
      logger.info("[XService] \u2705 Tweet deleted successfully", { tweetId });
      return {
        success: true
      };
    } catch (error) {
      logger.error("[XService] Failed to delete tweet:", error);
      const twitterError = error;
      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        return {
          success: false,
          error: "Rate limit exceeded. Please wait before trying again."
        };
      }
      if (twitterError?.code === 404 || twitterError?.statusCode === 404) {
        return {
          success: false,
          error: "Tweet not found. It may have already been deleted."
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete tweet"
      };
    }
  }
  /**
   * Reply to a tweet immediately
   *
   * @param tweetId - The ID of the tweet to reply to
   * @param text - Reply content (max 280 characters)
   * @returns Promise with result object containing:
   *   - success: Whether the reply was posted
   *   - replyId: ID of the posted reply (if successful)
   *   - error: Error message (if failed)
   *
   * @example
   * ```typescript
   * const result = await xService.replyToTweet("1234567890", "Great post!");
   * if (result.success) {
   *   logger.info(`Reply posted with ID: ${result.replyId}`);
   * }
   * ```
   */
  async replyToTweet(tweetId, text) {
    try {
      if (!tweetId || tweetId.trim().length === 0) {
        return {
          success: false,
          error: "Tweet ID is required"
        };
      }
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Reply text cannot be empty"
        };
      }
      if (text.length > 280) {
        return {
          success: false,
          error: `Reply is too long (${text.length} characters). Maximum is 280 characters.`
        };
      }
      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "X/Twitter service not configured."
        };
      }
      const result = await this.client.v2.reply(text, tweetId);
      logger.info("[XService] \u2705 Reply posted successfully", {
        replyId: result.data.id,
        inReplyTo: tweetId
      });
      return {
        success: true,
        replyId: result.data.id
      };
    } catch (error) {
      logger.error("[XService] Failed to post reply:", error);
      const twitterError = error;
      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        return {
          success: false,
          error: "Rate limit exceeded. Please wait before trying again."
        };
      }
      if (twitterError?.code === 404 || twitterError?.statusCode === 404) {
        return {
          success: false,
          error: "Original tweet not found."
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to post reply"
      };
    }
  }
  /**
   * Create a draft tweet for approval workflow
   *
   * This does NOT post the tweet immediately. Instead, it creates a notification
   * in KV storage that appears in the Notifications UI where users can review
   * and approve/reject the draft before posting.
   *
   * @param text - Tweet content (max 280 characters)
   * @returns Promise with result object containing:
   *   - success: Whether the draft was created
   *   - notificationId: ID of the notification (if successful)
   *   - error: Error message (if failed)
   *
   * @example
   * ```typescript
   * const result = await xService.createDraftTweet("Check out our new feature!");
   * if (result.success) {
   *   logger.info(`Draft created: ${result.notificationId}`);
   *   logger.info("User can approve/reject in Notifications tab");
   * }
   * ```
   */
  async createDraftTweet(text) {
    try {
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Tweet text cannot be empty"
        };
      }
      if (text.length > 280) {
        return {
          success: false,
          error: `Tweet is too long (${text.length} characters). Maximum is 280 characters.`
        };
      }
      const notificationId = createRuntimeId("tweet_draft");
      const notification = {
        id: notificationId,
        type: "tweet_approval",
        platform: "twitter",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        status: "pending",
        content: {
          text,
          reason: "Agent created a draft tweet for your review"
        },
        metadata: {
          source: "auto_draft",
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
      await this.storeNotification(notification);
      logger.info("[XService] \u2705 Draft tweet created", {
        notificationId,
        length: text.length
      });
      return {
        success: true,
        notificationId
      };
    } catch (error) {
      logger.error("[XService] Failed to create draft tweet:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create draft tweet"
      };
    }
  }
  /**
   * Create a draft reply for approval workflow
   *
   * This does NOT post the reply immediately. Instead, it creates a notification
   * in KV storage that appears in the Notifications UI where users can review
   * and approve/reject the draft before posting.
   *
   * @param tweetId - The ID of the tweet to reply to
   * @param text - Reply content (max 280 characters)
   * @returns Promise with result object containing:
   *   - success: Whether the draft was created
   *   - notificationId: ID of the notification (if successful)
   *   - error: Error message (if failed)
   *
   * @example
   * ```typescript
   * const result = await xService.createDraftReply("1234567890", "Great point!");
   * if (result.success) {
   *   logger.info(`Draft reply created: ${result.notificationId}`);
   * }
   * ```
   */
  async createDraftReply(tweetId, text) {
    try {
      if (!tweetId || tweetId.trim().length === 0) {
        return {
          success: false,
          error: "Tweet ID is required"
        };
      }
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Reply text cannot be empty"
        };
      }
      if (text.length > 280) {
        return {
          success: false,
          error: `Reply is too long (${text.length} characters). Maximum is 280 characters.`
        };
      }
      const notificationId = createRuntimeId("reply_draft");
      const notification = {
        id: notificationId,
        type: "reply_approval",
        platform: "twitter",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        status: "pending",
        content: {
          text,
          inReplyTo: tweetId,
          reason: "Agent created a draft reply for your review"
        },
        metadata: {
          source: "auto_draft",
          inReplyTo: tweetId,
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
      await this.storeNotification(notification);
      logger.info("[XService] \u2705 Draft reply created", {
        notificationId,
        inReplyTo: tweetId
      });
      return {
        success: true,
        notificationId
      };
    } catch (error) {
      logger.error("[XService] Failed to create draft reply:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create draft reply"
      };
    }
  }
  /**
   * Store a notification in KV storage for the approval workflow
   *
   * Notifications are stored in the 'notifications' key and kept to a maximum
   * of 100 entries to prevent unbounded growth.
   *
   * @private
   * @param notification - The notification object to store
   * @throws Error if storage fails
   */
  async storeNotification(notification) {
    try {
      const existingData = await kvService.get("notifications") || {
        notifications: []
      };
      existingData.notifications.unshift(notification);
      if (existingData.notifications.length > 100) {
        existingData.notifications = existingData.notifications.slice(0, 100);
      }
      await kvService.set("notifications", existingData);
      logger.info("[XService] \u2705 Notification stored", {
        id: notification.id,
        type: notification.type
      });
    } catch (error) {
      logger.error("[XService] Failed to store notification:", error);
      throw error;
    }
  }
  /**
   * Test the X API connection
   *
   * Only call this when the user explicitly tests credentials (e.g., in settings UI).
   * This makes an API call to verify authentication is working.
   *
   * @returns Promise with result object containing:
   *   - success: Whether the connection test succeeded
   *   - username: The authenticated user's username (if successful)
   *   - error: Error message (if failed)
   *
   * @example
   * ```typescript
   * const result = await xService.testConnection();
   * if (result.success) {
   *   logger.info(`Connected as @${result.username}`);
   * } else {
   *   logger.error(`Connection failed: ${result.error}`);
   * }
   * ```
   */
  async testConnection() {
    try {
      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "Failed to initialize X client"
        };
      }
      const me = await this.client.v2.me();
      logger.info("[XService] \u2705 Connection test successful", {
        username: me.data.username
      });
      return {
        success: true,
        username: me.data.username
      };
    } catch (error) {
      logger.error("[XService] Connection test failed:", error);
      const twitterError = error;
      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        return {
          success: false,
          error: "Rate limit exceeded. Please wait before testing again."
        };
      }
      if (twitterError?.code === 401 || twitterError?.statusCode === 401) {
        return {
          success: false,
          error: "Invalid credentials. Please check your API keys."
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection test failed"
      };
    }
  }
  /**
   * Reset the service by clearing the cached client and config
   *
   * Call this when credentials change or when you need to force
   * re-initialization of the Twitter API client.
   *
   * @example
   * ```typescript
   * // After updating credentials in settings
   * xService.reset();
   * // Next API call will re-initialize with new credentials
   * ```
   */
  reset() {
    this.client = null;
    this.config = null;
    logger.info("[XService] Service reset");
  }
};
var xService = XService.getInstance();

// src/x-plugin.ts
var log = createPluginModuleLogger2("XPlugin");
var XPlugin = class extends BasePlugin {
  name = "x-plugin";
  version = "0.1.0-beta";
  description = "Post tweets, replies, quotes, search, and manage Twitter/X presence.";
  author = "Phantasy";
  displayName = "X (Twitter)";
  homepage = "https://github.com/xdevplatform/xurl";
  repository = "https://github.com/xdevplatform/xurl";
  icon = "\u{1D54F}";
  category = "social";
  tags = ["twitter", "x", "social-media", "posting"];
  permissions = ["internet"];
  workspace = "business";
  extensionKind = "integration";
  adminSurface = {
    tabId: "x",
    label: "X",
    workspace: "business",
    kind: "generic",
    keywords: ["twitter", "x", "social", "posting"],
    aliases: ["twitter", "x"],
    dashboardIcon: "twitter"
  };
  configSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      autonomousPosting: { type: "boolean", default: false },
      postingIntervalMinutes: { type: "number", default: 60 },
      maxPostsPerDay: { type: "number", default: 8 },
      activeHours: { type: "string", default: "9-21" },
      requireApproval: { type: "boolean", default: true }
    }
  };
  lastActivity;
  async onInit(agentConfig, config) {
    await super.onInit(agentConfig, config);
  }
  getTools() {
    return [
      {
        name: "x_post_tweet",
        description: "Post a tweet immediately, or create an approval draft when approval is required.",
        access: {
          category: "remote",
          risk: "dangerous"
        },
        parameters: {
          type: "object",
          properties: {
            mediaUrls: {
              type: "array",
              items: { type: "string" },
              description: "Optional image URLs to attach to the tweet"
            },
            text: {
              type: "string",
              description: "Tweet text (max 280 characters)"
            }
          },
          required: ["text"]
        },
        handler: async (input) => {
          if (this.requiresApproval()) {
            return xService.createDraftTweet(input.text);
          }
          const result = await xService.tweet(input.text, {
            mediaUrls: input.mediaUrls
          });
          if (result.success) {
            this.lastActivity = /* @__PURE__ */ new Date();
          }
          return result;
        }
      },
      {
        name: "x_reply_to_tweet",
        description: "Reply to a tweet immediately, or create an approval draft when approval is required.",
        access: {
          category: "remote",
          risk: "dangerous"
        },
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Reply text (max 280 characters)"
            },
            tweetId: {
              type: "string",
              description: "Tweet ID to reply to"
            }
          },
          required: ["tweetId", "text"]
        },
        handler: async (input) => {
          if (this.requiresApproval()) {
            return xService.createDraftReply(input.tweetId, input.text);
          }
          const result = await xService.replyToTweet(input.tweetId, input.text);
          if (result.success) {
            this.lastActivity = /* @__PURE__ */ new Date();
          }
          return result;
        }
      },
      {
        name: "x_create_tweet_draft",
        description: "Create a draft tweet for manual approval in Notifications without posting immediately.",
        access: {
          category: "remote",
          risk: "caution"
        },
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Tweet text (max 280 characters)"
            }
          },
          required: ["text"]
        },
        handler: async (input) => xService.createDraftTweet(input.text)
      },
      {
        name: "x_create_reply_draft",
        description: "Create a draft reply for manual approval in Notifications without posting immediately.",
        access: {
          category: "remote",
          risk: "caution"
        },
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Reply text (max 280 characters)"
            },
            tweetId: {
              type: "string",
              description: "Tweet ID to reply to"
            }
          },
          required: ["tweetId", "text"]
        },
        handler: async (input) => xService.createDraftReply(input.tweetId, input.text)
      },
      {
        name: "x_delete_tweet",
        description: "Delete a previously posted tweet by ID.",
        access: {
          category: "remote",
          risk: "dangerous"
        },
        parameters: {
          type: "object",
          properties: {
            tweetId: {
              type: "string",
              description: "Tweet ID to delete"
            }
          },
          required: ["tweetId"]
        },
        handler: async (input) => xService.deleteTweet(input.tweetId)
      },
      {
        name: "x_test_connection",
        description: "Verify that the configured Twitter/X credentials are valid and can authenticate.",
        access: {
          category: "remote",
          risk: "safe"
        },
        parameters: {
          type: "object",
          properties: {}
        },
        handler: async () => xService.testConnection()
      }
    ];
  }
  async startBot() {
    const result = await xService.testConnection();
    if (!result.success) {
      return {
        success: false,
        message: result.error || "Failed to connect to X"
      };
    }
    this.lastActivity = /* @__PURE__ */ new Date();
    return {
      success: true,
      message: result.username ? `Connected to X as @${result.username}` : "Connected to X"
    };
  }
  async stopBot() {
    xService.reset();
    return {
      success: true,
      message: "X plugin disconnected"
    };
  }
  async getBotStatus() {
    const hasCredentials = await xService.hasCredentials();
    const config = this.getPluginConfigSnapshot();
    return {
      connected: hasCredentials,
      autonomousPosting: Boolean(config.autonomousPosting),
      lastActivity: this.lastActivity,
      streaming: false
    };
  }
  async sendMessage(params) {
    const result = await xService.tweet(params.content);
    if (result.success) {
      this.lastActivity = /* @__PURE__ */ new Date();
    }
    return {
      success: result.success,
      messageId: result.tweetId,
      error: result.error
    };
  }
  async publishMedia(params) {
    const mediaUrls = params.media.map((entry) => entry.url || entry.mediaKey).filter((entry) => Boolean(entry));
    const result = await xService.tweet(params.content, { mediaUrls });
    if (result.success) {
      this.lastActivity = /* @__PURE__ */ new Date();
    }
    return {
      success: result.success,
      platformPostId: result.tweetId,
      url: result.tweetId ? `https://x.com/i/web/status/${result.tweetId}` : void 0,
      error: result.error
    };
  }
  async fetchPublishedContentMetrics(params) {
    const tweetIds = params.platformPostIds || [];
    const metrics = await xService.fetchTweetMetrics(tweetIds);
    return metrics.map((metric) => ({
      platform: "twitter",
      platformPostId: metric.tweetId,
      capturedAt: metric.capturedAt,
      metrics: metric.metrics
    }));
  }
  async handleCustomEndpoint(request, path) {
    if (path === "/status" && request.method === "GET") {
      const status = await this.getBotStatus();
      return new Response(
        JSON.stringify({
          enabled: this.isEnabled(),
          ...status
        }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    if (path === "/test-connection" && request.method === "POST") {
      const result = await xService.testConnection();
      if (result.success) {
        this.lastActivity = /* @__PURE__ */ new Date();
      }
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    return null;
  }
  async onConfigUpdated(config) {
    await super.onConfigUpdated(config);
    const nextConfig = config;
    xService.reset();
    log.info("Updated X plugin configuration", {
      autonomousPosting: Boolean(nextConfig.autonomousPosting),
      enabled: nextConfig.enabled !== false,
      requireApproval: Boolean(nextConfig.requireApproval)
    });
  }
  getPluginConfigSnapshot() {
    return this.getConfig() || {};
  }
  requiresApproval() {
    return this.getPluginConfigSnapshot().requireApproval !== false;
  }
};
var x_plugin_default = XPlugin;

// src/notification-approvals.ts
import {
  createPluginModuleLogger as createPluginModuleLogger3
} from "@phantasy/agent/plugin-runtime";
var log2 = createPluginModuleLogger3("XNotificationApprovals");
function isXApprovalNotificationType(type) {
  return type === "tweet_approval" || type === "reply_approval";
}
function getXRateLimitStatus() {
  return XService.getInstance().getRateLimitStatus();
}
async function approveXNotification(notification) {
  if (notification.type === "tweet_approval") {
    return handleTweetApproval(notification);
  }
  if (notification.type === "reply_approval") {
    return handleReplyApproval(notification);
  }
  return {};
}
async function handleTweetApproval(notification) {
  try {
    log2.info("Starting tweet approval handler", {
      notificationId: notification.id,
      notificationType: notification.type,
      hasContent: !!notification.content,
      textLength: notification.content?.text?.length
    });
    if (!notification.content?.text) {
      const error = "Invalid notification: missing content or text";
      log2.error("Tweet approval validation failed", {
        error,
        notificationId: notification.id
      });
      throw new Error(error);
    }
    const xService2 = XService.getInstance();
    const tweetText = notification.content.text;
    log2.info("Attempting to post approved tweet", {
      notificationId: notification.id,
      textPreview: `${tweetText.substring(0, 50)}...`,
      textLength: tweetText.length
    });
    const result = await xService2.tweet(tweetText);
    log2.info("Approved tweet result received", {
      notificationId: notification.id,
      success: result.success,
      tweetId: result.tweetId,
      error: result.error
    });
    if (!result.success) {
      throw new Error(result.error || "Failed to post approved tweet");
    }
    return {
      platformPostId: result.tweetId
    };
  } catch (error) {
    log2.error("Tweet approval failed", {
      notificationId: notification.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : void 0
    });
    throw error;
  }
}
async function handleReplyApproval(notification) {
  try {
    const replyText = notification.content.text;
    if (!replyText) {
      throw new Error("Invalid notification: missing reply text");
    }
    const xService2 = XService.getInstance();
    const originalTweetId = notification.content.inReplyTo;
    if (!originalTweetId) {
      const result2 = await xService2.tweet(replyText);
      if (!result2.success) {
        throw new Error(
          result2.error || "Failed to post approved reply as regular tweet"
        );
      }
      log2.info("Approved reply posted as regular tweet", {
        notificationId: notification.id,
        tweetId: result2.tweetId
      });
      return {
        platformPostId: result2.tweetId
      };
    }
    const result = await xService2.replyToTweet(originalTweetId, replyText);
    if (!result.success) {
      throw new Error(result.error || "Failed to post approved reply");
    }
    log2.info("Approved reply posted successfully", {
      notificationId: notification.id,
      replyId: result.replyId,
      inReplyTo: originalTweetId
    });
    return {
      platformPostId: result.replyId
    };
  } catch (error) {
    log2.error("Reply approval failed", {
      notificationId: notification.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : void 0
    });
    throw error;
  }
}

// src/twitter-routes.ts
import {
  createPluginModuleLogger as createPluginModuleLogger4,
  getRuntimePluginManager
} from "@phantasy/agent/plugin-runtime";
var logger2 = createPluginModuleLogger4("TwitterRoutes");
var TwitterRoutes = class {
  async getPluginManager(context) {
    return getRuntimePluginManager({ env: context.env });
  }
  async handle(context) {
    const { request, path } = context;
    const method = request.method;
    if (path === "/admin/api/integrations/twitter/status") {
      if (method === "GET") {
        return this.getTwitterStatus(context);
      }
    }
    if (path === "/admin/api/integrations/twitter/start") {
      if (method === "POST") {
        return this.startTwitterBot(context);
      }
    }
    if (path === "/admin/api/integrations/twitter/stop") {
      if (method === "POST") {
        return this.stopTwitterBot(context);
      }
    }
    if (path === "/admin/api/integrations/twitter/test") {
      if (method === "POST") {
        return this.testTwitterConnection(context);
      }
    }
    if (path === "/admin/api/integrations/twitter/test-autonomous") {
      if (method === "POST") {
        return this.testAutonomousPosting(context);
      }
    }
    return {
      handled: false,
      response: new Response("Not found", { status: 404 })
    };
  }
  async getTwitterPlugin(context) {
    const pm = await this.getPluginManager(context);
    const plugin = pm.getPlugin("x");
    if (plugin && "startBot" in plugin) {
      return plugin;
    }
    return void 0;
  }
  async getTwitterStatus(context) {
    try {
      logger2.info("Getting Twitter bot status");
      const plugin = await this.getTwitterPlugin(context);
      let status = {
        enabled: plugin?.isEnabled?.() || false,
        connected: false,
        streaming: false,
        autonomousPosting: false,
        error: void 0
      };
      if (plugin) {
        try {
          const botStatus = await plugin.getBotStatus();
          status = {
            enabled: plugin.isEnabled(),
            connected: botStatus.connected,
            streaming: botStatus.streaming || false,
            autonomousPosting: botStatus.autonomousPosting || false,
            error: botStatus.error
          };
        } catch (e) {
          logger2.warn("Failed to get bot status:", e);
          status.error = e instanceof Error ? e.message : String(e);
        }
      }
      logger2.info("Twitter bot status:", status);
      return {
        handled: true,
        response: new Response(JSON.stringify(status), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      };
    } catch (error) {
      logger2.error("Error getting Twitter status:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ error: "Failed to get status", details: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      };
    }
  }
  async startTwitterBot(context) {
    try {
      const body = await context.request.json().catch(() => ({}));
      const config = body.config || {};
      const plugin = await this.getTwitterPlugin(context);
      if (!plugin) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({ success: false, error: "Twitter plugin not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          )
        };
      }
      await plugin.onInit({}, config);
      const result = await plugin.startBot();
      return {
        handled: true,
        response: new Response(JSON.stringify(result), {
          status: result.success ? 200 : 400,
          headers: { "Content-Type": "application/json" }
        })
      };
    } catch (error) {
      logger2.error("Error starting Twitter bot:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      };
    }
  }
  async stopTwitterBot(context) {
    try {
      const plugin = await this.getTwitterPlugin(context);
      if (!plugin) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({ success: false, error: "Twitter plugin not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          )
        };
      }
      const result = await plugin.stopBot();
      return {
        handled: true,
        response: new Response(JSON.stringify(result), {
          status: result.success ? 200 : 400,
          headers: { "Content-Type": "application/json" }
        })
      };
    } catch (error) {
      logger2.error("Error stopping Twitter bot:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      };
    }
  }
  async testTwitterConnection(context) {
    try {
      const body = await context.request.json().catch(() => ({}));
      const { apiKey, apiSecret, accessToken, accessSecret } = body;
      if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({
              success: false,
              error: "Missing required Twitter credentials"
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          )
        };
      }
      const { TwitterApi: TwitterApi3 } = await import("twitter-api-v2");
      const client = new TwitterApi3({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken,
        accessSecret
      });
      const me = await client.v2.me();
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: true,
            username: me.data.username,
            userId: me.data.id,
            message: `Successfully connected as @${me.data.username}`
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      };
    } catch (error) {
      logger2.error("Twitter connection test failed:", error);
      const err = error;
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: err?.message || "Connection test failed",
            code: err?.code
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      };
    }
  }
  async testAutonomousPosting(context) {
    try {
      const body = await context.request.json().catch(() => ({}));
      const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "Admin UI autonomous posting test";
      const plugin = await this.getTwitterPlugin(context);
      if (!plugin) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({ success: false, error: "Twitter plugin not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          )
        };
      }
      const result = await plugin.sendMessage?.({
        content: message
      });
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: true,
            message: "Test tweet posted successfully",
            connected: true,
            messageId: result?.messageId
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      };
    } catch (error) {
      logger2.error("Autonomous posting test failed:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: String(error)
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      };
    }
  }
};

// src/twitter-integration.ts
import { TwitterApi as TwitterApi2 } from "twitter-api-v2";
import {
  createPluginModuleLogger as createPluginModuleLogger5,
  LogStorage
} from "@phantasy/agent/plugin-runtime";

// src/twitter-config.ts
var defaultTwitterAdvancedConfig = {
  autonomousPosting: {
    enabled: true,
    // Enabled by default as requested
    requireApproval: true,
    frequency: "low",
    hotStart: true,
    // Post within 30 seconds on startup by default
    postingHours: {
      start: 9,
      end: 21,
      timezone: "America/New_York"
    }
  },
  replySettings: {
    autoReplyToMentions: true,
    autoReplyToFollowers: false,
    replyToTimeline: false,
    requireApprovalForReplies: false,
    replyDelay: 5,
    ignoreBots: true,
    blacklistedWords: []
  },
  moderation: {
    filterProfanity: true,
    checkSentiment: false,
    maxNegativeSentiment: 0.3,
    requireApprovalForNegative: true
  },
  engagement: {
    likeFollowersTweets: false,
    retweetRelevantContent: false,
    followBackRatio: 0.5,
    unfollowInactive: false,
    inactiveDays: 90
  },
  templates: [
    {
      id: "greeting",
      name: "Morning Greeting",
      template: "Good morning! {greeting} Hope everyone has a great day! {emoji}",
      variables: ["greeting", "emoji"],
      category: "engagement"
    },
    {
      id: "announcement",
      name: "Announcement",
      template: "\u{1F4E2} {title}\n\n{content}\n\n{callToAction}",
      variables: ["title", "content", "callToAction"],
      category: "announcement"
    }
  ],
  rateLimits: {
    maxTweetsPerHour: 3,
    // Very conservative - Twitter allows ~300/hour but we limit severely
    maxRepliesPerHour: 5,
    // Very conservative - Twitter allows ~300/hour but we limit severely
    maxLikesPerHour: 10,
    // Very conservative 
    maxFollowsPerDay: 20
    // Very conservative
  }
};

// src/twitter-integration.ts
var logger3 = createPluginModuleLogger5("TwitterIntegration");
function getNestedRecord(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value;
  const next = record[key];
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return {};
  }
  return next;
}
function getTrimmedString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function getTwitterIntegrationConfig(agent) {
  const integrations = getNestedRecord(agent, "integrations");
  const twitter = getNestedRecord(integrations, "twitter");
  if (Object.keys(twitter).length === 0) {
    return void 0;
  }
  return {
    apiKey: getTrimmedString(twitter.apiKey),
    apiSecret: getTrimmedString(twitter.apiSecret),
    accessToken: getTrimmedString(twitter.accessToken),
    accessSecret: getTrimmedString(twitter.accessSecret),
    enabled: typeof twitter.enabled === "boolean" ? twitter.enabled : void 0,
    username: getTrimmedString(twitter.username)
  };
}
var TwitterIntegration = class {
  env;
  logStorage;
  cachedClient = null;
  lastConfigHash = null;
  userInfoCache = null;
  USER_CACHE_TTL = 30 * 60 * 1e3;
  // 30 minutes cache for integration
  constructor(env) {
    this.env = env;
    this.logStorage = LogStorage.getInstance();
  }
  static async test(agent) {
    try {
      const integrationConfig = getTwitterIntegrationConfig(agent);
      const config = {
        apiKey: integrationConfig?.apiKey,
        apiSecret: integrationConfig?.apiSecret,
        accessToken: integrationConfig?.accessToken,
        accessSecret: integrationConfig?.accessSecret,
        enabled: integrationConfig?.enabled
      };
      if (!config.apiKey || !config.apiSecret || !config.accessToken || !config.accessSecret) {
        return {
          success: false,
          error: "Missing Twitter API credentials. Please check your configuration."
        };
      }
      const client = new TwitterApi2({
        appKey: config.apiKey,
        appSecret: config.apiSecret,
        accessToken: config.accessToken,
        accessSecret: config.accessSecret
      });
      const me = await client.v2.me();
      return {
        success: true,
        userInfo: me.data
      };
    } catch (error) {
      logger3.error("Twitter test connection failed:", error);
      return {
        success: false,
        error: (error instanceof Error ? error.message : String(error)) || "Twitter API connection failed"
      };
    }
  }
  async getConfig(skipConnectionCheck = true) {
    try {
      const config = await this.env.AGENTS_KV.get(
        "integration:twitter",
        "json"
      );
      return config;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to get Twitter config", {
        error,
        platform: "twitter"
      });
      return null;
    }
  }
  async saveConfig(config) {
    try {
      if (!config.apiKey || !config.apiSecret || !config.accessToken || !config.accessSecret) {
        throw new Error("All Twitter API credentials are required");
      }
      if (!config.advanced) {
        config.advanced = defaultTwitterAdvancedConfig;
      }
      await this.env.AGENTS_KV.put(
        "integration:twitter",
        JSON.stringify(config)
      );
      const agent = await this.env.AGENTS_KV.get("single-agent", "json");
      if (agent) {
        agent.metadata = {
          ...agent.metadata || {},
          twitter: {
            enabled: config.enabled,
            username: config.username,
            advanced: config.advanced
          }
        };
        await this.env.AGENTS_KV.put("single-agent", JSON.stringify(agent));
      }
      this.logStorage.addLog("info", "Twitter config saved successfully", {
        platform: "twitter"
      });
      return true;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to save Twitter config", {
        error,
        platform: "twitter"
      });
      return false;
    }
  }
  async checkConnectionStatus() {
    try {
      const config = await this.getConfig();
      if (!config) return false;
      return !!config.username;
    } catch (error) {
      return false;
    }
  }
  async testConnection(providedConfig) {
    try {
      let config = null;
      let isTemporaryConfig = false;
      if (providedConfig && providedConfig.apiKey && providedConfig.apiSecret && providedConfig.accessToken && providedConfig.accessSecret) {
        config = {
          apiKey: providedConfig.apiKey,
          apiSecret: providedConfig.apiSecret,
          accessToken: providedConfig.accessToken,
          accessSecret: providedConfig.accessSecret,
          enabled: providedConfig.enabled || false
        };
        isTemporaryConfig = true;
      } else {
        config = await this.getConfig();
        if (!config) {
          return { success: false, error: "No configuration found" };
        }
      }
      const userInfo = await this.getUserInfo(config);
      if (userInfo) {
        if (!isTemporaryConfig) {
          config.username = userInfo.username;
          await this.saveConfig(config);
        }
        this.logStorage.addLog("info", "Twitter connection test successful", {
          platform: "twitter",
          username: userInfo.username
        });
        return { success: true, userInfo };
      }
      return { success: false, error: "Failed to authenticate" };
    } catch (error) {
      if (error?.code === 429) {
        throw error;
      }
      this.logStorage.addLog("error", "Twitter connection test failed", {
        error,
        platform: "twitter"
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed"
      };
    }
  }
  async checkConnection(config) {
    try {
      const userInfo = await this.getUserInfo(config);
      return !!userInfo;
    } catch (error) {
      this.logStorage.addLog("error", "Twitter connection check failed", {
        error,
        platform: "twitter"
      });
      return false;
    }
  }
  getConfigHash(config) {
    return `${config.apiKey}_${config.apiSecret}_${config.accessToken}_${config.accessSecret}`;
  }
  getClient(config) {
    const configHash = this.getConfigHash(config);
    if (this.cachedClient && this.lastConfigHash === configHash) {
      return this.cachedClient;
    }
    this.cachedClient = new TwitterApi2({
      appKey: config.apiKey,
      appSecret: config.apiSecret,
      accessToken: config.accessToken,
      accessSecret: config.accessSecret
    });
    this.lastConfigHash = configHash;
    return this.cachedClient;
  }
  async getUserInfo(config) {
    try {
      const configHash = this.getConfigHash(config);
      if (this.userInfoCache && this.userInfoCache.configHash === configHash && Date.now() - this.userInfoCache.timestamp < this.USER_CACHE_TTL) {
        return this.userInfoCache.data;
      }
      const client = this.getClient(config);
      const me = await client.v2.me();
      this.userInfoCache = {
        data: me.data,
        timestamp: Date.now(),
        configHash
      };
      return me.data;
    } catch (error) {
      const err = error;
      if (err?.code === 429 || err?.statusCode === 429 || err?.data?.status === 429) {
        this.logStorage.addLog("warn", "Twitter API rate limit reached", {
          platform: "twitter",
          error: err?.message || "Rate limit exceeded"
        });
      } else {
        this.logStorage.addLog("error", "Failed to get Twitter user info", {
          error: err?.message || String(error),
          platform: "twitter",
          code: err?.code || err?.statusCode
        });
      }
      if (err?.code !== 429 && err?.statusCode !== 429 && this.userInfoCache) {
        this.logStorage.addLog(
          "info",
          "Using stale cached user info due to error",
          { platform: "twitter" }
        );
        return this.userInfoCache.data;
      }
      if (err?.code === 429 || err?.statusCode === 429) {
        const rateLimitError = new Error(
          "Rate limit exceeded. Please wait before trying again."
        );
        rateLimitError.code = 429;
        throw rateLimitError;
      }
      return null;
    }
  }
  async tweet(text) {
    try {
      const config = await this.getConfig();
      if (!config || !config.enabled) {
        this.logStorage.addLog("error", "Twitter not configured or disabled", {
          platform: "twitter"
        });
        return false;
      }
      const client = this.getClient(config);
      if (text.length > 280) {
        text = text.substring(0, 277) + "...";
      }
      const result = await client.v2.tweet(text);
      this.logStorage.addLog("info", "Tweet sent successfully", {
        tweetId: result.data.id,
        text,
        platform: "twitter"
      });
      return true;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to send tweet", {
        error,
        platform: "twitter"
      });
      return false;
    }
  }
  async replyToTweet(tweetId, text) {
    try {
      const config = await this.getConfig();
      if (!config || !config.enabled) {
        this.logStorage.addLog("error", "Twitter not configured or disabled", {
          platform: "twitter"
        });
        return false;
      }
      const client = new TwitterApi2({
        appKey: config.apiKey,
        appSecret: config.apiSecret,
        accessToken: config.accessToken,
        accessSecret: config.accessSecret
      });
      if (text.length > 280) {
        text = text.substring(0, 277) + "...";
      }
      const result = await client.v2.reply(text, tweetId);
      this.logStorage.addLog("info", "Twitter reply sent successfully", {
        replyId: result.data.id,
        originalTweetId: tweetId,
        text,
        platform: "twitter"
      });
      return true;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to send Twitter reply", {
        error,
        platform: "twitter"
      });
      return false;
    }
  }
};
export {
  TwitterIntegration,
  TwitterRoutes,
  XPlugin,
  XService,
  approveXNotification,
  x_plugin_default as default,
  defaultTwitterAdvancedConfig,
  getXRateLimitStatus,
  isXApprovalNotificationType,
  xService
};
//# sourceMappingURL=index.js.map