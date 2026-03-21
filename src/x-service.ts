import { TwitterApi } from "twitter-api-v2";
import {
  createPluginModuleLogger,
  createRuntimeId,
  fetchWithTimeout,
  kvService,
  PlatformConfigService,
} from "@phantasy/agent/plugin-runtime";

const logger = createPluginModuleLogger("XService");

/** Shape of Twitter API errors with status code properties */
interface TwitterApiError extends Error {
  code?: number;
  statusCode?: number;
}

/**
 * Tweet notification interface for approval workflow
 * Notifications are stored in KV storage for user review before posting
 */
interface TweetNotification {
  /** Unique notification ID */
  id: string;
  /** Type of notification: tweet or reply approval */
  type: "tweet_approval" | "reply_approval";
  /** Platform identifier (always 'twitter' for X) */
  platform: "twitter";
  /** ISO 8601 timestamp when notification was created */
  timestamp: string;
  /** Current approval status */
  status: "pending" | "approved" | "rejected";
  /** Notification content */
  content: {
    /** Tweet or reply text */
    text: string;
    /** Tweet ID this is replying to (only for replies) */
    inReplyTo?: string;
    /** Human-readable reason for this notification */
    reason: string;
  };
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * XService - Clean, simple X (Twitter) API integration
 *
 * @description
 * Provides tweet management functionality following KISS principles.
 * Uses lazy initialization to prevent rate limiting on startup.
 *
 * @features
 * - Post tweets immediately
 * - Delete tweets by ID
 * - Reply to tweets
 * - Create draft tweets for approval workflow
 * - Create draft replies for approval workflow
 *
 * @ratelimits
 * X API v2 Rate Limits (per 15-minute window):
 * - POST requests (tweets, replies): 200
 * - DELETE requests: 50
 * - GET requests: varies by endpoint
 *
 * @example
 * ```typescript
 * const xService = XService.getInstance();
 *
 * // Post a tweet immediately
 * const result = await xService.tweet("Hello World!");
 * if (result.success) {
 *   console.log(`Tweet posted: ${result.tweetId}`);
 * }
 *
 * // Create a draft for approval
 * const draft = await xService.createDraftTweet("Check this out!");
 * // User can approve/reject from Notifications UI
 * ```
 */
export class XService {
  private client: TwitterApi | null = null;
  private config: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
  } | null = null;

  // User info cache (to avoid repeated API calls for dashboard widget)
  private userInfoCache: {
    data: { id: string; username: string };
    timestamp: number;
  } | null = null;
  private USER_INFO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Rate limit tracking
  private lastRateLimitError: number | null = null;
  private RATE_LIMIT_COOLDOWN = 15 * 60 * 1000; // 15 minutes cooldown after rate limit
  private requestCount = 0;
  private requestWindowStart = Date.now();
  private REQUEST_WINDOW = 15 * 60 * 1000; // 15 minute window
  private MAX_REQUESTS_PER_WINDOW = 10; // Conservative limit for Free tier

  // Singleton instance
  private static instance: XService | null = null;

  /**
   * Get the singleton instance of XService
   * @returns The XService singleton instance
   */
  static getInstance(): XService {
    if (!XService.instance) {
      XService.instance = new XService();
    }
    return XService.instance;
  }

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {}

