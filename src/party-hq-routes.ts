import {
  type AdminApiContext,
  type AdminApiResponse,
  createPluginModuleLogger,
  kvService,
  type RouteHandler,
} from "@phantasy/agent/plugin-runtime";
import { XService } from "./x-service";
import { PartyHQSyncService } from "./party-hq-sync-service";
import {
  PARTY_HQ_PHANTASY_ENDPOINT_PATHS,
  type PartyHQTweetApprovedEvent,
  isPartyHQTimestampValid,
  joinPartyHQUrl,
  verifyPartyHQSignature,
} from "./party-hq-protocol";

const logger = createPluginModuleLogger("PartyHQRoutes");

function parseTweetApprovedPayload(rawBody: string): {
  ok: true;
  payload: PartyHQTweetApprovedEvent;
} | {
  ok: false;
  error: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "Invalid JSON payload" };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as PartyHQTweetApprovedEvent).event !== "tweet.approved"
  ) {
    return { ok: false, error: "Unknown or invalid event payload" };
  }

  const payload = parsed as PartyHQTweetApprovedEvent;
  if (
    !payload.data?.tweetId ||
    !payload.data?.agentId ||
    !payload.data?.agentFrameworkId ||
    !payload.data?.content
  ) {
    return { ok: false, error: "Missing required tweet approval fields" };
  }

  return { ok: true, payload };
}

/**
 * PartyHQRoutes - Handle webhooks from Party-HQ
 *
 * Endpoints:
 * - POST /admin/api/webhooks/party-hq - Receive tweet approval callbacks
 * - GET /admin/api/integrations/party-hq/status - Get integration status
 */
export class PartyHQRoutes implements RouteHandler {
  async handle(context: AdminApiContext): Promise<AdminApiResponse> {
    const { path, env, headers } = context;
    const method = context.request.method;

    // Handle tweet approval webhook from Party-HQ
    if (path === PARTY_HQ_PHANTASY_ENDPOINT_PATHS.callback && method === "POST") {
      return this.handleTweetApprovalWebhook(context, env, headers);
    }

    // Get Party-HQ integration status
    if (path === PARTY_HQ_PHANTASY_ENDPOINT_PATHS.status && method === "GET") {
      return this.getIntegrationStatus(context, env, headers);
    }

    return { handled: false, response: new Response("Not found", { status: 404 }) };
  }

  /**
   * Handle tweet approval callback from Party-HQ
   *
   * Flow:
   * 1. Verify HMAC signature
   * 2. Validate timestamp to prevent replay attacks
   * 3. Post tweet using agent's Twitter credentials via XService
   * 4. Return twitterId to Party-HQ
   */
  private async handleTweetApprovalWebhook(
    context: AdminApiContext,
    env: any,
    headers: Record<string, string>
  ): Promise<AdminApiResponse> {
    let rawBody = "";
    try {
      rawBody = await context.request.clone().text();
    } catch (error) {
      logger.error("[PartyHQRoutes] Failed to read request body:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: "Failed to read request body" }),
          { status: 400, headers: { "Content-Type": "application/json", ...headers } }
        ),
      };
    }

    // Get signature from header
    const signature =
      context.request.headers.get("X-Party-HQ-Signature") ||
      context.request.headers.get("x-party-hq-signature") ||
      "";

    // Get webhook secret from environment
    const webhookSecret =
      env?.PARTY_HQ_WEBHOOK_SECRET ||
      process.env.PARTY_HQ_WEBHOOK_SECRET ||
      "";

