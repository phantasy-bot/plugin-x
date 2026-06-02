/**
 * Twitter API Client
 * Handles all Twitter API interactions with rate limiting
 */

import { TwitterApi } from "twitter-api-v2";
import {
  createPluginModuleLogger,
  RateLimiter,
  RateLimitPresets,
} from "@phantasy/agent/plugin-runtime";
import {
  TwitterConfig,
  TwitterMessage,
  TwitterUser,
  TweetOptions,
  SearchOptions,
  TimelineOptions,
  StreamRule,
  RateLimitInfo,
  TWITTER_CONSTANTS,
} from "./types";

const logger = createPluginModuleLogger("TwitterApiClient");

export class TwitterApiClient {
  private client: TwitterApi | null = null;
  private config: TwitterConfig;
  private rateLimiters: Map<string, RateLimiter> = new Map();
  private rateLimitTracker: Map<string, RateLimitInfo> = new Map();
  private backoffMultiplier: number = 1;
  private userInfoCache: { data: TwitterUser; timestamp: number } | null = null;

  constructor(config: TwitterConfig) {
    this.config = config;
    this.initializeRateLimiters();
  }

  /**
   * Initialize rate limiters for different endpoints
   */
  private initializeRateLimiters(): void {
    // Tweet operations
    this.rateLimiters.set(
      "tweets",
      new RateLimiter({
        ...RateLimitPresets.TWITTER_TWEETS,
        identifier: "twitter-tweets",
      }),
    );

    // Search operations
    this.rateLimiters.set(
      "search",
      new RateLimiter({
        ...RateLimitPresets.TWITTER_SEARCH,
        identifier: "twitter-search",
      }),
    );

    // Timeline operations
    this.rateLimiters.set(
      "timeline",
      new RateLimiter({
        maxRequests: 75,
        windowMs: 900000, // 15 minutes
        identifier: "twitter-timeline",
      }),
    );

    // User operations
    this.rateLimiters.set(
      "users",
      new RateLimiter({
        maxRequests: 900,
        windowMs: 900000, // 15 minutes
        identifier: "twitter-users",
      }),
    );
  }

