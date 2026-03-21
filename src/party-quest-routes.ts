import {
  type AdminApiContext,
  type AdminApiResponse,
  createPluginModuleLogger,
  getRuntimePluginManager,
  kvService,
  type RouteHandler,
} from "@phantasy/agent/plugin-runtime";
import { XService } from "./x-service";
import { partyQuestAssignmentPollingEnabled } from "./party-quest-assignment-bridge";
import { partyQuestWorkflowAutoRunEnabled } from "./party-quest-workflow-runner";
import { PartyQuestSyncService } from "./party-quest-sync-service";
import {
  PARTY_QUEST_PHANTASY_ENDPOINT_PATHS,
  type PartyQuestSourceControlActionRequest,
  type PartyQuestTweetApprovedEvent,
  isPartyQuestTimestampValid,
  joinPartyQuestUrl,
  verifyPartyQuestSignature,
} from "./party-quest-protocol";

const logger = createPluginModuleLogger("PartyQuestRoutes");

function buildIntegrationReadiness(input: {
  partyQuestUrl: string | null;
  hasBootstrapToken: boolean;
  hasCharacterCardApiKey: boolean;
  hasTwitterCredentials: boolean;
  syncStatus: {
    hasDirectCredentials: boolean;
    hasOperationalCredentials: boolean;
    bootstrappedFromToken: boolean;
    lastSyncError: string | null;
    partyQuestAgentId: string | null;
    lastHeartbeatAt: number | null;
    lastHeartbeatError: string | null;
    lastHeartbeatStatus: "idle" | "busy" | "blocked" | null;
    lastHeartbeatMessage: string | null;
    lastHeartbeatRequestedAssignments: number | null;
  };
}): {
  configured: boolean;
  mode: "unconfigured" | "bootstrap" | "direct";
  status: "ready" | "bootstrap-pending" | "incomplete";
  checklist: Array<{ key: string; ok: boolean; message: string }>;
  missing: string[];
} {
  const checklist = [
    {
      key: "partyQuestUrl",
      ok: !!input.partyQuestUrl,
      message: input.partyQuestUrl
        ? "Party Quest URL configured"
        : "Set PARTY_QUEST_URL",
    },
    {
      key: "credentials",
      ok: input.syncStatus.hasOperationalCredentials || input.hasBootstrapToken,
      message: input.syncStatus.hasOperationalCredentials
        ? "Operational credentials available"
        : input.hasBootstrapToken
          ? "Bootstrap token available for first sync"
          : "Set PARTY_QUEST_API_KEY and PARTY_QUEST_WEBHOOK_SECRET or PARTY_QUEST_BOOTSTRAP_TOKEN",
    },
    {
      key: "twitterCredentials",
      ok: input.hasTwitterCredentials,
      message: input.hasTwitterCredentials
        ? "X/Twitter credentials configured"
        : "Configure X/Twitter credentials in Phantasy",
    },
    {
      key: "characterCardApiKey",
      ok: input.hasCharacterCardApiKey,
      message: input.hasCharacterCardApiKey
        ? "Character-card API key configured"
        : "Optional: set PARTY_QUEST_CHARACTER_CARD_API_KEY or CHARACTER_CARD_API_KEYS",
    },
    {
      key: "agentRegistration",
      ok: !!input.syncStatus.partyQuestAgentId,
      message: input.syncStatus.partyQuestAgentId
        ? "Runtime registered with Party Quest"
        : input.syncStatus.lastSyncError
          ? `Last sync failed: ${input.syncStatus.lastSyncError}`
          : "Runtime has not completed first sync yet",
    },
    {
      key: "runtimeHeartbeat",
      ok: !!input.syncStatus.lastHeartbeatAt && !input.syncStatus.lastHeartbeatError,
      message: input.syncStatus.lastHeartbeatAt
        ? `Runtime heartbeat recorded (${input.syncStatus.lastHeartbeatStatus || "idle"}; assignments ${input.syncStatus.lastHeartbeatRequestedAssignments === 0 ? "disabled" : "enabled"})`
        : input.syncStatus.lastHeartbeatError
          ? `Last runtime heartbeat failed: ${input.syncStatus.lastHeartbeatError}`
          : "Runtime has not sent a Party Quest heartbeat yet",
    },
  ];

  const configured =
    !!input.partyQuestUrl &&
    (input.syncStatus.hasOperationalCredentials || input.hasBootstrapToken) &&
    input.hasTwitterCredentials;

  const mode = !input.partyQuestUrl
    ? "unconfigured"
    : input.syncStatus.hasDirectCredentials || input.syncStatus.bootstrappedFromToken
      ? "direct"
      : input.hasBootstrapToken
        ? "bootstrap"
        : "unconfigured";

  const status = configured
    ? input.syncStatus.hasOperationalCredentials
      ? "ready"
      : "bootstrap-pending"
    : "incomplete";

  const missing = checklist
    .filter(
      (item) =>
        !item.ok &&
        item.key !== "characterCardApiKey" &&
        item.key !== "agentRegistration" &&
        item.key !== "runtimeHeartbeat",
    )
    .map((item) => item.key);

  return { configured, mode, status, checklist, missing };
}

