import {
  createPluginModuleLogger,
} from "@phantasy/agent/plugin-runtime";
import { partyQuestSyncService } from "./party-quest-sync-service";
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

const log = createPluginModuleLogger("XNotificationApprovals");

export function isXApprovalNotificationType(
  type: string,
): type is XNotificationType {
  return type === "tweet_approval" || type === "reply_approval";
}

export {
  approvePartyQuestAssignmentNotification,
  isPartyQuestAssignmentNotificationType,
  rejectPartyQuestAssignmentNotification,
} from "./party-quest-assignment-bridge";

export function getXRateLimitStatus() {
  return XService.getInstance().getRateLimitStatus();
}

export async function approveXNotification(
  notification: XApprovalNotification,
): Promise<void> {
  if (notification.type === "tweet_approval") {
    await handleTweetApproval(notification);
    return;
  }

  if (notification.type === "reply_approval") {
    await handleReplyApproval(notification);
  }
}

async function handleTweetApproval(
  notification: XApprovalNotification,
): Promise<void> {
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

    if (
      notification.externalIds?.partyQuestTweetId &&
      partyQuestSyncService.isConfigured()
    ) {
      const syncResult = await partyQuestSyncService.notifyApproval({
        tweetId: notification.externalIds.partyQuestTweetId,
        twitterId: result.tweetId,
        approvedAt: Date.now(),
        approvedBy: "agent-cms",
      });

      if (!syncResult.success) {
        log.warn("Failed to sync tweet approval to Party Quest", {
          notificationId: notification.id,
          error: syncResult.error,
        });
      }
    }
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
): Promise<void> {
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
      return;
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

    if (
      notification.externalIds?.partyQuestTweetId &&
      partyQuestSyncService.isConfigured()
    ) {
      const syncResult = await partyQuestSyncService.notifyApproval({
        tweetId: notification.externalIds.partyQuestTweetId,
        twitterId: result.replyId,
        approvedAt: Date.now(),
        approvedBy: "agent-cms",
      });

      if (!syncResult.success) {
        log.warn("Failed to sync reply approval to Party Quest", {
          notificationId: notification.id,
          error: syncResult.error,
        });
      }
    }
  } catch (error: unknown) {
    log.error("Reply approval failed", {
      notificationId: notification.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