  /**
   * Connect to Twitter API
   */
  async connect(): Promise<void> {
    if (this.client) {
      logger.info("[TwitterAPI] Already connected");
      return;
    }

    try {
      this.client = new TwitterApi({
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        accessToken: this.config.accessToken,
        accessSecret: this.config.accessSecret,
      });

      // Verify credentials
      const user = await this.getCurrentUser();
      logger.info(`[TwitterAPI] Connected as @${user.username}`);
    } catch (error) {
      logger.error("[TwitterAPI] Failed to connect:", error);
      throw new Error(
        `Twitter connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get current authenticated user
   */
  async getCurrentUser(): Promise<TwitterUser> {
    if (!this.client) throw new Error("Not connected to Twitter");

    // Check cache
    if (
      this.userInfoCache &&
      Date.now() - this.userInfoCache.timestamp <
        TWITTER_CONSTANTS.USER_CACHE_TTL
    ) {
      return this.userInfoCache.data;
    }

    await this.rateLimiters.get("users")!.waitForLimit();

    try {
      const { data: user } = await this.client.v2.me({
        "user.fields": ["profile_image_url", "public_metrics", "verified"],
      });

      this.userInfoCache = {
        data: user,
        timestamp: Date.now(),
      };

      return user as TwitterUser;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to get current user:", error);
      throw error;
    }
  }

  /**
   * Send a tweet
   */
  async tweet(options: TweetOptions): Promise<TwitterMessage> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("tweets")!.waitForLimit();

    try {
      const tweetData: {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
        media?: { media_ids: string[] };
        quote_tweet_id?: string;
      } = { text: options.text };

      if (options.inReplyTo) {
        tweetData.reply = { in_reply_to_tweet_id: options.inReplyTo };
      }

      if (options.mediaIds?.length) {
        tweetData.media = { media_ids: options.mediaIds };
      }

      if (options.quoteTweetId) {
        tweetData.quote_tweet_id = options.quoteTweetId;
      }

      const { data } = await this.client.v2.tweet(tweetData as Parameters<typeof this.client.v2.tweet>[0]);

      logger.info(`[TwitterAPI] Tweet sent: ${data.id}`);
      return data as TwitterMessage;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to send tweet:", error);
      throw error;
    }
  }

  /**
   * Delete a tweet
   */
  async deleteTweet(tweetId: string): Promise<boolean> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("tweets")!.waitForLimit();

    try {
      await this.client.v2.deleteTweet(tweetId);
      logger.info(`[TwitterAPI] Tweet deleted: ${tweetId}`);
      return true;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to delete tweet:", error);
      return false;
    }
  }

  /**
   * Like a tweet
   */
  async likeTweet(tweetId: string): Promise<boolean> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("tweets")!.waitForLimit();

    try {
      const user = await this.getCurrentUser();
      await this.client.v2.like(user.id, tweetId);
      logger.info(`[TwitterAPI] Tweet liked: ${tweetId}`);
      return true;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to like tweet:", error);
      return false;
    }
  }

  /**
   * Retweet a tweet
   */
  async retweet(tweetId: string): Promise<boolean> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("tweets")!.waitForLimit();

    try {
      const user = await this.getCurrentUser();
      await this.client.v2.retweet(user.id, tweetId);
      logger.info(`[TwitterAPI] Tweet retweeted: ${tweetId}`);
      return true;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to retweet:", error);
      return false;
    }
  }

  /**
   * Search for tweets
   */
  async searchTweets(options: SearchOptions): Promise<{
    tweets: TwitterMessage[];
    nextToken?: string;
  }> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("search")!.waitForLimit();

    try {
      const searchParams: Record<string, unknown> = {
        query: options.query,
        max_results: options.maxResults || 10,
        "tweet.fields": [
          "created_at",
          "author_id",
          "conversation_id",
          "public_metrics",
          "referenced_tweets",
        ],
      };

      if (options.sinceId) searchParams.since_id = options.sinceId;
      if (options.untilId) searchParams.until_id = options.untilId;
      if (options.startTime) searchParams.start_time = options.startTime;
      if (options.endTime) searchParams.end_time = options.endTime;
      if (options.nextToken) searchParams.pagination_token = options.nextToken;

      const { query: searchQuery, ...searchOpts } = searchParams;
      const response = await this.client.v2.search(searchQuery as string, searchOpts as Record<string, string | number | string[]>);

      const tweets: TwitterMessage[] = (response.data.data || []).map(
        (tweet) => ({
          id: tweet.id,
          text: tweet.text,
          author_id: tweet.author_id || "",
          created_at: tweet.created_at,
          conversation_id: tweet.conversation_id,
          in_reply_to_user_id: tweet.in_reply_to_user_id,
          referenced_tweets: tweet.referenced_tweets,
          public_metrics: tweet.public_metrics,
        }),
      );

      return {
        tweets,
        nextToken: response.data.meta?.next_token,
      };
    } catch (error) {
      logger.error("[TwitterAPI] Search failed:", error);
      throw error;
    }
  }

  /**
   * Get user timeline
   */
  async getUserTimeline(options: TimelineOptions): Promise<{
    tweets: TwitterMessage[];
    nextToken?: string;
  }> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("timeline")!.waitForLimit();

    try {
      const exclude: string[] = [];
      if (options.excludeReplies) exclude.push("replies");
      if (options.excludeRetweets) exclude.push("retweets");

      const timelineParams: Record<string, unknown> = {
        max_results: options.maxResults || 10,
        "tweet.fields": [
          "created_at",
          "author_id",
          "conversation_id",
          "public_metrics",
          "referenced_tweets",
        ],
        exclude,
      };
      if (options.sinceId) timelineParams.since_id = options.sinceId;
      if (options.untilId) timelineParams.until_id = options.untilId;
      if (options.paginationToken)
        timelineParams.pagination_token = options.paginationToken;

      const response = await this.client.v2.userTimeline(
        options.userId,
        timelineParams as Parameters<typeof this.client.v2.userTimeline>[1],
      );

      const tweets: TwitterMessage[] = (response.data.data || []).map(
        (tweet) => ({
          id: tweet.id,
          text: tweet.text,
          author_id: tweet.author_id || "",
          created_at: tweet.created_at,
          conversation_id: tweet.conversation_id,
          in_reply_to_user_id: tweet.in_reply_to_user_id,
          referenced_tweets: tweet.referenced_tweets,
          public_metrics: tweet.public_metrics,
        }),
      );

      return {
        tweets,
        nextToken: response.data.meta?.next_token,
      };
    } catch (error) {
      logger.error("[TwitterAPI] Timeline fetch failed:", error);
      throw error;
    }
  }

  /**
   * Get mentions timeline
   */
  async getMentions(
    userId: string,
    sinceId?: string,
  ): Promise<TwitterMessage[]> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("timeline")!.waitForLimit();

    try {
      const params: Record<string, unknown> = {
        max_results: 100,
        "tweet.fields": [
          "created_at",
          "author_id",
          "conversation_id",
          "public_metrics",
          "referenced_tweets",
        ],
      };

      if (sinceId) params.since_id = sinceId;

      const response = await this.client.v2.userMentionTimeline(userId, params as Parameters<typeof this.client.v2.userMentionTimeline>[1]);
      const tweets: TwitterMessage[] = (response.data.data || []).map(
        (tweet) => ({
          id: tweet.id,
          text: tweet.text,
          author_id: tweet.author_id || "",
          created_at: tweet.created_at,
          conversation_id: tweet.conversation_id,
          in_reply_to_user_id: tweet.in_reply_to_user_id,
          referenced_tweets: tweet.referenced_tweets,
          public_metrics: tweet.public_metrics,
        }),
      );
      return tweets;
    } catch (error) {
      logger.error("[TwitterAPI] Mentions fetch failed:", error);
      throw error;
    }
  }

  /**
   * Get tweet by ID
   */
  async getTweet(tweetId: string): Promise<TwitterMessage | null> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("tweets")!.waitForLimit();

    try {
      const { data } = await this.client.v2.singleTweet(tweetId, {
        "tweet.fields": [
          "created_at",
          "author_id",
          "conversation_id",
          "public_metrics",
          "referenced_tweets",
        ],
      });

      return data as TwitterMessage;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to get tweet:", error);
      return null;
    }
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<TwitterUser | null> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("users")!.waitForLimit();

    try {
      const { data } = await this.client.v2.userByUsername(username, {
        "user.fields": ["profile_image_url", "public_metrics", "verified"],
      });

      return data as TwitterUser;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to get user:", error);
      return null;
    }
  }

  /**
   * Follow a user
   */
  async followUser(targetUserId: string): Promise<boolean> {
    if (!this.client) throw new Error("Not connected to Twitter");

    await this.rateLimiters.get("users")!.waitForLimit();

    try {
      const user = await this.getCurrentUser();
      await this.client.v2.follow(user.id, targetUserId);
      logger.info(`[TwitterAPI] Followed user: ${targetUserId}`);
      return true;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to follow user:", error);
      return false;
    }
  }

  /**
   * Get stream rules
   */
  async getStreamRules(): Promise<StreamRule[]> {
    if (!this.client) throw new Error("Not connected to Twitter");

    try {
      const rules = await this.client.v2.streamRules();
      return rules.data || [];
    } catch (error) {
      logger.error("[TwitterAPI] Failed to get stream rules:", error);
      return [];
    }
  }

  /**
   * Update stream rules
   */
  async updateStreamRules(
    add?: StreamRule[],
    remove?: string[],
  ): Promise<boolean> {
    if (!this.client) throw new Error("Not connected to Twitter");

    try {
      const updates: { add?: StreamRule[]; delete?: { ids: string[] } } = {};
      if (add?.length) updates.add = add;
      if (remove?.length) updates.delete = { ids: remove };

      // Cast needed: our union type for add/delete doesn't match the library's overloads
      await this.client.v2.updateStreamRules(updates as any);
      logger.info("[TwitterAPI] Stream rules updated");
      return true;
    } catch (error) {
      logger.error("[TwitterAPI] Failed to update stream rules:", error);
      return false;
    }
  }

  /**
   * Create a filtered stream
   */
  async createFilteredStream() {
    if (!this.client) throw new Error("Not connected to Twitter");

    return this.client.v2.searchStream({
      "tweet.fields": [
        "created_at",
        "author_id",
        "conversation_id",
        "public_metrics",
        "referenced_tweets",
      ],
      "user.fields": ["profile_image_url", "public_metrics", "verified"],
    });
  }

  /**
   * Handle rate limit error with backoff
   */
  async handleRateLimit(error: unknown): Promise<void> {
    const errObj = error instanceof Object ? (error as Record<string, unknown>) : {};
    if (errObj.code === 429 || errObj.statusCode === 429) {
      this.backoffMultiplier = Math.min(
        this.backoffMultiplier * 2,
        TWITTER_CONSTANTS.BACKOFF_MULTIPLIER_MAX,
      );

      const waitTime =
        TWITTER_CONSTANTS.MIN_POLL_INTERVAL * this.backoffMultiplier;
      logger.warn(`[TwitterAPI] Rate limited. Waiting ${waitTime}ms`);

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    } else {
      this.backoffMultiplier = 1;
    }
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus(): Map<string, RateLimitInfo> {
    const status = new Map<string, RateLimitInfo>();

    for (const [endpoint, limiter] of this.rateLimiters) {
      status.set(endpoint, {
        count: limiter.getRemaining(),
        resetTime: Date.now() + limiter.getResetTime(),
      });
    }

    return status;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Disconnect from Twitter
   */
  disconnect(): void {
    this.client = null;
    this.userInfoCache = null;
    logger.info("[TwitterAPI] Disconnected");
  }
}
