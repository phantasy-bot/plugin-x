/**
 * Content Generator
 * Handles content generation and cleaning for Twitter posts
 */

import {
  AgentService,
  AGENT_DEFAULTS,
  createPluginModuleLogger,
  randomChoice,
  randomFloat,
} from "@phantasy/agent/plugin-runtime";

const logger = createPluginModuleLogger("TwitterContentGenerator");

interface TwitterTemplate {
  prompts: string[];
  parameters: Record<string, string[]>;
}

interface TwitterTemplates {
  casual: TwitterTemplate;
  promotional: TwitterTemplate;
  educational: TwitterTemplate;
  question: TwitterTemplate;
  opinion: TwitterTemplate;
  shower_thought: TwitterTemplate;
  thirst_trap: TwitterTemplate;
}

interface TwitterContentGuidelines {
  maxLength: number;
  includeEmojis: boolean;
  mentionCommunity: boolean;
  avoidSpam: boolean;
  requireApproval: boolean;
}

interface TwitterConfig {
  templates: TwitterTemplates;
  contentGuidelines: TwitterContentGuidelines;
}

export class ContentGenerator {
  private agentService: AgentService;
  private config: TwitterConfig | null = null;
  private readonly MAX_TWEET_LENGTH = 280;

  constructor(agentService: AgentService, config?: TwitterConfig) {
    this.agentService = agentService;
    this.config = config || null;
  }

  /**
   * Set the Twitter configuration
   */
  setConfig(config: TwitterConfig): void {
    this.config = config;
  }

  /**
   * Generate tweet content using AI with templates
   * Returns both the cleaned content and metadata about the generation
   */
  async generateTweetContent(
    prompt?: string,
    category?: keyof TwitterTemplates,
  ): Promise<{
    text: string;
    metadata: {
      template?: keyof TwitterTemplates;
      prompt: string;
      rawResponse: string;
      cleanedResponse: string;
      timestamp: string;
    };
  }> {
    const agentId = AGENT_DEFAULTS.ID;
    const selectedCategory = category || this.selectRandomCategory();
    const finalPrompt = prompt || this.generateContentPrompt(selectedCategory);

    try {
      const response = await this.agentService.processMessage(
        agentId,
        finalPrompt,
        {
          platform: "twitter",
          userId: "twitter_bot",
          username: "twitter_bot",
          metadata: {
            maxTokens: 100,
            temperature: 0.8,
          },
        },
      );

      if (response.text) {
        const cleanedText = this.cleanContent(response.text);
        return {
          text: cleanedText,
          metadata: {
            template: selectedCategory,
            prompt: finalPrompt,
            rawResponse: response.text,
            cleanedResponse: cleanedText,
            timestamp: new Date().toISOString(),
          },
        };
      }

      throw new Error("No content generated");
    } catch (error) {
      logger.error("Failed to generate tweet content:", error);
      throw error;
    }
  }

  /**
   * Select a random template category with weighted distribution
   */
  private selectRandomCategory(): keyof TwitterTemplates {
    // Weighted distribution - casual and questions are more common
    const weights: Array<{ category: keyof TwitterTemplates; weight: number }> =
      [
        { category: "casual", weight: 25 },
        { category: "question", weight: 20 },
        { category: "opinion", weight: 15 },
        { category: "shower_thought", weight: 15 },
        { category: "educational", weight: 15 },
        { category: "thirst_trap", weight: 5 },
        { category: "promotional", weight: 5 },
      ];

    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
    const random = randomFloat() * totalWeight;

    let cumulative = 0;
    for (const { category, weight } of weights) {
      cumulative += weight;
      if (random < cumulative) {
        return category;
      }
    }

    return "casual"; // fallback
  }

  /**
   * Generate a response to a mention
   */
  async generateReply(
    originalText: string,
    authorUsername: string,
    context?: { userId?: string },
  ): Promise<string> {
    const agentId = AGENT_DEFAULTS.ID;
    const cleanText = this.cleanMentions(originalText);

    try {
      const response = await this.agentService.processMessage(
        agentId,
        cleanText,
        {
          platform: "twitter",
          userId: context?.userId || "unknown",
          username: authorUsername,
        },
      );

      if (response.text) {
        let replyText = this.cleanContent(response.text);

        // Ensure it fits Twitter's character limit
        if (replyText.length > this.MAX_TWEET_LENGTH) {
          replyText = this.truncateText(replyText, this.MAX_TWEET_LENGTH);
        }

        return replyText;
      }

      return "Thanks for your message! How can I help you today?";
    } catch (error) {
      logger.error("Failed to generate reply:", error);
      return "Sorry, I encountered an error processing your message. Please try again!";
    }
  }

