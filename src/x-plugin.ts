import {
  BasePlugin,
  type PluginConfig,
  type PlatformCapability,
  type PluginTool,
} from "@phantasy/agent/plugins";
import {
  createPluginModuleLogger,
  type AgentConfig,
} from "@phantasy/agent/plugin-runtime";
import { xService } from "./x-service";

const log = createPluginModuleLogger("XPlugin");

type XPluginConfig = PluginConfig & {
  activeHours?: string;
  autonomousPosting?: boolean;
  enabled?: boolean;
  maxPostsPerDay?: number;
  postingIntervalMinutes?: number;
  requireApproval?: boolean;
};

interface PlatformPublishMediaParams {
  content: string;
  media: Array<{ url?: string; mediaKey?: string }>;
}

interface PlatformPublishMediaResult {
  success: boolean;
  platformPostId?: string;
  url?: string;
  error?: string;
}

interface PlatformContentMetricsParams {
  platformPostIds?: string[];
}

interface PlatformContentMetric {
  platform: string;
  platformPostId: string;
  capturedAt: string;
  metrics: {
    impressions?: number;
    likes?: number;
    replies?: number;
    shares?: number;
  };
}

export class XPlugin extends BasePlugin implements PlatformCapability {
  name = "x-plugin";
  version = "0.1.0-beta";
  description =
    "Post tweets, replies, quotes, search, and manage Twitter/X presence.";