    // Verify signature
    if (!verifyPartyHQSignature(rawBody, signature, webhookSecret)) {
      logger.warn("[PartyHQRoutes] Invalid webhook signature");
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: "Invalid signature" }),
          { status: 401, headers: { "Content-Type": "application/json", ...headers } }
        ),
      };
    }

    // Parse payload
    const parsedPayload = parseTweetApprovedPayload(rawBody);
    if (!parsedPayload.ok) {
      logger.warn("[PartyHQRoutes] Invalid payload:", parsedPayload.error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: parsedPayload.error }),
          { status: 400, headers: { "Content-Type": "application/json", ...headers } }
        ),
      };
    }
    const payload = parsedPayload.payload;

    // Validate timestamp (prevent replay attacks)
    if (!isPartyHQTimestampValid(payload.timestamp)) {
      logger.warn("[PartyHQRoutes] Timestamp too old, possible replay attack");
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: "Request timestamp expired" }),
          { status: 400, headers: { "Content-Type": "application/json", ...headers } }
        ),
      };
    }

    logger.info("[PartyHQRoutes] Received tweet approval webhook", {
      tweetId: payload.data.tweetId,
      agentFrameworkId: payload.data.agentFrameworkId,
      frameworkType: payload.data.frameworkType || "unknown",
      contentLength: payload.data.content.length,
      hasMedia: !!(payload.data.media && payload.data.media.length > 0),
    });

    // Post the tweet using XService
    try {
      const xService = XService.getInstance();

      // Check if XService has credentials
      const hasCredentials = await xService.hasCredentials();
      if (!hasCredentials) {
        logger.error("[PartyHQRoutes] Twitter credentials not configured");
        return {
          handled: true,
          response: new Response(
            JSON.stringify({
              success: false,
              error: "Twitter credentials not configured in agent framework",
            }),
            { status: 503, headers: { "Content-Type": "application/json", ...headers } }
          ),
        };
      }

      // Extract media URLs if present
      const mediaUrls = payload.data.media?.map((m) => m.url);

      // Post the tweet
      const result = await xService.tweet(payload.data.content, {
        mediaUrls: mediaUrls && mediaUrls.length > 0 ? mediaUrls : undefined,
      });

      if (result.success && result.tweetId) {
        logger.info("[PartyHQRoutes] Tweet posted successfully", {
          twitterId: result.tweetId,
          partyHQTweetId: payload.data.tweetId,
        });

        // Create a local notification record for bidirectional sync
        // This ensures Agent CMS knows about tweets approved via Party-HQ
        try {
          const localNotification = {
            id: `party-hq_${payload.data.tweetId}_${Date.now()}`,
            type: "tweet_approval" as const,
            platform: "twitter" as const,
            source: "party-hq",
            status: "approved" as const,
            timestamp: new Date().toISOString(),
            content: {
              text: payload.data.content,
              media: payload.data.media,
            },
            externalIds: {
              partyHQTweetId: payload.data.tweetId,
              twitterId: result.tweetId,
            },
            metadata: {
              agentId: payload.data.agentId,
              agentFrameworkId: payload.data.agentFrameworkId,
              frameworkType: payload.data.frameworkType,
              agentName: payload.data.agentName,
              twitterUsername: payload.data.twitterUsername,
              approvedBy: "party-hq",
              approvedAt: new Date().toISOString(),
              postedAt: new Date().toISOString(),
            },
          };

          const existingNotifications = ((await kvService.get("notifications")) as {
            notifications: any[];
          }) || { notifications: [] };

          existingNotifications.notifications.unshift(localNotification);

          // Keep only last 100 notifications
          if (existingNotifications.notifications.length > 100) {
            existingNotifications.notifications = existingNotifications.notifications.slice(0, 100);
          }

          await kvService.set("notifications", existingNotifications);

          logger.info("[PartyHQRoutes] Local notification record created", {
            notificationId: localNotification.id,
          });
        } catch (recordError) {
          // Log but don't fail - tweet was already posted successfully
          logger.warn("[PartyHQRoutes] Failed to create local notification record", {
            error: recordError,
          });
        }

        return {
          handled: true,
          response: new Response(
            JSON.stringify({
              success: true,
              twitterId: result.tweetId,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...headers } }
          ),
        };
      } else {
        logger.error("[PartyHQRoutes] Failed to post tweet:", result.error);
        return {
          handled: true,
          response: new Response(
            JSON.stringify({
              success: false,
              error: result.error || "Failed to post tweet",
            }),
            { status: 500, headers: { "Content-Type": "application/json", ...headers } }
          ),
        };
      }
    } catch (error: unknown) {
      logger.error("[PartyHQRoutes] Tweet posting error:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: (error instanceof Error ? error.message : String(error)) || "Internal server error",
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...headers } }
        ),
      };
    }
  }

  /**
   * Get Party-HQ integration status
   */
  private async getIntegrationStatus(
    context: AdminApiContext,
    env: any,
    headers: Record<string, string>
  ): Promise<AdminApiResponse> {
    const partyHQUrl = env?.PARTY_HQ_URL || process.env.PARTY_HQ_URL;
    const hasApiKey = !!(env?.PARTY_HQ_API_KEY || process.env.PARTY_HQ_API_KEY);
    const hasWebhookSecret = !!(
      env?.PARTY_HQ_WEBHOOK_SECRET || process.env.PARTY_HQ_WEBHOOK_SECRET
    );
    const hasCharacterCardApiKey = !!(
      env?.PARTY_HQ_CHARACTER_CARD_API_KEY ||
      process.env.PARTY_HQ_CHARACTER_CARD_API_KEY ||
      process.env.CHARACTER_CARD_API_KEYS
    );
    const hasBootstrapToken = !!(
      env?.PARTY_HQ_BOOTSTRAP_TOKEN || process.env.PARTY_HQ_BOOTSTRAP_TOKEN
    );
    const baseUrl =
      env?.AGENT_FRAMEWORK_URL ||
      env?.BASE_URL ||
      process.env.AGENT_FRAMEWORK_URL ||
      process.env.BASE_URL ||
      `http://localhost:${process.env.ADMIN_PORT || 2000}`;
    const syncStatus = PartyHQSyncService.getInstance().getStatus();

    // Check Twitter credentials
    const xService = XService.getInstance();
    const hasTwitterCredentials = await xService.hasCredentials();
    const hasProvisioning = hasApiKey && hasWebhookSecret;
    const ready = !!(partyHQUrl && (hasProvisioning || hasBootstrapToken) && hasTwitterCredentials);

    return {
      handled: true,
      response: new Response(
        JSON.stringify({
          configured: ready,
          partyHQUrl: partyHQUrl || null,
          hasApiKey,
          hasWebhookSecret,
          hasCharacterCardApiKey,
          hasBootstrapToken,
          bootstrappedFromToken: syncStatus.bootstrappedFromToken,
          hasTwitterCredentials,
          endpoints: {
            callback: joinPartyHQUrl(baseUrl, PARTY_HQ_PHANTASY_ENDPOINT_PATHS.callback),
            characterCard: joinPartyHQUrl(baseUrl, PARTY_HQ_PHANTASY_ENDPOINT_PATHS.characterCard),
            health: joinPartyHQUrl(baseUrl, PARTY_HQ_PHANTASY_ENDPOINT_PATHS.health),
            status: joinPartyHQUrl(baseUrl, PARTY_HQ_PHANTASY_ENDPOINT_PATHS.status),
          },
          status: ready
            ? (hasProvisioning ? "ready" : "bootstrap-pending")
            : "incomplete",
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...headers } }
      ),
    };
  }
}
