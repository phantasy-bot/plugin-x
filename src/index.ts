import { BasePlugin, PluginManifest, PluginTool, PluginConfig } from "@phantasy/core";

export interface XPluginConfig extends PluginConfig {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessSecret?: string;
  autonomousPostingEnabled?: boolean;
  requireApproval?: boolean;
}

export class XPlugin extends BasePlugin {
  readonly name = "x";
  readonly version = "1.0.0";
  private config: XPluginConfig = {};

  constructor(config: XPluginConfig = {}) {
    super();
    this.config = config;
  }

  getManifest(): PluginManifest {
    return {
      name: this.name,
      version: this.version,
      description: "X (Twitter) integration - post tweets, replies, and manage your Twitter presence",
      author: "Phantasy",
      license: "BUSL-1.1",
      repository: "https://github.com/phantasy-bot/plugin-x",
      keywords: ["twitter", "x", "social-media", "platform"],
      category: "social",
      tags: ["x", "twitter", "social-media", "posting", "platform"],
      isPlatform: true,
      platformFeatures: {
        messaging: true,
        streaming: true,
        autonomous: true,
      },
      configSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
          apiKey: { type: "string", title: "API Key", format: "password" },
          apiSecret: { type: "string", title: "API Secret", format: "password" },
          accessToken: { type: "string", title: "Access Token", format: "password" },
          accessSecret: { type: "string", title: "Access Token Secret", format: "password" },
          autonomousPostingEnabled: { type: "boolean", default: true },
          requireApproval: { type: "boolean", default: true },
        },
      },
    };
  }

  getTools(): PluginTool[] {
    return [
      {
        name: "post_tweet",
        description: "Post a tweet to X (Twitter). Maximum 280 characters.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The tweet content (max 280 chars)", maxLength: 280 },
          },
          required: ["text"],
        },
      },
      {
        name: "delete_tweet",
        description: "Delete one of your tweets by ID.",
        parameters: {
          type: "object",
          properties: {
            tweetId: { type: "string", description: "The ID of the tweet to delete" },
          },
          required: ["tweetId"],
        },
      },
      {
        name: "reply_to_tweet",
        description: "Reply to a tweet. Maximum 280 characters.",
        parameters: {
          type: "object",
          properties: {
            tweetId: { type: "string", description: "The tweet ID to reply to" },
            text: { type: "string", description: "Your reply (max 280 chars)", maxLength: 280 },
          },
          required: ["tweetId", "text"],
        },
      },
      {
        name: "search_tweets",
        description: "Search for tweets matching a query.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results", default: 10 },
          },
          required: ["query"],
        },
      },
    ];
  }

  async initialize(): Promise<void> {
    console.log("[XPlugin] Initialized (standalone mode - use with main Phantasy agent for full functionality)");
  }
}

export default XPlugin;