  protected author = "Phantasy";
  protected displayName = "X (Twitter)";
  protected homepage = "https://github.com/xdevplatform/xurl";
  protected repository = "https://github.com/xdevplatform/xurl";
  protected icon = "𝕏";
  protected category = "social";
  protected tags = ["twitter", "x", "social-media", "posting"];
  protected permissions = ["internet"];
  protected workspace = "business" as const;
  protected extensionKind = "integration" as const;
  protected adminSurface = {
    tabId: "x",
    label: "X",
    workspace: "business",
    kind: "generic",
    keywords: ["twitter", "x", "social", "posting"],
    aliases: ["twitter", "x"],
    dashboardIcon: "twitter",
  } as const;
  protected configSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      autonomousPosting: { type: "boolean", default: false },
      postingIntervalMinutes: { type: "number", default: 60 },
      maxPostsPerDay: { type: "number", default: 8 },
      activeHours: { type: "string", default: "9-21" },
      requireApproval: { type: "boolean", default: true },
    },
  };

  private lastActivity?: Date;

  async onInit(agentConfig: AgentConfig, config?: XPluginConfig): Promise<void> {
    await super.onInit(agentConfig, config);
  }

  getTools(): PluginTool[] {
    return [
      {
        name: "x_post_tweet",
        description:
          "Post a tweet immediately, or create an approval draft when approval is required.",
        access: {
          category: "remote",
          risk: "dangerous",
        },
        parameters: {
          type: "object",
          properties: {
            mediaUrls: {
              type: "array",
              items: { type: "string" },
              description: "Optional image URLs to attach to the tweet",
            },
            text: {
              type: "string",
              description: "Tweet text (max 280 characters)",
            },
          },
          required: ["text"],
        },
        handler: async (input: { mediaUrls?: string[]; text: string }) => {
          if (this.requiresApproval()) {
            return xService.createDraftTweet(input.text);
          }

          const result = await xService.tweet(input.text, {
            mediaUrls: input.mediaUrls,
          });
          if (result.success) {
            this.lastActivity = new Date();
          }
          return result;
        },
      },
      {
        name: "x_reply_to_tweet",
        description:
          "Reply to a tweet immediately, or create an approval draft when approval is required.",
        access: {
          category: "remote",
          risk: "dangerous",
        },
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Reply text (max 280 characters)",
            },
            tweetId: {
              type: "string",
              description: "Tweet ID to reply to",
            },
          },
          required: ["tweetId", "text"],
        },
        handler: async (input: { text: string; tweetId: string }) => {
          if (this.requiresApproval()) {
            return xService.createDraftReply(input.tweetId, input.text);
          }

          const result = await xService.replyToTweet(input.tweetId, input.text);
          if (result.success) {
            this.lastActivity = new Date();
          }
          return result;
        },
      },
      {
        name: "x_create_tweet_draft",
        description:
          "Create a draft tweet for manual approval in Notifications without posting immediately.",
        access: {
          category: "remote",
          risk: "caution",
        },
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Tweet text (max 280 characters)",
            },
          },
          required: ["text"],
        },
        handler: async (input: { text: string }) =>
          xService.createDraftTweet(input.text),
      },
      {
        name: "x_create_reply_draft",
        description:
          "Create a draft reply for manual approval in Notifications without posting immediately.",
        access: {
          category: "remote",
          risk: "caution",
        },
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Reply text (max 280 characters)",
            },
            tweetId: {
              type: "string",
              description: "Tweet ID to reply to",
            },
          },
          required: ["tweetId", "text"],
        },
        handler: async (input: { text: string; tweetId: string }) =>
          xService.createDraftReply(input.tweetId, input.text),
      },
      {
        name: "x_delete_tweet",
        description: "Delete a previously posted tweet by ID.",
        access: {
          category: "remote",
          risk: "dangerous",
        },
        parameters: {
          type: "object",
          properties: {
            tweetId: {
              type: "string",
              description: "Tweet ID to delete",
            },
          },
          required: ["tweetId"],
        },
        handler: async (input: { tweetId: string }) =>
          xService.deleteTweet(input.tweetId),
      },
      {
        name: "x_test_connection",
        description:
          "Verify that the configured Twitter/X credentials are valid and can authenticate.",
        access: {
          category: "remote",
          risk: "safe",
        },
        parameters: {
          type: "object",
          properties: {},
        },
        handler: async () => xService.testConnection(),
      },
    ];
  }

  async startBot(): Promise<{ success: boolean; message?: string }> {
    const result = await xService.testConnection();
    if (!result.success) {
      return {
        success: false,
        message: result.error || "Failed to connect to X",
      };
    }

    this.lastActivity = new Date();
    return {
      success: true,
      message: result.username
        ? `Connected to X as @${result.username}`
        : "Connected to X",
    };
  }

  async stopBot(): Promise<{ success: boolean; message?: string }> {
    xService.reset();
    return {
      success: true,
      message: "X plugin disconnected",
    };
  }

  async getBotStatus(): Promise<{
    autonomousPosting?: boolean;
    connected: boolean;
    error?: string;
    lastActivity?: Date;
    streaming?: boolean;
  }> {
    const hasCredentials = await xService.hasCredentials();
    const config = this.getPluginConfigSnapshot();

    return {
      connected: hasCredentials,
      autonomousPosting: Boolean(config.autonomousPosting),
      lastActivity: this.lastActivity,
      streaming: false,
    };
  }

  async sendMessage(params: {
    content: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const result = await xService.tweet(params.content);
    if (result.success) {
      this.lastActivity = new Date();
    }
    return {
      success: result.success,
      messageId: result.tweetId,
      error: result.error,
    };
  }

  async publishMedia(
    params: PlatformPublishMediaParams,
  ): Promise<PlatformPublishMediaResult> {
    const mediaUrls = params.media
      .map((entry) => entry.url || entry.mediaKey)
      .filter((entry): entry is string => Boolean(entry));
    const result = await xService.tweet(params.content, { mediaUrls });
    if (result.success) {
      this.lastActivity = new Date();
    }
    return {
      success: result.success,
      platformPostId: result.tweetId,
      url: result.tweetId ? `https://x.com/i/web/status/${result.tweetId}` : undefined,
      error: result.error,
    };
  }

  async fetchPublishedContentMetrics(
    params: PlatformContentMetricsParams,
  ): Promise<PlatformContentMetric[]> {
    const tweetIds = params.platformPostIds || [];
    const metrics = await xService.fetchTweetMetrics(tweetIds);
    return metrics.map((metric) => ({
      platform: "twitter",
      platformPostId: metric.tweetId,
      capturedAt: metric.capturedAt,
      metrics: metric.metrics,
    }));
  }

  async handleCustomEndpoint(
    request: Request,
    path: string,
  ): Promise<Response | null> {
    if (path === "/status" && request.method === "GET") {
      const status = await this.getBotStatus();
      return new Response(
        JSON.stringify({
          enabled: this.isEnabled(),
          ...status,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (path === "/test-connection" && request.method === "POST") {
      const result = await xService.testConnection();
      if (result.success) {
        this.lastActivity = new Date();
      }
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return null;
  }

  async onConfigUpdated(config: PluginConfig): Promise<void> {
    await super.onConfigUpdated(config);
    const nextConfig = config as XPluginConfig;
    xService.reset();
    log.info("Updated X plugin configuration", {
      autonomousPosting: Boolean(nextConfig.autonomousPosting),
      enabled: nextConfig.enabled !== false,
      requireApproval: Boolean(nextConfig.requireApproval),
    });
  }

  private getPluginConfigSnapshot(): XPluginConfig {
    return (this.getConfig() || {}) as XPluginConfig;
  }

  private requiresApproval(): boolean {
    return this.getPluginConfigSnapshot().requireApproval !== false;
  }
}

export default XPlugin;
