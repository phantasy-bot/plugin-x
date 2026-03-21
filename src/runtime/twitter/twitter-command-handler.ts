/**
 * Twitter Command Handler
 * Handles Twitter-specific commands from mentions
 */

import {
  AgentService,
  createPluginModuleLogger,
} from "@phantasy/agent/plugin-runtime";
import { TwitterMessage } from "../twitter-bot-service";
import { TwitterUser } from "./types";

const logger = createPluginModuleLogger("TwitterCommandHandler");

interface TwitterCommandResult {
  handled: boolean;
  response?: string;
}

interface TwitterCommandConfig {
  twitter?: {
    contentGuidelines?: {
      requireApproval?: boolean;
    };
  };
}

interface ApprovalMetadata {
  type: "tweet_approval" | "reply_approval";
  platform: "twitter";
  reason: string;
  originalTweetId?: string;
  llmMetadata?: {
    template?: string;
    prompt: string;
    rawResponse: string;
    cleanedResponse: string;
    timestamp: string;
  };
}

export class TwitterCommandHandler {
  constructor(
    private agentService: AgentService,
    private config: TwitterCommandConfig,
    private tweetFunction: (text: string) => Promise<boolean>,
    private replyFunction: (tweetId: string, text: string) => Promise<boolean>,
    private createApprovalNotification?: (
      content: string,
      metadata: ApprovalMetadata,
    ) => Promise<void>,
  ) {}

  /**
   * Handle Twitter-specific commands
   */
  async handleCommand(
    text: string,
    author: TwitterUser,
    tweetId: string,
  ): Promise<TwitterCommandResult> {
    const lowerText = text.toLowerCase().trim();

    // Post tweet command
    if (lowerText.startsWith("post") || lowerText.startsWith("tweet")) {
      return await this.handlePostCommand(text, author, tweetId);
    }

    // Status command
    if (lowerText.includes("status") || lowerText.includes("info")) {
      return await this.handleStatusCommand(tweetId);
    }

    // Help command
    if (lowerText.includes("help") || lowerText.includes("commands")) {
      return await this.handleHelpCommand(tweetId);
    }

    return { handled: false };
  }

  /**
   * Handle post/tweet commands
   */
  private async handlePostCommand(
    text: string,
    author: TwitterUser,
    tweetId: string,
  ): Promise<TwitterCommandResult> {
    try {
      // Extract content after "post" or "tweet"
      const contentMatch = text.match(/(?:post|tweet)\s+(.+)/i);
      const content = contentMatch ? contentMatch[1].trim() : "";

      if (!content) {
        await this.replyFunction(
          tweetId,
          "Please specify what you'd like me to post. Example: 'post a tweet about crypto'",
        );
        return { handled: true };
      }

      // Generate tweet content using AI
      const { ContentGenerator } = await import(
        "./content-generator"
      );
      const contentGenerator = new ContentGenerator(this.agentService);
      const defaultCfg = {
        templates: {
          casual: { prompts: [], parameters: {} },
          promotional: { prompts: [], parameters: {} },
          educational: { prompts: [], parameters: {} },
        },
        contentGuidelines: {
          maxLength: 280,
          includeEmojis: true,
          mentionCommunity: false,
          avoidSpam: true,
          requireApproval: true,
        },
      };
      contentGenerator.setConfig({
        ...defaultCfg,
        ...(this.config.twitter || {}),
      } as unknown as Parameters<typeof contentGenerator.setConfig>[0]);

      const result = await contentGenerator.generateTweetContent(
        `Create a tweet about: ${content}`,
        "promotional",
      );

      // Validate content
      const validation = contentGenerator.validateContent(result.text);
      if (!validation.valid) {
        await this.replyFunction(
          tweetId,
          `Sorry, I couldn't create a valid tweet: ${validation.reason}`,
        );
        return { handled: true };
      }

      // Check if approval is required
      const requireApproval =
        this.config.twitter?.contentGuidelines?.requireApproval ?? true;

      if (requireApproval && this.createApprovalNotification) {
        // Create approval notification with LLM metadata
        await this.createApprovalNotification(result.text, {
          type: "tweet_approval",
          platform: "twitter",
          reason: `Manual post request from @${author.username}: "${content}"`,
          originalTweetId: tweetId,
          llmMetadata: result.metadata,
        });

        await this.replyFunction(
          tweetId,
          "Your tweet has been submitted for approval! I'll post it once it's approved. 🚀",
        );
      } else {
        // Post directly
        const success = await this.tweetFunction(result.text);
        if (success) {
          await this.replyFunction(tweetId, "Tweet posted successfully! ✅");
        } else {
          await this.replyFunction(
            tweetId,
            "Sorry, I couldn't post the tweet. Please try again.",
          );
        }
      }

      return { handled: true };
    } catch (error) {
      logger.error("Error handling post command:", error);
      await this.replyFunction(
        tweetId,
        "Sorry, I encountered an error processing your request.",
      );
      return { handled: true };
    }
  }

  /**
   * Handle status command
   */
  private async handleStatusCommand(
    tweetId: string,
  ): Promise<TwitterCommandResult> {
    // This would need to be passed in or accessed differently
    // For now, provide a basic status
    const statusMessage = `🤖 Twitter Bot Commands Available:
• "post [content]" - Generate and post a tweet
• "tweet [content]" - Same as post
• "status" - Show this help
• "help" - Show available commands

Just chat normally for regular conversation! 💜`;

    await this.replyFunction(tweetId, statusMessage);
    return { handled: true };
  }

  /**
   * Handle help command
   */
  private async handleHelpCommand(
    tweetId: string,
  ): Promise<TwitterCommandResult> {
    const helpMessage = `🤖 Available Commands:
• "post [content]" - Generate and post a tweet
• "tweet [content]" - Same as post
• "status" - Check bot status
• "help" - Show this help

Examples:
• "post a tweet about crypto"
• "tweet something fun about gaming"

Just chat normally for regular conversation! 💜`;

    await this.replyFunction(tweetId, helpMessage);
    return { handled: true };
  }
}
