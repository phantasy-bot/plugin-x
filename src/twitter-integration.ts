import { TwitterApi } from "twitter-api-v2";
import {
  createPluginModuleLogger,
  LogStorage,
} from "@phantasy/agent/plugin-runtime";
import {
  TwitterAdvancedConfig,
  defaultTwitterAdvancedConfig,
} from "./twitter-config";

type IntegrationPluginPermissions = Record<string, unknown>;

type KvStore = {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
};

const logger = createPluginModuleLogger("TwitterIntegration");

export interface TwitterConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  enabled: boolean;
  connected?: boolean;
  username?: string;
  enableStreaming?: boolean;
  pollingIntervalMinutes?: number;
  advanced?: TwitterAdvancedConfig;
  pluginPermissions?: IntegrationPluginPermissions;
}

export interface Env {
  AGENTS_KV: KvStore;
}

function getNestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const next = record[key];
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return {};
  }

  return next as Record<string, unknown>;
}

function getTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getTwitterIntegrationConfig(agent: unknown): Partial<TwitterConfig> | undefined {
  const integrations = getNestedRecord(agent, "integrations");
  const twitter = getNestedRecord(integrations, "twitter");
  if (Object.keys(twitter).length === 0) {
    return undefined;
  }

  return {
    apiKey: getTrimmedString(twitter.apiKey),
    apiSecret: getTrimmedString(twitter.apiSecret),
    accessToken: getTrimmedString(twitter.accessToken),
    accessSecret: getTrimmedString(twitter.accessSecret),
    enabled: typeof twitter.enabled === "boolean" ? twitter.enabled : undefined,
    username: getTrimmedString(twitter.username),
  };
}

export class TwitterIntegration {
  private env: Env;
  private logStorage: LogStorage;
  private cachedClient: TwitterApi | null = null;
  private lastConfigHash: string | null = null;
  private userInfoCache: {
    data: any;
    timestamp: number;
    configHash: string;
  } | null = null;
  private readonly USER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes cache for integration

  constructor(env: Env) {
    this.env = env;
    this.logStorage = LogStorage.getInstance();
  }

  static async test(
    agent: unknown,
  ): Promise<{ success: boolean; error?: string; userInfo?: any }> {
    try {
      const integrationConfig = getTwitterIntegrationConfig(agent);
      const config = {
        apiKey: integrationConfig?.apiKey,
        apiSecret: integrationConfig?.apiSecret,
        accessToken: integrationConfig?.accessToken,
        accessSecret: integrationConfig?.accessSecret,
        enabled: integrationConfig?.enabled,
      };

      // Check if all required fields are present
      if (
        !config.apiKey ||
        !config.apiSecret ||
        !config.accessToken ||
        !config.accessSecret
      ) {
        return {
          success: false,
          error:
            "Missing Twitter API credentials. Please check your configuration.",
        };
      }

      // Test the connection using Twitter API
      const client = new TwitterApi({
        appKey: config.apiKey,
        appSecret: config.apiSecret,
        accessToken: config.accessToken,
        accessSecret: config.accessSecret,
      });

      const me = await client.v2.me();
      return {
        success: true,
        userInfo: me.data,
      };
    } catch (error: unknown) {
      logger.error("Twitter test connection failed:", error);
      return {
        success: false,
        error: (error instanceof Error ? error.message : String(error)) || "Twitter API connection failed",
      };
    }
  }