  /**
   * Clean content for Twitter posting
   */
  cleanContent(text: string): string {
    // Remove markdown formatting
    let cleaned = text
      .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
      .replace(/\*(.*?)\*/g, "$1") // Italic
      .replace(/__(.*?)__/g, "$1") // Underline
      .replace(/~~(.*?)~~/g, "$1") // Strikethrough
      .replace(/`(.*?)`/g, "$1") // Inline code
      .replace(/```[\s\S]*?```/g, "") // Code blocks
      .replace(/^#+\s+/gm, "") // Headers
      .replace(/^\s*[-*+]\s+/gm, "") // List items
      .replace(/^\s*\d+\.\s+/gm, "") // Numbered lists
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Links
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1"); // Images

    // Remove excessive whitespace
    cleaned = cleaned
      .replace(/\n{3,}/g, "\n\n") // Multiple newlines
      .replace(/\s{2,}/g, " ") // Multiple spaces
      .trim();

    // Remove quotes if the entire text is quoted
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }

    // Remove common AI response patterns
    const patterns = [
      /^(Sure|Certainly|Of course|Happy to help)[,!.]\s*/i,
      /^Here's?\s+(a|an|the|your|my)\s+/i,
      /^I\s+(think|believe|feel|would say)\s+/i,
      /^(In my opinion|I'd say|Personally)\s*[,:]?\s*/i,
    ];

    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, "");
    }

