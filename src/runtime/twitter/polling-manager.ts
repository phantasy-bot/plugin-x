/**
 * Polling Manager
 * Manages polling for Twitter mentions and timeline updates
 */

import { TwitterApi } from "twitter-api-v2";
import {
  createPluginModuleLogger,
  LogStorage,
  POLLING_TIMEOUTS,
  RateLimitManager,
} from "@phantasy/agent/plugin-runtime";
import { TwitterMessage } from "../twitter-bot-service";
import { TwitterUser } from "./types";

const logger = createPluginModuleLogger("TwitterPollingManager");

type TweetReceivedHandler = (tweet: TwitterMessage, author: TwitterUser) => Promise<void>;

export class PollingManager {
  private client: TwitterApi;
  private rateLimitManager: RateLimitManager;
  private logStorage: LogStorage;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalLock: Promise<void> | null = null;
  private lastSeenMentionId: string | undefined = undefined;
  private pollMethod: "mentions" | "search" | null = null;
  private lastPollTime: number = 0;
  private isActive: boolean = false;

  constructor(
    client: TwitterApi,
    rateLimitManager: RateLimitManager,
    logStorage: LogStorage,
  ) {
    this.client = client;
    this.rateLimitManager = rateLimitManager;
    this.logStorage = logStorage;
  }

