import {
  createPluginModuleLogger,
} from "@phantasy/agent/plugin-runtime";
import { XService } from "./x-service";

type XNotificationType = "tweet_approval" | "reply_approval";

export interface XApprovalNotification {
  id: string;
  type: string;
  content: {
    text?: string;
    inReplyTo?: string;
  };
  externalIds?: Record<string, string>;
}

export interface XApprovalResult {
  platformPostId?: string;
}

const log = createPluginModuleLogger("XNotificationApprovals");

export function isXApprovalNotificationType(
  type: string,
): type is XNotificationType {
  return type === "tweet_approval" || type === "reply_approval";
}

export function getXRateLimitStatus() {
  return XService.getInstance().getRateLimitStatus();
}

export async function approveXNotification(
  notification: XApprovalNotification,
): Promise<XApprovalResult> {
  if (notification.type === "tweet_approval") {
    return handleTweetApproval(notification);
  }

  if (notification.type === "reply_approval") {
    return handleReplyApproval(notification);
  }

  return {};
}

async function handleTweetApproval(
  notification: XApprovalNotification,
): Promise<XApprovalResult> {
  try {
    log.info("Starting tweet approval handler", {
      notificationId: notification.id,
      notificationType: notification.type,
      hasContent: !!notification.content,
      textLength: notification.content?.text?.length,
    });

    if (!notification.content?.text) {
      const error = "Invalid notification: missing content or text";
      log.error("Tweet approval validation failed", {
        error,
        notificationId: notification.id,
      });
      throw new Error(error);
    }

    const xService = XService.getInstance();
    const tweetText = notification.content.text;
    log.info("Attempting to post approved tweet", {
      notificationId: notification.id,
      textPreview: `${tweetText.substring(0, 50)}...`,
      textLength: tweetText.length,
    });

    const result = await xService.tweet(tweetText);

    log.info("Approved tweet result received", {
      notificationId: notification.id,
      success: result.success,
      tweetId: result.tweetId,
      error: result.error,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to post approved tweet");
    }

    return {
      platformPostId: result.tweetId,
    };
  } catch (error: unknown) {
    log.error("Tweet approval failed", {
      notificationId: notification.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function handleReplyApproval(
  notification: XApprovalNotification,
): Promise<XApprovalResult> {
  try {
    const replyText = notification.content.text;
    if (!replyText) {
      throw new Error("Invalid notification: missing reply text");
    }

    const xService = XService.getInstance();
    const originalTweetId = notification.content.inReplyTo;

    if (!originalTweetId) {
      const result = await xService.tweet(replyText);
      if (!result.success) {
        throw new Error(
          result.error || "Failed to post approved reply as regular tweet",
        );
      }
      log.info("Approved reply posted as regular tweet", {
        notificationId: notification.id,
        tweetId: result.tweetId,
      });
      return {
        platformPostId: result.tweetId,
      };
    }

    const result = await xService.replyToTweet(originalTweetId, replyText);
    if (!result.success) {
      throw new Error(result.error || "Failed to post approved reply");
    }

    log.info("Approved reply posted successfully", {
      notificationId: notification.id,
      replyId: result.replyId,
      inReplyTo: originalTweetId,
    });
    return {
      platformPostId: result.replyId,
    };
  } catch (error: unknown) {
    log.error("Reply approval failed", {
      notificationId: notification.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
