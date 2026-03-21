import {
  createPluginModuleLogger,
  fetchWithTimeout,
  getTwitterIntegrationUsername,
  type AgentConfig,
} from "@phantasy/agent/plugin-runtime";
import {
  PARTY_QUEST_CONTROL_PATHS,
  PARTY_QUEST_PHANTASY_CAPABILITIES,
  PARTY_QUEST_PROTOCOL_VERSION,
  PARTY_QUEST_WEBHOOK_PATHS,
  buildPhantasyEndpointMap,
  joinPartyQuestUrl,
  type PartyQuestAgentSyncPayload,
  type PartyQuestBootstrapExchangeResponse,
  type PartyQuestHeartbeatRequest,
  type PartyQuestHeartbeatResponse,
  type PartyQuestMessagePayload,
  type PartyQuestRunResultRequest,
  type PartyQuestRunTraceRequest,
  type PartyQuestSourceControlSyncRequest,
  type PartyQuestSourceControlSyncResponse,
  type PartyQuestTweetStatusUpdateEvent,
  type PartyQuestTweetSubmissionPayload,
} from "./party-quest-protocol";

const logger = createPluginModuleLogger("PartyQuestSyncService");

/**
 * Party Quest Sync Service
 *
 * Handles synchronization of agent data with Party Quest for the multi-agent
 * management dashboard. This service:
 * - Syncs agent configuration to Party Quest on startup
 * - Registers callback URLs for the tweet approval workflow
 * - Sends orchestration heartbeats, traces, and final run results
 * - Handles periodic health checks
 *
 * @example
 * ```typescript
 * const syncService = PartyQuestSyncService.getInstance();
 *
 * // Sync agent data to Party Quest
 * await syncService.syncAgent(agentConfig);
 *
 * // Check if Party Quest is configured
 * if (syncService.isConfigured()) {
 *   console.log("Party Quest integration is ready");
 * }
 * ```
 */
export class PartyQuestSyncService {
  private static instance: PartyQuestSyncService | null = null;

  private partyQuestUrl: string | null = null;
  private apiKey: string | null = null;
  private webhookSecret: string | null = null;
  private characterCardApiKey: string | null = null;
  private bootstrapToken: string | null = null;
  private frameworkBaseUrl: string | null = null;
  private bootstrappedFromToken = false;
  private bootstrapPromise: Promise<boolean> | null = null;

  // Sync state tracking
  private lastSyncAt: number | null = null;
  private lastSyncError: string | null = null;
  private partyQuestAgentId: string | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastHeartbeatError: string | null = null;
  private lastHeartbeatStatus: PartyQuestHeartbeatRequest["status"] | null = null;
  private lastHeartbeatMessage: string | null = null;
  private lastHeartbeatRequestedAssignments: number | null = null;

