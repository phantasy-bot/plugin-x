/**
 * Twitter Stream Manager
 * Handles Twitter streaming API and real-time tweet monitoring
 */

import { ETwitterStreamEvent, TweetStream, TweetV2SingleStreamResult } from "twitter-api-v2";
import { createPluginModuleLogger } from "@phantasy/agent/plugin-runtime";
import { TwitterApiClient } from "./api-client";
import {
  TwitterMessage,
  TwitterUser,
  StreamRule,
  TWITTER_CONSTANTS,
} from "./types";

const logger = createPluginModuleLogger("TwitterStreamManager");

export interface StreamEventHandler {
  onTweet?: (tweet: TwitterMessage, author?: TwitterUser) => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
  onConnectionError?: (error: unknown) => Promise<void>;
  onConnectionClosed?: () => Promise<void>;
}

export class StreamManager {
  private apiClient: TwitterApiClient;
  private stream: TweetStream<TweetV2SingleStreamResult> | null = null;
  private isStreaming: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 5000;
  private eventHandlers: StreamEventHandler;
  private streamRules: StreamRule[] = [];

  constructor(apiClient: TwitterApiClient, handlers: StreamEventHandler) {
    this.apiClient = apiClient;
    this.eventHandlers = handlers;
  }

  /**
   * Start streaming tweets
   */
  async startStream(rules?: StreamRule[]): Promise<void> {
    if (this.isStreaming) {
      logger.info("[StreamManager] Stream already running");
      return;
    }

    try {
      // Set up stream rules if provided
      if (rules?.length) {
        await this.setupStreamRules(rules);
      }

      // Create and start stream
      await this.createStream();
      this.isStreaming = true;
      this.reconnectAttempts = 0;

      logger.info("[StreamManager] Stream started successfully");
    } catch (error) {
      logger.error("[StreamManager] Failed to start stream:", error);
      throw error;
    }
  }

  /**
   * Stop streaming
   */
  async stopStream(): Promise<void> {
    if (!this.isStreaming) {
      logger.info("[StreamManager] Stream not running");
      return;
    }

    this.isStreaming = false;

    if (this.stream) {
      try {
        this.stream.close();
        this.stream = null;
        logger.info("[StreamManager] Stream stopped");
      } catch (error) {
        logger.error("[StreamManager] Error stopping stream:", error);
      }
    }
  }

  /**
   * Set up stream rules
   */
  private async setupStreamRules(rules: StreamRule[]): Promise<void> {
    try {
      // Get existing rules
      const existingRules = await this.apiClient.getStreamRules();

      // Remove all existing rules
      if (existingRules.length > 0) {
        const idsToRemove = existingRules.map((r) => r.id!).filter(Boolean);
        await this.apiClient.updateStreamRules(undefined, idsToRemove);
      }

      // Add new rules
      await this.apiClient.updateStreamRules(rules);
      this.streamRules = rules;

      logger.info(`[StreamManager] Set up ${rules.length} stream rules`);
    } catch (error) {
      logger.error("[StreamManager] Failed to setup stream rules:", error);
      throw error;
    }
  }

  /**
   * Create and configure the stream
   */
  private async createStream(): Promise<void> {
    try {
      this.stream = await this.apiClient.createFilteredStream();

      // Set up event listeners
      this.stream.on(ETwitterStreamEvent.Data, async (tweet: TweetV2SingleStreamResult) => {
        await this.handleStreamData(tweet);
      });

      this.stream.on(ETwitterStreamEvent.DataError, async (error: unknown) => {
        logger.error("[StreamManager] Stream data error:", error);
        if (this.eventHandlers.onError) {
          await this.eventHandlers.onError(error);
        }
      });

      this.stream.on(
        ETwitterStreamEvent.ConnectionError,
        async (error: unknown) => {
          logger.error("[StreamManager] Connection error:", error);
          if (this.eventHandlers.onConnectionError) {
            await this.eventHandlers.onConnectionError(error);
          }
          await this.handleConnectionError();
        },
      );

      this.stream.on(ETwitterStreamEvent.ConnectionClosed, async () => {
        logger.warn("[StreamManager] Connection closed");
        if (this.eventHandlers.onConnectionClosed) {
          await this.eventHandlers.onConnectionClosed();
        }
        await this.handleConnectionClosed();
      });

      this.stream.on(ETwitterStreamEvent.DataKeepAlive, () => {
        logger.debug("[StreamManager] Keep-alive signal received");
      });

      // Start auto-reconnect
      this.stream.autoReconnect = true;
    } catch (error) {
      logger.error("[StreamManager] Failed to create stream:", error);
      throw error;
    }
  }