  private summarizeMediaUrl(mediaUrl: string): string {
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
  async hasCredentials(): Promise<boolean> {
    try {
      const platformConfig =
        await PlatformConfigService.getInstance().get("twitter");

      if (!platformConfig) {
        return false;
      }

      return !!(
        platformConfig.apiKey &&
        platformConfig.apiSecret &&
        platformConfig.accessToken &&
        platformConfig.accessSecret
      );
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
  getCachedUserInfo(): { id: string; username: string } | null {
    if (!this.userInfoCache) {
      return null;
    }

    const now = Date.now();
    if (now - this.userInfoCache.timestamp > this.USER_INFO_CACHE_TTL) {
      // Cache expired
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
  async getClient(): Promise<TwitterApi | null> {
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
      accessSecret: this.config.accessSecret,
    });

    return this.client;
  }

  /**
   * Load credentials from platform config service
   * @private
   * @returns True if credentials were loaded successfully, false otherwise
   */
  private async loadCredentials(): Promise<boolean> {
    try {
      const platformConfig =
        await PlatformConfigService.getInstance().get("twitter");

      if (!platformConfig) {
        logger.warn(
          "[XService] X/Twitter platform not configured. Configure credentials in Platforms > Twitter.",
        );
        return false;
      }

      if (
        !platformConfig.apiKey ||
        !platformConfig.apiSecret ||
        !platformConfig.accessToken ||
        !platformConfig.accessSecret
      ) {
        logger.warn(
          "[XService] Missing X/Twitter credentials. Add API credentials in Platforms > Twitter.",
        );
        return false;
      }

      this.config = {
        apiKey: platformConfig.apiKey as string,
        apiSecret: platformConfig.apiSecret as string,
        accessToken: platformConfig.accessToken as string,
        accessSecret: platformConfig.accessSecret as string,
      };

      logger.info(
        "[XService] ✅ Credentials loaded successfully (Platform enabled: " +
          (platformConfig.enabled ? "yes" : "no") +
          ")",
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
  private async ensureClient(): Promise<boolean> {
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
        accessSecret: this.config.accessSecret,
      });

      logger.info("[XService] ✅ Client initialized");
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
  getRateLimitStatus(): {
    isLimited: boolean;
    reason?: string;
    resetAt?: string;
    minutesRemaining?: number;
    requestCount?: number;
    requestLimit?: number;
  } {
    const now = Date.now();

    // Check cooldown from 429 error
    if (this.lastRateLimitError) {
      const timeSinceError = now - this.lastRateLimitError;
      if (timeSinceError < this.RATE_LIMIT_COOLDOWN) {
        const minutesRemaining = Math.ceil(
          (this.RATE_LIMIT_COOLDOWN - timeSinceError) / 60000,
        );
        const resetAt = new Date(
          this.lastRateLimitError + this.RATE_LIMIT_COOLDOWN,
        ).toLocaleTimeString();
        return {
          isLimited: true,
          reason: "Twitter rate limit (429 error)",
          resetAt,
          minutesRemaining,
        };
      }
    }

    // Check request budget
    if (now - this.requestWindowStart <= this.REQUEST_WINDOW) {
      if (this.requestCount >= this.MAX_REQUESTS_PER_WINDOW) {
        const minutesUntilReset = Math.ceil(
          (this.REQUEST_WINDOW - (now - this.requestWindowStart)) / 60000,
        );
        const resetAt = new Date(
          this.requestWindowStart + this.REQUEST_WINDOW,
        ).toLocaleTimeString();
        return {
          isLimited: true,
          reason: "Request budget exhausted",
          resetAt,
          minutesRemaining: minutesUntilReset,
          requestCount: this.requestCount,
          requestLimit: this.MAX_REQUESTS_PER_WINDOW,
        };
      }
    }

    return {
      isLimited: false,
      requestCount: this.requestCount,
      requestLimit: this.MAX_REQUESTS_PER_WINDOW,
    };
  }

  /**
   * Check if we're currently rate limited
   * @private
   * @returns True if rate limited, false otherwise
   */
  private isRateLimited(): boolean {
    // Check if we hit a rate limit recently
    if (this.lastRateLimitError) {
      const timeSinceError = Date.now() - this.lastRateLimitError;
      if (timeSinceError < this.RATE_LIMIT_COOLDOWN) {
        const minutesRemaining = Math.ceil(
          (this.RATE_LIMIT_COOLDOWN - timeSinceError) / 60000,
        );
        logger.warn(
          `[XService] Still in rate limit cooldown. Wait ${minutesRemaining} more minutes.`,
        );
        return true;
      } else {
        // Cooldown expired, reset
        this.lastRateLimitError = null;
      }
    }

    // Check if we've exceeded our request budget for this window
    const now = Date.now();
    if (now - this.requestWindowStart > this.REQUEST_WINDOW) {
      // Window expired, reset
      this.requestCount = 0;
      this.requestWindowStart = now;
    }

    if (this.requestCount >= this.MAX_REQUESTS_PER_WINDOW) {
      const minutesUntilReset = Math.ceil(
        (this.REQUEST_WINDOW - (now - this.requestWindowStart)) / 60000,
      );
      logger.warn(
        `[XService] Request budget exhausted (${this.requestCount}/${this.MAX_REQUESTS_PER_WINDOW}). Reset in ${minutesUntilReset} minutes.`,
      );
      return true;
    }

    return false;
  }

  /**
   * Track a request for rate limiting purposes
   * @private
   */
  private trackRequest(): void {
    this.requestCount++;
    logger.debug(
      `[XService] Request tracked: ${this.requestCount}/${this.MAX_REQUESTS_PER_WINDOW}`,
    );
  }

  /**
   * Record a rate limit error
   * @private
   */
  private recordRateLimitError(): void {
    this.lastRateLimitError = Date.now();
    logger.warn(
      `[XService] Rate limit hit. Entering ${this.RATE_LIMIT_COOLDOWN / 60000} minute cooldown.`,
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
   *   console.log(`Tweet posted with ID: ${result.tweetId}`);
   * } else {
   *   console.error(`Failed: ${result.error}`);
   * }
   * ```
   */
  async tweet(
    text: string,
    options?: { mediaUrls?: string[] },
  ): Promise<{ success: boolean; tweetId?: string; error?: string }> {
    try {
      // Check rate limit before attempting
      if (this.isRateLimited()) {
        return {
          success: false,
          error:
            "Rate limit protection: Please wait before posting. The system will automatically retry when the limit resets.",
        };
      }

      // Validate input
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Tweet text cannot be empty",
        };
      }

      // Enforce character limit
      if (text.length > 280) {
        return {
          success: false,
          error: `Tweet is too long (${text.length} characters). Maximum is 280 characters.`,
        };
      }

      // Ensure client is ready
      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error:
            "X/Twitter service not configured. Please add your API credentials in Settings.",
        };
      }

      // Upload media if provided
      const mediaIds: string[] = [];
      if (options?.mediaUrls && options.mediaUrls.length > 0) {
        for (const mediaUrl of options.mediaUrls) {
          try {
            logger.info("[XService] Uploading media from URL", {
              mediaOrigin: this.summarizeMediaUrl(mediaUrl),
            });

            // Fetch the media file
            const mediaResponse = await fetchWithTimeout(mediaUrl, {
              timeout: 30000,
            });
            if (!mediaResponse.ok) {
              logger.error("[XService] Failed to fetch media", {
                mediaOrigin: this.summarizeMediaUrl(mediaUrl),
                status: mediaResponse.status,
              });
              continue;
            }

            const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());

            // Upload to Twitter
            const mediaId = await this.client.v1.uploadMedia(mediaBuffer, {
              mimeType:
                mediaResponse.headers.get("content-type") || "image/png",
            });

            mediaIds.push(mediaId);
            logger.info("[XService] Media uploaded successfully", {
              mediaId,
            });
          } catch (uploadError: unknown) {
            logger.error("[XService] Failed to upload media", {
              error: uploadError instanceof Error ? uploadError.message : String(uploadError),
              mediaOrigin: this.summarizeMediaUrl(mediaUrl),
            });
            // Continue with other media or post without this one
          }
        }
      }

      // Post the tweet with optional media
      const tweetPayload: { text: string; media?: { media_ids: string[] } } = { text };
      if (mediaIds.length > 0) {
        tweetPayload.media = { media_ids: mediaIds };
      }

      const result = await this.client.v2.tweet(tweetPayload as Parameters<typeof this.client.v2.tweet>[0]);

      // Track successful request
      this.trackRequest();

      logger.info("[XService] ✅ Tweet posted successfully", {
        tweetId: result.data.id,
        length: text.length,
      });

      return {
        success: true,
        tweetId: result.data.id,
      };
    } catch (error: unknown) {
      logger.error("[XService] Failed to post tweet:", error);
      const twitterError = error as TwitterApiError;

      // Handle rate limiting
      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        this.recordRateLimitError();
        return {
          success: false,
          error:
            "Rate limit exceeded. Please wait 15 minutes before posting again. The system will track this and prevent further attempts during the cooldown period.",
        };
      }

      // Handle authentication errors
      if (twitterError?.code === 401 || twitterError?.statusCode === 401) {
        return {
          success: false,
          error: "Authentication failed. Please check your X API credentials.",
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to post tweet",
      };
    }
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
   *   console.log("Tweet deleted successfully");
   * }
   * ```
   */
  async deleteTweet(
    tweetId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!tweetId || tweetId.trim().length === 0) {
        return {
          success: false,
          error: "Tweet ID is required",
        };
      }

      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "X/Twitter service not configured.",
        };
      }

      await this.client.v2.deleteTweet(tweetId);

      logger.info("[XService] ✅ Tweet deleted successfully", { tweetId });

      return {
        success: true,
      };
    } catch (error: unknown) {
      logger.error("[XService] Failed to delete tweet:", error);
      const twitterError = error as TwitterApiError;

      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        return {
          success: false,
          error: "Rate limit exceeded. Please wait before trying again.",
        };
      }

      if (twitterError?.code === 404 || twitterError?.statusCode === 404) {
        return {
          success: false,
          error: "Tweet not found. It may have already been deleted.",
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete tweet",
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
   *   console.log(`Reply posted with ID: ${result.replyId}`);
   * }
   * ```
   */
  async replyToTweet(
    tweetId: string,
    text: string,
  ): Promise<{ success: boolean; replyId?: string; error?: string }> {
    try {
      if (!tweetId || tweetId.trim().length === 0) {
        return {
          success: false,
          error: "Tweet ID is required",
        };
      }

      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Reply text cannot be empty",
        };
      }

      if (text.length > 280) {
        return {
          success: false,
          error: `Reply is too long (${text.length} characters). Maximum is 280 characters.`,
        };
      }

      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "X/Twitter service not configured.",
        };
      }

      const result = await this.client.v2.reply(text, tweetId);

      logger.info("[XService] ✅ Reply posted successfully", {
        replyId: result.data.id,
        inReplyTo: tweetId,
      });

      return {
        success: true,
        replyId: result.data.id,
      };
    } catch (error: unknown) {
      logger.error("[XService] Failed to post reply:", error);
      const twitterError = error as TwitterApiError;

      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        return {
          success: false,
          error: "Rate limit exceeded. Please wait before trying again.",
        };
      }

      if (twitterError?.code === 404 || twitterError?.statusCode === 404) {
        return {
          success: false,
          error: "Original tweet not found.",
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to post reply",
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
   *   console.log(`Draft created: ${result.notificationId}`);
   *   console.log("User can approve/reject in Notifications tab");
   * }
   * ```
   */
  async createDraftTweet(
    text: string,
  ): Promise<{ success: boolean; notificationId?: string; error?: string }> {
    try {
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Tweet text cannot be empty",
        };
      }

      if (text.length > 280) {
        return {
          success: false,
          error: `Tweet is too long (${text.length} characters). Maximum is 280 characters.`,
        };
      }

      const notificationId = createRuntimeId("tweet_draft");

      const notification: TweetNotification = {
        id: notificationId,
        type: "tweet_approval",
        platform: "twitter",
        timestamp: new Date().toISOString(),
        status: "pending",
        content: {
          text,
          reason: "Agent created a draft tweet for your review",
        },
        metadata: {
          source: "auto_draft",
          createdAt: new Date().toISOString(),
        },
      };

      // Store notification using kvService
      await this.storeNotification(notification);

      logger.info("[XService] ✅ Draft tweet created", {
        notificationId,
        length: text.length,
      });

      return {
        success: true,
        notificationId,
      };
    } catch (error: unknown) {
      logger.error("[XService] Failed to create draft tweet:", error);

      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create draft tweet",
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
   *   console.log(`Draft reply created: ${result.notificationId}`);
   * }
   * ```
   */
  async createDraftReply(
    tweetId: string,
    text: string,
  ): Promise<{ success: boolean; notificationId?: string; error?: string }> {
    try {
      if (!tweetId || tweetId.trim().length === 0) {
        return {
          success: false,
          error: "Tweet ID is required",
        };
      }

      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: "Reply text cannot be empty",
        };
      }

      if (text.length > 280) {
        return {
          success: false,
          error: `Reply is too long (${text.length} characters). Maximum is 280 characters.`,
        };
      }

      const notificationId = createRuntimeId("reply_draft");

      const notification: TweetNotification = {
        id: notificationId,
        type: "reply_approval",
        platform: "twitter",
        timestamp: new Date().toISOString(),
        status: "pending",
        content: {
          text,
          inReplyTo: tweetId,
          reason: "Agent created a draft reply for your review",
        },
        metadata: {
          source: "auto_draft",
          inReplyTo: tweetId,
          createdAt: new Date().toISOString(),
        },
      };

      await this.storeNotification(notification);

      logger.info("[XService] ✅ Draft reply created", {
        notificationId,
        inReplyTo: tweetId,
      });

      return {
        success: true,
        notificationId,
      };
    } catch (error: unknown) {
      logger.error("[XService] Failed to create draft reply:", error);

      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create draft reply",
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
  private async storeNotification(
    notification: TweetNotification,
  ): Promise<void> {
    try {
      // Get existing notifications
      const existingData: { notifications: TweetNotification[] } =
        (await kvService.get("notifications")) || {
          notifications: [],
        };

      // Add new notification to the front
      existingData.notifications.unshift(notification);

      // Keep only last 100 notifications
      if (existingData.notifications.length > 100) {
        existingData.notifications = existingData.notifications.slice(0, 100);
      }

      // Save back to KV
      await kvService.set("notifications", existingData);

      logger.info("[XService] ✅ Notification stored", {
        id: notification.id,
        type: notification.type,
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
   *   console.log(`Connected as @${result.username}`);
   * } else {
   *   console.error(`Connection failed: ${result.error}`);
   * }
   * ```
   */
  async testConnection(): Promise<{
    success: boolean;
    username?: string;
    error?: string;
  }> {
    try {
      const clientReady = await this.ensureClient();
      if (!clientReady || !this.client) {
        return {
          success: false,
          error: "Failed to initialize X client",
        };
      }

      const me = await this.client.v2.me();

      logger.info("[XService] ✅ Connection test successful", {
        username: me.data.username,
      });

      return {
        success: true,
        username: me.data.username,
      };
    } catch (error: unknown) {
      logger.error("[XService] Connection test failed:", error);
      const twitterError = error as TwitterApiError;

      if (twitterError?.code === 429 || twitterError?.statusCode === 429) {
        return {
          success: false,
          error: "Rate limit exceeded. Please wait before testing again.",
        };
      }

      if (twitterError?.code === 401 || twitterError?.statusCode === 401) {
        return {
          success: false,
          error: "Invalid credentials. Please check your API keys.",
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection test failed",
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
  reset(): void {
    this.client = null;
    this.config = null;
    logger.info("[XService] Service reset");
  }
}

// Export singleton instance for consistent usage across the application
export const xService = XService.getInstance();