function parseTweetApprovedPayload(rawBody: string): {
  ok: true;
  payload: PartyQuestTweetApprovedEvent;
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
    (parsed as PartyQuestTweetApprovedEvent).event !== "tweet.approved"
  ) {
    return { ok: false, error: "Unknown or invalid event payload" };
  }

  const payload = parsed as PartyQuestTweetApprovedEvent;
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

function parseSourceControlPayload(rawBody: string): {
  ok: true;
  payload: PartyQuestSourceControlActionRequest;
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

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Invalid source-control payload" };
  }

  const payload = parsed as PartyQuestSourceControlActionRequest;
  if (payload.provider !== "github" && payload.provider !== "gitlab") {
    return { ok: false, error: "Provider must be github or gitlab" };
  }

  if (payload.action === "create_issue") {
    if (typeof payload.title !== "string" || payload.title.trim().length === 0) {
      return { ok: false, error: "title is required" };
    }

    if (
      typeof payload.body !== "undefined" &&
      (typeof payload.body !== "string" || payload.body.trim().length === 0)
    ) {
      return { ok: false, error: "body must be a non-empty string when provided" };
    }

    if (
      typeof payload.labels !== "undefined" &&
      (!Array.isArray(payload.labels) ||
        payload.labels.some(
          (entry) => typeof entry !== "string" || entry.trim().length === 0,
        ))
    ) {
      return { ok: false, error: "labels must be an array of non-empty strings" };
    }

    return {
      ok: true,
      payload: {
        action: "create_issue",
        provider: payload.provider,
        title: payload.title.trim(),
        body: payload.body?.trim() || undefined,
        labels: payload.labels?.map((entry) => entry.trim()).filter(Boolean),
      },
    };
  }

  if (payload.action === "create_change_request") {
    if (typeof payload.title !== "string" || payload.title.trim().length === 0) {
      return { ok: false, error: "title is required" };
    }

    if (
      typeof payload.body !== "undefined" &&
      (typeof payload.body !== "string" || payload.body.trim().length === 0)
    ) {
      return { ok: false, error: "body must be a non-empty string when provided" };
    }

    if (
      typeof payload.sourceBranch !== "string" ||
      payload.sourceBranch.trim().length === 0
    ) {
      return { ok: false, error: "sourceBranch is required" };
    }

    if (
      typeof payload.targetBranch !== "undefined" &&
      (typeof payload.targetBranch !== "string" ||
        payload.targetBranch.trim().length === 0)
    ) {
      return {
        ok: false,
        error: "targetBranch must be a non-empty string when provided",
      };
    }

    return {
      ok: true,
      payload: {
        action: "create_change_request",
        provider: payload.provider,
        title: payload.title.trim(),
        body: payload.body?.trim() || undefined,
        sourceBranch: payload.sourceBranch.trim(),
        targetBranch: payload.targetBranch?.trim() || undefined,
        draft: payload.draft === true,
      },
    };
  }

  const issueNumber =
    typeof payload.issueNumber === "number" && Number.isInteger(payload.issueNumber)
      ? payload.issueNumber
      : undefined;
  const externalId =
    typeof payload.externalId === "string" && payload.externalId.trim().length > 0
      ? payload.externalId.trim()
      : undefined;

  if (payload.action === "read_issue" || payload.action === "read_change_request") {
    if (!issueNumber && !externalId) {
      return { ok: false, error: "issueNumber or externalId is required" };
    }

    return {
      ok: true,
      payload: {
        action: payload.action,
        provider: payload.provider,
        issueNumber,
        externalId,
      },
    };
  }

  if (
    payload.action !== "comment_issue" &&
    payload.action !== "comment_change_request"
  ) {
    return { ok: false, error: "Unsupported source-control action" };
  }

  if (
    typeof payload.body !== "string" ||
    payload.body.trim().length === 0
  ) {
    return { ok: false, error: "body is required" };
  }

  if (!issueNumber && !externalId) {
    return { ok: false, error: "issueNumber or externalId is required" };
  }

  return {
    ok: true,
    payload: {
      action: payload.action,
      provider: payload.provider,
      issueNumber,
      externalId,
      body: payload.body.trim(),
    },
  };
}