  async getConfig(skipConnectionCheck = true): Promise<TwitterConfig | null> {
    try {
      const config = await this.env.AGENTS_KV.get(
        "integration:twitter",
        "json",
      );
      // Never automatically check connection to avoid rate limits
      // Connection check should only happen on explicit test
      return config as TwitterConfig | null;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to get Twitter config", {
        error,
        platform: "twitter",
      });
      return null;
    }
  }

  async saveConfig(config: TwitterConfig): Promise<boolean> {
    try {
      // Validate config
      if (
        !config.apiKey ||
        !config.apiSecret ||
        !config.accessToken ||
        !config.accessSecret
      ) {
        throw new Error("All Twitter API credentials are required");
      }

      // Set default advanced config if not provided
      if (!config.advanced) {
        config.advanced = defaultTwitterAdvancedConfig;
      }

      // Save to KV
      await this.env.AGENTS_KV.put(
        "integration:twitter",
        JSON.stringify(config),
      );

      // Update agent config with Twitter settings
      const agent = await this.env.AGENTS_KV.get("single-agent", "json") as Record<string, unknown> | null;
      if (agent) {
        (agent as Record<string, unknown>).metadata = {
          ...((agent as Record<string, unknown>).metadata as Record<string, unknown> || {}),
          twitter: {
            enabled: config.enabled,
            username: config.username,
            advanced: config.advanced,
          },
        };
        await this.env.AGENTS_KV.put("single-agent", JSON.stringify(agent));
      }

      this.logStorage.addLog("info", "Twitter config saved successfully", {
        platform: "twitter",
      });
      return true;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to save Twitter config", {
        error,
        platform: "twitter",
      });
      return false;
    }
  }

  async checkConnectionStatus(): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config) return false;
      // Only return true if we have cached username, don't make API calls
      return !!config.username;
    } catch (error) {
      return false;
    }
  }

  async testConnection(
    providedConfig?: Partial<TwitterConfig>,
  ): Promise<{ success: boolean; error?: string; userInfo?: any }> {
    try {
      // Use provided config or get from storage
      let config: TwitterConfig | null = null;
      let isTemporaryConfig = false;

      if (
        providedConfig &&
        providedConfig.apiKey &&
        providedConfig.apiSecret &&
        providedConfig.accessToken &&
        providedConfig.accessSecret
      ) {
        // Create a temporary config for testing
        config = {
          apiKey: providedConfig.apiKey,
          apiSecret: providedConfig.apiSecret,
          accessToken: providedConfig.accessToken,
          accessSecret: providedConfig.accessSecret,
          enabled: providedConfig.enabled || false,
        };
        isTemporaryConfig = true;
      } else {
        // Fall back to saved config
        config = await this.getConfig();
        if (!config) {
          return { success: false, error: "No configuration found" };
        }
      }

      // Test connection by getting user info
      const userInfo = await this.getUserInfo(config);
      if (userInfo) {
        // Only update saved config if not a temporary test
        if (!isTemporaryConfig) {
          config.username = userInfo.username;
          await this.saveConfig(config);
        }

        this.logStorage.addLog("info", "Twitter connection test successful", {
          platform: "twitter",
          username: userInfo.username,
        });

        return { success: true, userInfo };
      }

      return { success: false, error: "Failed to authenticate" };
    } catch (error: unknown) {
      // Re-throw rate limit errors properly
      if ((error as { code?: number })?.code === 429) {
        throw error;
      }
      this.logStorage.addLog("error", "Twitter connection test failed", {
        error,
        platform: "twitter",
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }

  private async checkConnection(config: TwitterConfig): Promise<boolean> {
    try {
      const userInfo = await this.getUserInfo(config);
      return !!userInfo;
    } catch (error) {
      this.logStorage.addLog("error", "Twitter connection check failed", {
        error,
        platform: "twitter",
      });
      return false;
    }
  }

  private getConfigHash(config: TwitterConfig): string {
    return `${config.apiKey}_${config.apiSecret}_${config.accessToken}_${config.accessSecret}`;
  }

  private getClient(config: TwitterConfig): TwitterApi {
    const configHash = this.getConfigHash(config);

    // Return cached client if config hasn't changed
    if (this.cachedClient && this.lastConfigHash === configHash) {
      return this.cachedClient;
    }

    // Create new client and cache it
    this.cachedClient = new TwitterApi({
      appKey: config.apiKey,
      appSecret: config.apiSecret,
      accessToken: config.accessToken,
      accessSecret: config.accessSecret,
    });
    this.lastConfigHash = configHash;

    return this.cachedClient;
  }

  private async getUserInfo(config: TwitterConfig): Promise<any | null> {
    try {
      const configHash = this.getConfigHash(config);

      // Check cache first
      if (
        this.userInfoCache &&
        this.userInfoCache.configHash === configHash &&
        Date.now() - this.userInfoCache.timestamp < this.USER_CACHE_TTL
      ) {
        return this.userInfoCache.data;
      }

      // Cache miss or expired, make API call
      const client = this.getClient(config);
      const me = await client.v2.me();

      // Update cache
      this.userInfoCache = {
        data: me.data,
        timestamp: Date.now(),
        configHash,
      };

      return me.data;
    } catch (error: unknown) {
      // Check for rate limit error
      const err = error as { code?: number; statusCode?: number; message?: string; data?: { status?: number; detail?: string } };
      if (
        err?.code === 429 ||
        err?.statusCode === 429 ||
        err?.data?.status === 429
      ) {
        this.logStorage.addLog("warn", "Twitter API rate limit reached", {
          platform: "twitter",
          error: err?.message || "Rate limit exceeded",
        });
      } else {
        this.logStorage.addLog("error", "Failed to get Twitter user info", {
          error: err?.message || String(error),
          platform: "twitter",
          code: err?.code || err?.statusCode,
        });
      }

      // Return stale cache if available during errors (except rate limits)
      if (
        err?.code !== 429 &&
        err?.statusCode !== 429 &&
        this.userInfoCache
      ) {
        this.logStorage.addLog(
          "info",
          "Using stale cached user info due to error",
          { platform: "twitter" },
        );
        return this.userInfoCache.data;
      }

      // Re-throw with proper error code
      if (err?.code === 429 || err?.statusCode === 429) {
        const rateLimitError = new Error(
          "Rate limit exceeded. Please wait before trying again.",
        );
        (rateLimitError as Error & { code?: number }).code = 429;
        throw rateLimitError;
      }
      return null;
    }
  }

  async tweet(text: string): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config || !config.enabled) {
        this.logStorage.addLog("error", "Twitter not configured or disabled", {
          platform: "twitter",
        });
        return false;
      }

      const client = this.getClient(config);

      // Twitter has a 280 character limit
      if (text.length > 280) {
        text = text.substring(0, 277) + "...";
      }

      const result = await client.v2.tweet(text);

      this.logStorage.addLog("info", "Tweet sent successfully", {
        tweetId: result.data.id,
        text: text,
        platform: "twitter",
      });

      return true;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to send tweet", {
        error,
        platform: "twitter",
      });
      return false;
    }
  }

  async replyToTweet(tweetId: string, text: string): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config || !config.enabled) {
        this.logStorage.addLog("error", "Twitter not configured or disabled", {
          platform: "twitter",
        });
        return false;
      }

      const client = new TwitterApi({
        appKey: config.apiKey,
        appSecret: config.apiSecret,
        accessToken: config.accessToken,
        accessSecret: config.accessSecret,
      });

      // Twitter has a 280 character limit
      if (text.length > 280) {
        text = text.substring(0, 277) + "...";
      }

      const result = await client.v2.reply(text, tweetId);

      this.logStorage.addLog("info", "Twitter reply sent successfully", {
        replyId: result.data.id,
        originalTweetId: tweetId,
        text: text,
        platform: "twitter",
      });

      return true;
    } catch (error) {
      this.logStorage.addLog("error", "Failed to send Twitter reply", {
        error,
        platform: "twitter",
      });
      return false;
    }
  }
}