  private getAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey!,
    };
  }

  private resolveCharacterCardApiKey(): string | null {
    const explicitKey = process.env.PARTY_QUEST_CHARACTER_CARD_API_KEY?.trim();
    if (explicitKey) {
      return explicitKey;
    }

    const configuredKeys = (process.env.CHARACTER_CARD_API_KEYS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    return configuredKeys[0] || null;
  }

  private hasDirectCredentials(): boolean {
    return !!(this.partyQuestUrl && this.apiKey && this.webhookSecret);
  }

  private async ensureOperationalCredentials(): Promise<boolean> {
    if (this.hasDirectCredentials()) {
      return true;
    }

    if (!this.partyQuestUrl || !this.bootstrapToken) {
      return false;
    }

    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.exchangeBootstrapToken();
    }

    try {
      return await this.bootstrapPromise;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  private async exchangeBootstrapToken(): Promise<boolean> {
    if (!this.partyQuestUrl || !this.bootstrapToken) {
      return false;
    }

    try {
      const response = await fetchWithTimeout(
        joinPartyQuestUrl(this.partyQuestUrl, PARTY_QUEST_CONTROL_PATHS.bootstrapExchange),
        {
          timeout: 15000,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: this.bootstrapToken }),
        },
      );

      const payload = (await response.json().catch(() => null)) as
        | PartyQuestBootstrapExchangeResponse
        | null;

      if (!response.ok || !payload?.success || !payload.apiKey || !payload.callbackSecret) {
        const error =
          payload?.error ||
          response.statusText ||
          "Bootstrap exchange failed";
        logger.error("[PartyQuestSyncService] Bootstrap exchange failed", {
          status: response.status,
          error,
        });
        this.lastSyncError = error;
        return false;
      }

      this.apiKey = payload.apiKey;
      this.webhookSecret = payload.callbackSecret;
      this.bootstrappedFromToken = true;
      this.bootstrapToken = null;

      logger.info("[PartyQuestSyncService] Bootstrapped Party Quest runtime credentials");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bootstrap exchange failed";
      logger.error("[PartyQuestSyncService] Bootstrap exchange error", {
        error: message,
      });
      this.lastSyncError = message;
      return false;
    }
  }

  private async postAuthenticatedJson<TResponse extends {
    success?: boolean;
    error?: string;
    message?: string;
  }>(
    pathname: string,
    payload: unknown,
    timeout = 15000,
  ): Promise<
    | {
        ok: true;
        data: TResponse;
      }
    | {
        ok: false;
        error: string;
        status?: number;
        data?: TResponse;
      }
  > {
    if (!(await this.ensureOperationalCredentials())) {
      return { ok: false, error: "Party Quest not configured" };
    }

    try {
      const response = await fetchWithTimeout(
        joinPartyQuestUrl(this.partyQuestUrl!, pathname),
        {
          timeout,
          method: "POST",
          headers: this.getAuthHeaders(),
          body: JSON.stringify(payload),
        },
      );

      const responseText = await response.text();
      let responseData: TResponse;

      try {
        responseData = JSON.parse(responseText) as TResponse;
      } catch {
        responseData = { error: responseText } as TResponse;
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error:
            responseData.error ||
            responseData.message ||
            `HTTP ${response.status}`,
          data: responseData,
        };
      }

      if (responseData.success === false) {
        return {
          ok: false,
          status: response.status,
          error: responseData.error || responseData.message || "Unknown error",
          data: responseData,
        };
      }

      return { ok: true, data: responseData };
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Network error",
      };
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(): PartyQuestSyncService {
    if (!PartyQuestSyncService.instance) {
      PartyQuestSyncService.instance = new PartyQuestSyncService();
    }
    return PartyQuestSyncService.instance;
  }

  private constructor() {
    this.loadConfiguration();
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfiguration(): void {
    this.partyQuestUrl = process.env.PARTY_QUEST_URL || null;
    this.apiKey = process.env.PARTY_QUEST_API_KEY || null;
    this.webhookSecret = process.env.PARTY_QUEST_WEBHOOK_SECRET || null;
    this.characterCardApiKey = this.resolveCharacterCardApiKey();
    this.bootstrapToken = process.env.PARTY_QUEST_BOOTSTRAP_TOKEN || null;
    this.frameworkBaseUrl = process.env.AGENT_FRAMEWORK_URL ||
      process.env.BASE_URL ||
      `http://localhost:${process.env.ADMIN_PORT || 2000}`;
    this.bootstrappedFromToken = false;

    if (this.partyQuestUrl) {
      // Normalize URL (remove trailing slash)
      this.partyQuestUrl = this.partyQuestUrl.replace(/\/$/, "");
    }

    logger.debug("[PartyQuestSyncService] Configuration loaded", {
      hasUrl: !!this.partyQuestUrl,
      hasApiKey: !!this.apiKey,
      hasWebhookSecret: !!this.webhookSecret,
      hasCharacterCardApiKey: !!this.characterCardApiKey,
      hasBootstrapToken: !!this.bootstrapToken,
      frameworkBaseUrl: this.frameworkBaseUrl,
    });
  }

  /**
   * Reload configuration (e.g., after environment changes)
   */
  reloadConfiguration(): void {
    this.loadConfiguration();
    logger.info("[PartyQuestSyncService] Configuration reloaded");
  }

  /**
   * Check if Party Quest integration is configured
   */
  isConfigured(): boolean {
    return !!(
      this.partyQuestUrl &&
      ((this.apiKey && this.webhookSecret) || this.bootstrapToken)
    );
  }

  /**
   * Get current sync status
   */
  getStatus(): {
    configured: boolean;
    lastSyncAt: number | null;
    lastSyncError: string | null;
    partyQuestAgentId: string | null;
    lastHeartbeatAt: number | null;
    lastHeartbeatError: string | null;
    lastHeartbeatStatus: PartyQuestHeartbeatRequest["status"] | null;
    lastHeartbeatMessage: string | null;
    lastHeartbeatRequestedAssignments: number | null;
    partyQuestUrl: string | null;
    frameworkBaseUrl: string | null;
    hasApiKey: boolean;
    hasWebhookSecret: boolean;
    hasDirectCredentials: boolean;
    hasCharacterCardApiKey: boolean;
    hasBootstrapToken: boolean;
    hasOperationalCredentials: boolean;
    bootstrappedFromToken: boolean;
  } {
    return {
      configured: this.isConfigured(),
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      partyQuestAgentId: this.partyQuestAgentId,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatError: this.lastHeartbeatError,
      lastHeartbeatStatus: this.lastHeartbeatStatus,
      lastHeartbeatMessage: this.lastHeartbeatMessage,
      lastHeartbeatRequestedAssignments: this.lastHeartbeatRequestedAssignments,
      partyQuestUrl: this.partyQuestUrl,
      frameworkBaseUrl: this.frameworkBaseUrl,
      hasApiKey: !!this.apiKey,
      hasWebhookSecret: !!this.webhookSecret,
      hasDirectCredentials: this.hasDirectCredentials(),
      hasCharacterCardApiKey: !!this.characterCardApiKey,
      hasBootstrapToken: !!this.bootstrapToken,
      hasOperationalCredentials: this.hasDirectCredentials(),
      bootstrappedFromToken: this.bootstrappedFromToken,
    };
  }

  /**
   * Sync agent configuration to Party Quest
   *
   * This registers/updates the agent in Party Quest and configures the callback
   * URL for the tweet approval workflow.
   *
   * @param agentConfig - The agent configuration to sync
   * @returns Promise with sync result
   */
  async syncAgent(agentConfig: Partial<AgentConfig>): Promise<{
    success: boolean;
    agentId?: string;
    error?: string;
  }> {
    if (!(await this.ensureOperationalCredentials())) {
      if (this.partyQuestUrl || this.apiKey || this.webhookSecret || this.bootstrapToken) {
        return {
          success: false,
          error: this.lastSyncError || "Party Quest credentials are incomplete",
        };
      }
      logger.debug("[PartyQuestSyncService] Not configured, skipping sync");
      return { success: true }; // Not an error, just not configured
    }

    const agentFrameworkId =
      agentConfig.id ||
      process.env.AGENT_ID ||
      "default-agent";
    const baseEndpoints = buildPhantasyEndpointMap(this.frameworkBaseUrl!);
    const endpoints = this.characterCardApiKey
      ? baseEndpoints
      : {
          callback: baseEndpoints.callback,
          health: baseEndpoints.health,
          status: baseEndpoints.status,
          sourceControl: baseEndpoints.sourceControl,
        };
    const capabilities = this.characterCardApiKey
      ? [...PARTY_QUEST_PHANTASY_CAPABILITIES]
      : PARTY_QUEST_PHANTASY_CAPABILITIES.filter(
          (capability) => capability !== "character-card",
        );

    // Derive avatar URL from unified avatars config
    const avatarUrl =
      agentConfig.avatars?.static?.url ||
      agentConfig.avatars?.pngtuber?.url ||
      null;

    const payload: PartyQuestAgentSyncPayload = {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      agentFrameworkId,
      name: agentConfig.name || "AI Agent",
      bio: agentConfig.personality || "",
      avatarUrl,
      callbackUrl: endpoints.callback,
      callbackSecret: this.webhookSecret!,
      characterCardApiKey: this.characterCardApiKey || undefined,
      twitterUsername: getTwitterIntegrationUsername(agentConfig) || null,
      frameworkType: "phantasy" as const,
      frameworkVersion: process.env.npm_package_version || "2.0.0",
      capabilities,
      endpoints,
    };

    logger.info("[PartyQuestSyncService] Syncing agent to Party Quest", {
      agentFrameworkId,
      callbackUrl: endpoints.callback,
      name: payload.name,
    });

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      agentId?: string;
      error?: string;
      message?: string;
    }>(PARTY_QUEST_WEBHOOK_PATHS.agentSync, payload);

    if (!result.ok) {
      const errorMessage = result.error;
      logger.error("[PartyQuestSyncService] Sync request failed", {
        error: errorMessage,
        status: result.status,
      });
      this.lastSyncError = errorMessage;
      return { success: false, error: errorMessage };
    }

    this.lastSyncAt = Date.now();
    this.lastSyncError = null;
    this.partyQuestAgentId = result.data.agentId || null;

    logger.info("[PartyQuestSyncService] ✅ Agent synced successfully", {
      agentId: this.partyQuestAgentId,
    });

    return { success: true, agentId: this.partyQuestAgentId || undefined };
  }

  /**
   * Submit a tweet to Party Quest for approval
   *
   * Use this to queue tweets for human review before posting.
   *
   * @param content - Tweet content
   * @param mediaUrls - Optional media attachments
   * @returns Promise with submission result
   */
  async submitTweet(
    content: string,
    mediaUrls?: Array<{ url: string; mimeType: string }>
  ): Promise<{
    success: boolean;
    tweetId?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party Quest not configured" };
    }

    logger.info("[PartyQuestSyncService] Submitting tweet for approval", {
      contentLength: content.length,
      hasMedia: !!(mediaUrls && mediaUrls.length > 0),
    });

    const payload: PartyQuestTweetSubmissionPayload = {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      content,
      mediaUrls: mediaUrls || [],
    };

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      tweetId?: string;
      error?: string;
    }>(PARTY_QUEST_WEBHOOK_PATHS.tweet, payload);

    if (!result.ok) {
      logger.error("[PartyQuestSyncService] Tweet submission failed", {
        status: result.status,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    if (!result.data.tweetId) {
      return { success: false, error: result.data.error || "Missing tweetId" };
    }

    logger.info("[PartyQuestSyncService] ✅ Tweet submitted successfully", {
      tweetId: result.data.tweetId,
    });
    return { success: true, tweetId: result.data.tweetId };
  }

  /**
   * Notify Party Quest that a tweet was approved/posted locally
   *
   * This enables bidirectional sync - when a tweet is approved in the Agent CMS,
   * Party Quest is notified so it can update its status (mark as "posted").
   *
   * @param params - Approval notification parameters
   * @returns Promise with notification result
   */
  async notifyApproval(params: {
    tweetId: string;        // Party Quest tweet ID (from externalIds.partyQuestTweetId)
    twitterId?: string;     // Posted Twitter tweet ID
    approvedAt: number;     // Timestamp of approval
    approvedBy: string;     // Source of approval (e.g., "agent-cms")
  }): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      logger.debug("[PartyQuestSyncService] Not configured, skipping approval notification");
      return { success: true }; // Not an error, just not configured
    }

    logger.info("[PartyQuestSyncService] Notifying Party Quest of local approval", {
      tweetId: params.tweetId,
      twitterId: params.twitterId,
      approvedBy: params.approvedBy,
    });

    const payload: PartyQuestTweetStatusUpdateEvent = {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      event: "tweet.status_update",
      timestamp: Date.now(),
      data: {
        tweetId: params.tweetId,
        status: "posted",
        twitterId: params.twitterId || null,
        approvedAt: params.approvedAt,
        approvedBy: params.approvedBy,
      },
    };

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      error?: string;
    }>(PARTY_QUEST_WEBHOOK_PATHS.tweetStatus, payload);

    if (!result.ok) {
      logger.error("[PartyQuestSyncService] Approval notification failed", {
        status: result.status,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    logger.info("[PartyQuestSyncService] ✅ Party Quest notified of approval", {
      tweetId: params.tweetId,
    });
    return { success: true };
  }

  /**
   * Send a message to the agent's channel in Party Quest
   *
   * @param content - Message content
   * @param channelId - Optional specific channel ID
   */
  async sendMessage(
    content: string,
    channelId?: string
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party Quest not configured" };
    }

    const payload: PartyQuestMessagePayload = {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      content,
      channelId,
    };

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      messageId?: string;
      error?: string;
    }>(PARTY_QUEST_WEBHOOK_PATHS.message, payload);

    if (!result.ok) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      messageId: result.data.messageId,
    };
  }

  async heartbeat(params: {
    status: PartyQuestHeartbeatRequest["status"];
    activeRunId?: string;
    activeTicketId?: string;
    supportedCapabilities?: string[];
    maxAssignments?: number;
  }): Promise<{
    success: boolean;
    assignment?: PartyQuestHeartbeatResponse["assignment"];
    message?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party Quest not configured" };
    }

    const payload: PartyQuestHeartbeatRequest = {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      status: params.status,
      activeRunId: params.activeRunId,
      activeTicketId: params.activeTicketId,
      frameworkType: "phantasy",
      supportedCapabilities:
        params.supportedCapabilities || [...PARTY_QUEST_PHANTASY_CAPABILITIES],
      maxAssignments: params.maxAssignments,
    };
    this.lastHeartbeatStatus = params.status;
    this.lastHeartbeatRequestedAssignments = params.maxAssignments ?? 1;

    const result = await this.postAuthenticatedJson<PartyQuestHeartbeatResponse>(
      PARTY_QUEST_WEBHOOK_PATHS.heartbeat,
      payload,
    );

    if (!result.ok) {
      this.lastHeartbeatError = result.error;
      this.lastHeartbeatMessage = null;
      logger.error("[PartyQuestSyncService] Heartbeat failed", {
        status: result.status,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    this.lastHeartbeatAt = Date.now();
    this.lastHeartbeatError = null;
    this.lastHeartbeatMessage = result.data.message || null;

    return {
      success: result.data.success !== false,
      assignment: result.data.assignment,
      message: result.data.message,
    };
  }

  async sendPresenceHeartbeat(
    status: PartyQuestHeartbeatRequest["status"] = "idle",
  ): Promise<{
    success: boolean;
    assignment?: PartyQuestHeartbeatResponse["assignment"];
    message?: string;
    error?: string;
  }> {
    return this.heartbeat({
      status,
      maxAssignments: 0,
    });
  }

  async reportRunTrace(
    payload: Omit<PartyQuestRunTraceRequest, "specVersion">
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party Quest not configured" };
    }

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      error?: string;
    }>(PARTY_QUEST_WEBHOOK_PATHS.runTrace, {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      ...payload,
    });

    if (!result.ok) {
      logger.error("[PartyQuestSyncService] Run trace upload failed", {
        status: result.status,
        error: result.error,
        runId: payload.runId,
      });
      return { success: false, error: result.error };
    }

    return { success: true };
  }

  async reportRunResult(
    payload: Omit<PartyQuestRunResultRequest, "specVersion">
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party Quest not configured" };
    }

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      error?: string;
    }>(PARTY_QUEST_WEBHOOK_PATHS.runResult, {
      specVersion: PARTY_QUEST_PROTOCOL_VERSION,
      ...payload,
    });

    if (!result.ok) {
      logger.error("[PartyQuestSyncService] Run result upload failed", {
        status: result.status,
        error: result.error,
        runId: payload.runId,
      });
      return { success: false, error: result.error };
    }

    return { success: true };
  }

  async reportSourceControlSync(
    payload: Omit<PartyQuestSourceControlSyncRequest, "specVersion">
  ): Promise<PartyQuestSourceControlSyncResponse> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party Quest not configured" };
    }

    const result = await this.postAuthenticatedJson<PartyQuestSourceControlSyncResponse>(
      PARTY_QUEST_WEBHOOK_PATHS.sourceControlSync,
      {
        specVersion: PARTY_QUEST_PROTOCOL_VERSION,
        ...payload,
      },
    );

    if (!result.ok) {
      logger.error("[PartyQuestSyncService] Source-control sync upload failed", {
        status: result.status,
        error: result.error,
        provider: payload.provider,
        externalId: payload.externalId,
      });
      return { success: false, error: result.error };
    }

    return {
      success: result.data.success !== false,
      matchedTicketIds: result.data.matchedTicketIds,
      updatedCount: result.data.updatedCount,
      error: result.data.error,
    };
  }

  /**
   * Check Party Quest health/connectivity
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    if (!this.partyQuestUrl) {
      return { healthy: false, error: "Party Quest URL not configured" };
    }

    const startTime = Date.now();

    try {
      const response = await fetchWithTimeout(joinPartyQuestUrl(this.partyQuestUrl, PARTY_QUEST_WEBHOOK_PATHS.health), {
        timeout: 5000,
        method: "GET",
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { healthy: true, latencyMs };
      }

      return {
        healthy: false,
        latencyMs,
        error: `HTTP ${response.status}`,
      };
    } catch (error: unknown) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }
}

// Export singleton instance
export const partyQuestSyncService = PartyQuestSyncService.getInstance();