/**
 * PartyQuestRoutes - Handle webhooks from Party Quest
 *
 * Endpoints:
 * - POST /admin/api/webhooks/party-quest - Receive tweet approval callbacks
 * - GET /admin/api/integrations/party-quest/status - Get integration status
 */
export class PartyQuestRoutes implements RouteHandler {
  async handle(context: AdminApiContext): Promise<AdminApiResponse> {
    const { path, env, headers } = context;
    const method = context.request.method;

    // Handle tweet approval webhook from Party Quest
    if (path === PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.callback && method === "POST") {
      return this.handleTweetApprovalWebhook(context, env, headers);
    }

    // Get Party Quest integration status
    if (path === PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.status && method === "GET") {
      return this.getIntegrationStatus(context, env, headers);
    }

    if (
      path === PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.sourceControl &&
      method === "POST"
    ) {
      return this.handleSourceControlAction(context, env, headers);
    }

    return { handled: false, response: new Response("Not found", { status: 404 }) };
  }

  /**
   * Handle tweet approval callback from Party Quest
   *
   * Flow:
   * 1. Verify HMAC signature
   * 2. Validate timestamp to prevent replay attacks
   * 3. Post tweet using agent's Twitter credentials via XService
   * 4. Return twitterId to Party Quest
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
      logger.error("[PartyQuestRoutes] Failed to read request body:", error);
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
      context.request.headers.get("X-Party-Quest-Signature") ||
      context.request.headers.get("x-party-quest-signature") ||
      "";

    // Get webhook secret from environment
    const webhookSecret =
      env?.PARTY_QUEST_WEBHOOK_SECRET ||
      process.env.PARTY_QUEST_WEBHOOK_SECRET ||
      "";

    // Verify signature
    if (!verifyPartyQuestSignature(rawBody, signature, webhookSecret)) {
      logger.warn("[PartyQuestRoutes] Invalid webhook signature");
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
      logger.warn("[PartyQuestRoutes] Invalid payload:", parsedPayload.error);
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
    if (!isPartyQuestTimestampValid(payload.timestamp)) {
      logger.warn("[PartyQuestRoutes] Timestamp too old, possible replay attack");
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: "Request timestamp expired" }),
          { status: 400, headers: { "Content-Type": "application/json", ...headers } }
        ),
      };
    }

    logger.info("[PartyQuestRoutes] Received tweet approval webhook", {
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
        logger.error("[PartyQuestRoutes] Twitter credentials not configured");
        return {
          handled: true,
          response: new Response(
            JSON.stringify({
              success: false,
              error: "Twitter credentials not configured in Phantasy",
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
        logger.info("[PartyQuestRoutes] Tweet posted successfully", {
          twitterId: result.tweetId,
          partyQuestTweetId: payload.data.tweetId,
        });

        // Create a local notification record for bidirectional sync
        // This ensures Agent CMS knows about tweets approved via Party Quest
        try {
          const localNotification = {
            id: `party-quest_${payload.data.tweetId}_${Date.now()}`,
            type: "tweet_approval" as const,
            platform: "twitter" as const,
            source: "party-quest",
            status: "approved" as const,
            timestamp: new Date().toISOString(),
            content: {
              text: payload.data.content,
              media: payload.data.media,
            },
            externalIds: {
              partyQuestTweetId: payload.data.tweetId,
              twitterId: result.tweetId,
            },
            metadata: {
              agentId: payload.data.agentId,
              agentFrameworkId: payload.data.agentFrameworkId,
              frameworkType: payload.data.frameworkType,
              agentName: payload.data.agentName,
              twitterUsername: payload.data.twitterUsername,
              approvedBy: "party-quest",
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

          logger.info("[PartyQuestRoutes] Local notification record created", {
            notificationId: localNotification.id,
          });
        } catch (recordError) {
          // Log but don't fail - tweet was already posted successfully
          logger.warn("[PartyQuestRoutes] Failed to create local notification record", {
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
        logger.error("[PartyQuestRoutes] Failed to post tweet:", result.error);
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
      logger.error("[PartyQuestRoutes] Tweet posting error:", error);
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
   * Get Party Quest integration status
   */
  private async getIntegrationStatus(
    context: AdminApiContext,
    env: any,
    headers: Record<string, string>
  ): Promise<AdminApiResponse> {
    const partyQuestUrl = env?.PARTY_QUEST_URL || process.env.PARTY_QUEST_URL;
    const hasCharacterCardApiKey = !!(
      env?.PARTY_QUEST_CHARACTER_CARD_API_KEY ||
      process.env.PARTY_QUEST_CHARACTER_CARD_API_KEY ||
      process.env.CHARACTER_CARD_API_KEYS
    );
    const hasBootstrapToken = !!(
      env?.PARTY_QUEST_BOOTSTRAP_TOKEN || process.env.PARTY_QUEST_BOOTSTRAP_TOKEN
    );
    const baseUrl =
      env?.AGENT_FRAMEWORK_URL ||
      env?.BASE_URL ||
      process.env.AGENT_FRAMEWORK_URL ||
      process.env.BASE_URL ||
      `http://localhost:${process.env.ADMIN_PORT || 2000}`;
    const syncStatus = PartyQuestSyncService.getInstance().getStatus();

    // Check Twitter credentials
    const xService = XService.getInstance();
    const hasTwitterCredentials = await xService.hasCredentials();
    const readiness = buildIntegrationReadiness({
      partyQuestUrl: partyQuestUrl || null,
      hasBootstrapToken,
      hasCharacterCardApiKey,
      hasTwitterCredentials,
      syncStatus,
    });

    return {
      handled: true,
      response: new Response(
        JSON.stringify({
          configured: readiness.configured,
          mode: readiness.mode,
          partyQuestUrl: partyQuestUrl || null,
          hasApiKey: syncStatus.hasApiKey,
          hasWebhookSecret: syncStatus.hasWebhookSecret,
          hasCharacterCardApiKey,
          hasBootstrapToken,
          bootstrappedFromToken: syncStatus.bootstrappedFromToken,
          hasTwitterCredentials,
          checklist: readiness.checklist,
          missing: readiness.missing,
          endpoints: {
            callback: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.callback),
            characterCard: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.characterCard),
            health: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.health),
            status: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.status),
            sourceControl: joinPartyQuestUrl(
              baseUrl,
              PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.sourceControl,
            ),
          },
          heartbeat: {
            lastHeartbeatAt: syncStatus.lastHeartbeatAt,
            lastHeartbeatError: syncStatus.lastHeartbeatError,
            lastHeartbeatStatus: syncStatus.lastHeartbeatStatus,
            lastHeartbeatMessage: syncStatus.lastHeartbeatMessage,
            lastHeartbeatRequestedAssignments: syncStatus.lastHeartbeatRequestedAssignments,
            assignmentPollingEnabled: syncStatus.lastHeartbeatRequestedAssignments !== 0,
          },
          runtime: {
            assignmentPollingConfigured: partyQuestAssignmentPollingEnabled(),
            workflowAutoRunEnabled: partyQuestWorkflowAutoRunEnabled(),
          },
          syncStatus,
          status: readiness.status,
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...headers } }
      ),
    };
  }

  private async handleSourceControlAction(
    context: AdminApiContext,
    env: any,
    headers: Record<string, string>,
  ): Promise<AdminApiResponse> {
    const apiKey =
      context.request.headers.get("X-API-Key") ||
      context.request.headers.get("x-api-key") ||
      "";
    const webhookSecret =
      env?.PARTY_QUEST_WEBHOOK_SECRET ||
      process.env.PARTY_QUEST_WEBHOOK_SECRET ||
      "";

    if (!webhookSecret || apiKey !== webhookSecret) {
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: "Unauthorized: Provide a valid X-API-Key header",
          }),
          { status: 401, headers: { "Content-Type": "application/json", ...headers } },
        ),
      };
    }

    let rawBody = "";
    try {
      rawBody = await context.request.clone().text();
    } catch {
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: "Failed to read request body" }),
          { status: 400, headers: { "Content-Type": "application/json", ...headers } },
        ),
      };
    }

    const parsedPayload = parseSourceControlPayload(rawBody);
    if (!parsedPayload.ok) {
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: parsedPayload.error }),
          { status: 400, headers: { "Content-Type": "application/json", ...headers } },
        ),
      };
    }

    const pluginManager = await getRuntimePluginManager();
    const plugin = pluginManager.getPlugin(parsedPayload.payload.provider);
    if (!plugin) {
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: `${parsedPayload.payload.provider} integration is not installed`,
          }),
          { status: 503, headers: { "Content-Type": "application/json", ...headers } },
        ),
      };
    }

    let pluginPath = "/issues/create";
    let pluginRequestBody: Record<string, unknown>;
    if (parsedPayload.payload.action === "create_change_request") {
      pluginPath = "/changes/create";
      pluginRequestBody = {
        title: parsedPayload.payload.title,
        body: parsedPayload.payload.body,
        sourceBranch: parsedPayload.payload.sourceBranch,
        targetBranch: parsedPayload.payload.targetBranch,
        draft: parsedPayload.payload.draft,
      };
    } else if (parsedPayload.payload.action === "comment_issue") {
      pluginPath = "/issues/comment";
      pluginRequestBody = {
        issueNumber: parsedPayload.payload.issueNumber,
        externalId: parsedPayload.payload.externalId,
        body: parsedPayload.payload.body,
      };
    } else if (parsedPayload.payload.action === "comment_change_request") {
      pluginPath = "/changes/comment";
      pluginRequestBody = {
        issueNumber: parsedPayload.payload.issueNumber,
        externalId: parsedPayload.payload.externalId,
        body: parsedPayload.payload.body,
      };
    } else if (parsedPayload.payload.action === "read_change_request") {
      pluginPath = "/changes/read";
      pluginRequestBody = {
        issueNumber: parsedPayload.payload.issueNumber,
        externalId: parsedPayload.payload.externalId,
      };
    } else if (parsedPayload.payload.action === "read_issue") {
      pluginPath = "/issues/read";
      pluginRequestBody = {
        issueNumber: parsedPayload.payload.issueNumber,
        externalId: parsedPayload.payload.externalId,
      };
    } else {
      pluginRequestBody = {
        title: parsedPayload.payload.title,
        body: parsedPayload.payload.body,
        labels: parsedPayload.payload.labels,
      };
    }

    const pluginRequest = new Request(`http://localhost${pluginPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pluginRequestBody),
    });
    const pluginResponse = await plugin.handleCustomEndpoint(
      pluginRequest,
      pluginPath,
    );

    if (!pluginResponse) {
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: `${parsedPayload.payload.provider} integration does not support this source-control action`,
          }),
          { status: 501, headers: { "Content-Type": "application/json", ...headers } },
        ),
      };
    }

    const responseText = await pluginResponse.text();
    return {
      handled: true,
      response: new Response(responseText, {
        status: pluginResponse.status,
        headers: {
          "Content-Type":
            pluginResponse.headers.get("Content-Type") || "application/json",
          ...headers,
        },
      }),
    };
  }
}