  /**
   * Start optimized polling for mentions
   */
  async startPolling(
    userId: string,
    username: string,
    onTweetReceived: TweetReceivedHandler,
  ): Promise<void> {
    // Prevent concurrent interval modifications
    if (this.pollIntervalLock) {
      logger.warn("⚠️ Polling already being modified, waiting...");
      await this.pollIntervalLock;
      return;
    }

    // Create async lock
    let lockResolve: () => void;
    this.pollIntervalLock = new Promise((resolve) => {
      lockResolve = resolve;
    });

    try {
      // Clean up any existing intervals
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      this.isActive = true;
      this.pollMethod = "mentions";

      // Calculate adaptive polling interval
      const getPollingInterval = () => {
        const baseInterval = POLLING_TIMEOUTS.default;
        return Math.min(
          baseInterval * this.rateLimitManager.getBackoffMultiplier("twitter"),
          POLLING_TIMEOUTS.rateLimited,
        );
      };

      const executePoll = async () => {
        if (!this.isActive) {
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
          }
          return;
        }

        const now = Date.now();
        const timeSinceLastPoll = now - this.lastPollTime;

        // Skip if polled too recently
        if (timeSinceLastPoll < POLLING_TIMEOUTS.minimum) {
          logger.debug(
            `⏳ Skipping poll - too soon (${Math.round(timeSinceLastPoll / 1000)}s since last)`,
          );
          return;
        }

        this.lastPollTime = now;

        try {
          const hasNewMentions = await this.pollForMentions(
            userId,
            username,
            onTweetReceived,
          );

          if (hasNewMentions) {
            this.rateLimitManager.resetBackoff("twitter");
          }

          // Reschedule with new interval if needed
          if (this.pollInterval && !this.pollIntervalLock) {
            await this.reschedulePolling(getPollingInterval());
          }
        } catch (error) {
          logger.error("❌ Polling error:", error);
          await this.handlePollingError(error, userId, username);
        }
      };

      // Start polling with adaptive interval
      this.pollInterval = setInterval(executePoll, getPollingInterval());
      this.pollInterval.unref?.();

      // Initial poll after delay
      const initialTimeout = setTimeout(executePoll, 5 * 60 * 1000);
      initialTimeout.unref?.();
    } finally {
      lockResolve!();
      this.pollIntervalLock = null;
    }
  }

  /**
   * Stop polling
   */
  async stopPolling(): Promise<void> {
    this.isActive = false;

    // Wait for any ongoing interval modifications
    if (this.pollIntervalLock) {
      await this.pollIntervalLock;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.pollMethod = null;
    this.lastSeenMentionId = undefined;
    this.lastPollTime = 0;
  }

  /**
   * Poll for mentions using the appropriate method
   */
  private async pollForMentions(
    userId: string,
    username: string,
    onTweetReceived: TweetReceivedHandler,
  ): Promise<boolean> {
    // Try mentions timeline first
    if (this.pollMethod === "mentions") {
      const success = await this.pollMentionsTimeline(userId, onTweetReceived);
      if (!success) {
        logger.info("🔄 Switching to search API for polling");
        this.pollMethod = "search";
      } else {
        return true;
      }
    }

    // Fallback to search API
    if (this.pollMethod === "search") {
      return await this.pollSearchAPI(username, onTweetReceived);
    }

    return false;
  }

  /**
   * Poll mentions timeline
   */
  private async pollMentionsTimeline(
    userId: string,
    onTweetReceived: TweetReceivedHandler,
  ): Promise<boolean> {
    try {
      this.rateLimitManager.trackAPIUsage("mentions_timeline");

      const mentions = await this.client.v2.userMentionTimeline(userId, {
        max_results: 10,
        since_id: this.lastSeenMentionId,
        "tweet.fields": [
          "created_at",
          "conversation_id",
          "in_reply_to_user_id",
        ],
        "user.fields": ["username"],
        expansions: ["author_id"],
      });

      if (!mentions.data || mentions.data.data.length === 0) {
        return false;
      }

      // Process new mentions
      for (const tweet of mentions.data.data) {
        const author = mentions.includes?.users?.find(
          (u) => u.id === tweet.author_id,
        );
        if (author) {
          await onTweetReceived(tweet as TwitterMessage, author);
        }
      }

      // Update last seen ID
      this.lastSeenMentionId = mentions.data.data[0].id;

      this.logStorage.addLog(
        "info",
        `Processed ${mentions.data.data.length} new mentions`,
        { platform: "twitter", method: "mentions_timeline" },
      );

      return true;
    } catch (error) {
      if (error instanceof Object && 'code' in error && (error as { code: number }).code === 429) {
        throw error; // Let parent handle rate limits
      }
      logger.error("Failed to poll mentions timeline:", error);
      return false;
    }
  }

  /**
   * Poll using search API
   */
  private async pollSearchAPI(
    username: string,
    onTweetReceived: TweetReceivedHandler,
  ): Promise<boolean> {
    try {
      this.rateLimitManager.trackAPIUsage("search");

      const query = `@${username} -from:${username}`;
      const searchResults = await this.client.v2.search(query, {
        max_results: 10,
        "tweet.fields": [
          "created_at",
          "conversation_id",
          "in_reply_to_user_id",
        ],
        "user.fields": ["username"],
        expansions: ["author_id"],
      });

      if (!searchResults.data || searchResults.data.data.length === 0) {
        return false;
      }

      // Process results
      for (const tweet of searchResults.data.data) {
        const author = searchResults.includes?.users?.find(
          (u) => u.id === tweet.author_id,
        );
        if (author) {
          await onTweetReceived(tweet as TwitterMessage, author);
        }
      }

      this.logStorage.addLog(
        "info",
        `Processed ${searchResults.data.data.length} mentions via search`,
        { platform: "twitter", method: "search" },
      );

      return true;
    } catch (error) {
      if (error instanceof Object && 'code' in error && (error as { code: number }).code === 429) {
        throw error;
      }
      logger.error("Failed to poll search API:", error);
      return false;
    }
  }

  /**
   * Handle polling errors
   */
  private async handlePollingError(
    error: unknown,
    userId: string,
    username: string,
  ): Promise<void> {
    const errorObj = error instanceof Object ? (error as Record<string, unknown>) : {};
    if (errorObj.code === 429 || errorObj.statusCode === 429) {
      logger.warn("⚠️ Rate limited - backing off");
      this.rateLimitManager.increaseBackoff("twitter");

      // Clear current interval
      if (this.pollInterval && !this.pollIntervalLock) {
        await this.stopPolling();
      }

      // Schedule restart with longer delay
      const restartDelay = POLLING_TIMEOUTS.rateLimited;
      logger.info(`⏰ Will restart polling in ${restartDelay / 60000} minutes`);

      setTimeout(() => {
        if (this.isActive) {
          this.startPolling(userId, username, () => Promise.resolve());
        }
      }, restartDelay);
    }
  }

  /**
   * Reschedule polling with new interval
   */
  private async reschedulePolling(newInterval: number): Promise<void> {
    // Create new async lock for interval reschedule
    let rescheduleResolve: () => void;
    this.pollIntervalLock = new Promise((resolve) => {
      rescheduleResolve = resolve;
    });

    try {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        // Polling will be executed in next interval
      }, newInterval);
      this.pollInterval.unref?.();
    } finally {
      rescheduleResolve!();
      this.pollIntervalLock = null;
    }
  }

  /**
   * Get polling status
   */
  getStatus(): {
    isActive: boolean;
    method: string | null;
    lastPollTime: string | null;
    backoffMultiplier: number;
  } {
    return {
      isActive: this.isActive,
      method: this.pollMethod,
      lastPollTime: this.lastPollTime
        ? new Date(this.lastPollTime).toISOString()
        : null,
      backoffMultiplier: this.rateLimitManager.getBackoffMultiplier("twitter"),
    };
  }
}