  /**
   * Handle incoming stream data
   */
  private async handleStreamData(data: TweetV2SingleStreamResult): Promise<void> {
    try {
      const tweet = data.data as TwitterMessage;
      const includes = data.includes;

      // Get author information if available
      let author: TwitterUser | undefined;
      if (includes?.users?.length) {
        author = includes.users.find((u) => u.id === tweet.author_id) as TwitterUser | undefined;
      }

      // Call handler
      if (this.eventHandlers.onTweet) {
        await this.eventHandlers.onTweet(tweet, author);
      }
    } catch (error) {
      logger.error("[StreamManager] Error handling stream data:", error);
      if (this.eventHandlers.onError) {
        await this.eventHandlers.onError(error);
      }
    }
  }

  /**
   * Handle connection errors with reconnection logic
   */
  private async handleConnectionError(): Promise<void> {
    if (!this.isStreaming) {
      logger.info(
        "[StreamManager] Not attempting reconnect - streaming disabled",
      );
      return;
    }

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      logger.error("[StreamManager] Max reconnection attempts reached");
      await this.stopStream();
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    logger.info(
      `[StreamManager] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    setTimeout(async () => {
      if (this.isStreaming) {
        try {
          await this.createStream();
          logger.info("[StreamManager] Reconnected successfully");
          this.reconnectAttempts = 0;
        } catch (error) {
          logger.error("[StreamManager] Reconnection failed:", error);
          await this.handleConnectionError();
        }
      }
    }, delay);
  }

  /**
   * Handle connection closed
   */
  private async handleConnectionClosed(): Promise<void> {
    if (this.isStreaming) {
      logger.info(
        "[StreamManager] Connection closed while streaming - attempting reconnect",
      );
      await this.handleConnectionError();
    }
  }

  /**
   * Get current stream rules
   */
  async getStreamRules(): Promise<StreamRule[]> {
    try {
      return await this.apiClient.getStreamRules();
    } catch (error) {
      logger.error("[StreamManager] Failed to get stream rules:", error);
      return [];
    }
  }

  /**
   * Add stream rules
   */
  async addStreamRules(rules: StreamRule[]): Promise<boolean> {
    try {
      const success = await this.apiClient.updateStreamRules(rules);
      if (success) {
        this.streamRules.push(...rules);
      }
      return success;
    } catch (error) {
      logger.error("[StreamManager] Failed to add stream rules:", error);
      return false;
    }
  }

  /**
   * Remove stream rules
   */
  async removeStreamRules(ruleIds: string[]): Promise<boolean> {
    try {
      const success = await this.apiClient.updateStreamRules(
        undefined,
        ruleIds,
      );
      if (success) {
        this.streamRules = this.streamRules.filter(
          (r) => !ruleIds.includes(r.id!),
        );
      }
      return success;
    } catch (error) {
      logger.error("[StreamManager] Failed to remove stream rules:", error);
      return false;
    }
  }

  /**
   * Check if stream is running
   */
  isRunning(): boolean {
    return this.isStreaming;
  }

  /**
   * Get stream status
   */
  getStatus(): {
    streaming: boolean;
    reconnectAttempts: number;
    rules: StreamRule[];
  } {
    return {
      streaming: this.isStreaming,
      reconnectAttempts: this.reconnectAttempts,
      rules: this.streamRules,
    };
  }
}