    return cleaned.trim();
  }

  /**
   * Clean mentions from tweet text
   */
  private cleanMentions(text: string, username?: string): string {
    if (username) {
      const mentionPattern = new RegExp(`@${username}\\s*`, "gi");
      return text.replace(mentionPattern, "").trim();
    }
    // Remove all @mentions at the start of the text
    return text.replace(/^(@\w+\s*)+/, "").trim();
  }

  /**
   * Truncate text to fit Twitter's character limit
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;

    // Try to truncate at a sentence boundary
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let result = "";

    for (const sentence of sentences) {
      if ((result + sentence).length <= maxLength - 3) {
        result += sentence;
      } else {
        break;
      }
    }

    // If we couldn't fit any complete sentences, truncate at word boundary
    if (!result) {
      const words = text.split(/\s+/);
      for (const word of words) {
        if ((result + " " + word).length <= maxLength - 3) {
          result = result ? result + " " + word : word;
        } else {
          break;
        }
      }
    }

    return result.trim() + "...";
  }

  /**
   * Generate a content prompt for autonomous posting using templates
   */
  private generateContentPrompt(category?: keyof TwitterTemplates): string {
    // If no config or category specified, use casual as default
    if (!this.config) {
      const fallbackPrompts = [
        "Share an interesting tech fact or tip in a casual, engaging way",
        "Write a thought-provoking question about AI or technology",
        "Share a motivational thought about learning or creativity",
        "Write something witty about programming or digital life",
        "Share a helpful tip about productivity or workflow",
        "Write an observation about how technology shapes our daily lives",
        "Share an interesting perspective on innovation or the future",
        "Write something encouraging for developers or creators",
      ];
      const randomPrompt =
        randomChoice(fallbackPrompts) || fallbackPrompts[0];
      return `${randomPrompt}. Keep it under 280 characters, conversational, and engaging. No hashtags unless they're essential.`;
    }

    // Check if config and templates exist
    if (!this.config || !this.config.templates) {
      logger.warn(
        "Twitter config or templates not set, using fallback prompts",
      );
      const fallbackPrompts = [
        "Share a thought about what you've been working on recently",
        "Post about something interesting you learned today",
        "Share your perspective on a trending topic",
        "Talk about your current project or goals",
        "Share something that made you smile today",
      ];
      const randomPrompt =
        randomChoice(fallbackPrompts) || fallbackPrompts[0];
      return `${randomPrompt}. Keep it under 280 characters, conversational, and engaging. No hashtags unless they're essential.`;
    }

    // Select category (default to casual if not specified)
    const selectedCategory = category || "casual";
    const template = this.config.templates[selectedCategory];

    if (!template) {
      logger.warn(
        `Template category '${selectedCategory}' not found, falling back to casual`,
      );
      const casualTemplate = this.config.templates.casual;
      if (!casualTemplate) {
        logger.error("Casual template also not found, using fallback");
        const fallbackPrompts = [
          "Share a thought about what you've been working on recently",
          "Post about something interesting you learned today",
        ];
        const randomPrompt =
          randomChoice(fallbackPrompts) || fallbackPrompts[0];
        return `${randomPrompt}. Keep it under 280 characters, conversational, and engaging.`;
      }
      const randomPrompt =
        randomChoice(casualTemplate.prompts) || casualTemplate.prompts[0];
      return this.substituteParameters(randomPrompt, casualTemplate.parameters);
    }

    // Select random prompt from the category
    const randomPrompt =
      randomChoice(template.prompts) || template.prompts[0];

    // Substitute parameters in the prompt
    const finalPrompt = this.substituteParameters(
      randomPrompt,
      template.parameters,
    );

    // Add content guidelines
    const guidelines = this.config.contentGuidelines;
    let instruction =
      "Keep it under 280 characters, conversational, and engaging.";

    if (guidelines.includeEmojis) {
      instruction += " Include appropriate emojis.";
    }

    if (guidelines.mentionCommunity) {
      instruction += " Mention the community when relevant.";
    }

    if (guidelines.avoidSpam) {
      instruction += " Avoid spammy content.";
    }

    return `${finalPrompt} ${instruction}`;
  }

  /**
   * Substitute parameters in a prompt template
   */
  private substituteParameters(
    prompt: string,
    parameters: Record<string, string[]>,
  ): string {
    let result = prompt;

    // Find all parameter placeholders like {topic}, {time}, etc.
    const parameterRegex = /\{(\w+)\}/g;
    let match;

    while ((match = parameterRegex.exec(prompt)) !== null) {
      const paramName = match[1];
      const paramValues = parameters[paramName];

      if (paramValues && paramValues.length > 0) {
        // Replace with random value from the parameter array
        const randomValue =
          randomChoice(paramValues) || paramValues[0];
        result = result.replace(
          new RegExp(`\\{${paramName}\\}`, "g"),
          randomValue,
        );
      }
    }

    return result;
  }

  /**
   * Validate content before posting
   */
  validateContent(text: string): { valid: boolean; reason?: string } {
    if (!text || text.trim().length === 0) {
      return { valid: false, reason: "Content is empty" };
    }

    const maxLength =
      this.config?.contentGuidelines?.maxLength || this.MAX_TWEET_LENGTH;
    if (text.length > maxLength) {
      return { valid: false, reason: "Content exceeds character limit" };
    }

    // Check for potentially sensitive content patterns
    const sensitivePatterns = [
      /\b(password|token|key|secret|credential)\b/i,
      /\b\d{4,}\b/, // Long numbers that might be sensitive
      /@[a-zA-Z0-9_]{15,}/, // Very long mentions that might be spam
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(text)) {
        return {
          valid: false,
          reason: "Content may contain sensitive information",
        };
      }
    }

    return { valid: true };
  }

  /**
   * Generate a thirst trap image using ComfyUI
   * Returns the media URL if successful, null if failed
   */
  async generateThirstTrapImage(prompt?: string): Promise<{
    url: string;
    savedUrl?: string;
    presetId?: string;
  } | null> {
    try {
      // Default thirst trap image prompts if none provided
      const defaultPrompts = [
        "anime girl with pink hair, confident pose, colorful background, kawaii style",
        "cute anime character, playful expression, vibrant colors, modern style",
        "digital art portrait, attractive character, dynamic pose, professional lighting",
        "anime style portrait, stylish outfit, confident expression, detailed artwork",
      ];

      const imagePrompt =
        prompt ||
        randomChoice(defaultPrompts) || defaultPrompts[0];

      logger.info("Generating thirst trap image with ComfyUI", {
        prompt: imagePrompt.substring(0, 100),
      });

      // Call ComfyUI API to generate image
      // Access process.env via globalThis for environments where it may not be directly available
      const env = ((globalThis as Record<string, unknown>).process as { env?: Record<string, string> })?.env || {};
      const baseUrl = env.ADMIN_BASE_URL || "http://localhost:2000";
      const apiUrl = `${baseUrl}/admin/api/comfyui/image/generate`;

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: imagePrompt,
          width: 1024,
          height: 1024,
          steps: 20,
          cfg: 7,
        }),
      });

      if (!response.ok) {
        logger.error("ComfyUI image generation failed", {
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const result = await response.json();

      if (result.success && result.images && result.images.length > 0) {
        logger.info("ComfyUI image generated successfully", {
          imageUrl: result.images[0].url.substring(0, 100),
          saved: !!result.saved,
        });

        return {
          url: result.images[0].url,
          savedUrl: result.saved?.url,
          presetId: result.presetId,
        };
      }

      logger.warn("ComfyUI returned no images");
      return null;
    } catch (error) {
      logger.error("Failed to generate thirst trap image", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }
}
