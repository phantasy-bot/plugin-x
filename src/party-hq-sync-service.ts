import type { AgentConfig } from "@phantasy/agent/types";
import {
  createPluginModuleLogger,
  fetchWithTimeout,
  getTwitterIntegrationUsername,
} from "@phantasy/agent/plugin-runtime";
import {
  PARTY_HQ_CONTROL_PATHS,
  PARTY_HQ_PHANTASY_CAPABILITIES,
  PARTY_HQ_PROTOCOL_VERSION,
  PARTY_HQ_WEBHOOK_PATHS,
  buildPhantasyEndpointMap,
  joinPartyHQUrl,
  type PartyHQAgentSyncPayload,
  type PartyHQBootstrapExchangeResponse,
  type PartyHQHeartbeatRequest,
  type PartyHQHeartbeatResponse,
  type PartyHQMessagePayload,
  type PartyHQRunResultRequest,
  type PartyHQRunTraceRequest,
  type PartyHQTweetStatusUpdateEvent,
  type PartyHQTweetSubmissionPayload,
} from "./party-hq-protocol";

const logger = createPluginModuleLogger("PartyHQSyncService");

/**
 * Party-HQ Sync Service
 *
 * Handles synchronization of agent data with Party-HQ for the multi-agent
 * management dashboard. This service:
 * - Syncs agent configuration to Party-HQ on startup
 * - Registers callback URLs for the tweet approval workflow
 * - Sends orchestration heartbeats, traces, and final run results
 * - Handles periodic health checks
 *
 * @example
 * ```typescript
 * const syncService = PartyHQSyncService.getInstance();
 *
 * // Sync agent data to Party-HQ
 * await syncService.syncAgent(agentConfig);
 *
 * // Check if Party-HQ is configured
 * if (syncService.isConfigured()) {
 *   console.log("Party-HQ integration is ready");
 * }
 * ```
 */
export class PartyHQSyncService {
  private static instance: PartyHQSyncService | null = null;

  private partyHQUrl: string | null = null;
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
  private partyHQAgentId: string | null = null;

  private getAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey!,
    };
  }

  private resolveCharacterCardApiKey(): string | null {
    const explicitKey = process.env.PARTY_HQ_CHARACTER_CARD_API_KEY?.trim();
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
    return !!(this.partyHQUrl && this.apiKey && this.webhookSecret);
  }

  private async ensureOperationalCredentials(): Promise<boolean> {
    if (this.hasDirectCredentials()) {
      return true;
    }

    if (!this.partyHQUrl || !this.bootstrapToken) {
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
    if (!this.partyHQUrl || !this.bootstrapToken) {
      return false;
    }

    try {
      const response = await fetchWithTimeout(
        joinPartyHQUrl(this.partyHQUrl, PARTY_HQ_CONTROL_PATHS.bootstrapExchange),
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
        | PartyHQBootstrapExchangeResponse
        | null;

      if (!response.ok || !payload?.success || !payload.apiKey || !payload.callbackSecret) {
        const error =
          payload?.error ||
          response.statusText ||
          "Bootstrap exchange failed";
        logger.error("[PartyHQSyncService] Bootstrap exchange failed", {
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

      logger.info("[PartyHQSyncService] Bootstrapped Party-HQ runtime credentials");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bootstrap exchange failed";
      logger.error("[PartyHQSyncService] Bootstrap exchange error", {
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
      return { ok: false, error: "Party-HQ not configured" };
    }

    try {
      const response = await fetchWithTimeout(
        joinPartyHQUrl(this.partyHQUrl!, pathname),
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
  static getInstance(): PartyHQSyncService {
    if (!PartyHQSyncService.instance) {
      PartyHQSyncService.instance = new PartyHQSyncService();
    }
    return PartyHQSyncService.instance;
  }

  private constructor() {
    this.loadConfiguration();
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfiguration(): void {
    this.partyHQUrl = process.env.PARTY_HQ_URL || null;
    this.apiKey = process.env.PARTY_HQ_API_KEY || null;
    this.webhookSecret = process.env.PARTY_HQ_WEBHOOK_SECRET || null;
    this.characterCardApiKey = this.resolveCharacterCardApiKey();
    this.bootstrapToken = process.env.PARTY_HQ_BOOTSTRAP_TOKEN || null;
    this.frameworkBaseUrl = process.env.AGENT_FRAMEWORK_URL ||
      process.env.BASE_URL ||
      `http://localhost:${process.env.ADMIN_PORT || 2000}`;
    this.bootstrappedFromToken = false;

    if (this.partyHQUrl) {
      // Normalize URL (remove trailing slash)
      this.partyHQUrl = this.partyHQUrl.replace(/\/$/, "");
    }

    logger.debug("[PartyHQSyncService] Configuration loaded", {
      hasUrl: !!this.partyHQUrl,
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
    logger.info("[PartyHQSyncService] Configuration reloaded");
  }

  /**
   * Check if Party-HQ integration is configured
   */
  isConfigured(): boolean {
    return !!(
      this.partyHQUrl &&
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
    partyHQAgentId: string | null;
    partyHQUrl: string | null;
    hasBootstrapToken: boolean;
    bootstrappedFromToken: boolean;
  } {
    return {
      configured: this.isConfigured(),
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      partyHQAgentId: this.partyHQAgentId,
      partyHQUrl: this.partyHQUrl,
      hasBootstrapToken: !!this.bootstrapToken,
      bootstrappedFromToken: this.bootstrappedFromToken,
    };
  }

  /**
   * Sync agent configuration to Party-HQ
   *
   * This registers/updates the agent in Party-HQ and configures the callback
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
      if (this.partyHQUrl || this.apiKey || this.webhookSecret || this.bootstrapToken) {
        return {
          success: false,
          error: this.lastSyncError || "Party-HQ credentials are incomplete",
        };
      }
      logger.debug("[PartyHQSyncService] Not configured, skipping sync");
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
        };
    const capabilities = this.characterCardApiKey
      ? [...PARTY_HQ_PHANTASY_CAPABILITIES]
      : PARTY_HQ_PHANTASY_CAPABILITIES.filter(
          (capability) => capability !== "character-card",
        );

    // Derive avatar URL from unified avatars config
    const avatarUrl =
      agentConfig.avatars?.static?.url ||
      agentConfig.avatars?.pngtuber?.url ||
      null;

    const payload: PartyHQAgentSyncPayload = {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
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

    logger.info("[PartyHQSyncService] Syncing agent to Party-HQ", {
      agentFrameworkId,
      callbackUrl: endpoints.callback,
      name: payload.name,
    });

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      agentId?: string;
      error?: string;
      message?: string;
    }>(PARTY_HQ_WEBHOOK_PATHS.agentSync, payload);

    if (!result.ok) {
      const errorMessage = result.error;
      logger.error("[PartyHQSyncService] Sync request failed", {
        error: errorMessage,
        status: result.status,
      });
      this.lastSyncError = errorMessage;
      return { success: false, error: errorMessage };
    }

    this.lastSyncAt = Date.now();
    this.lastSyncError = null;
    this.partyHQAgentId = result.data.agentId || null;

    logger.info("[PartyHQSyncService] ✅ Agent synced successfully", {
      agentId: this.partyHQAgentId,
    });

    return { success: true, agentId: this.partyHQAgentId || undefined };
  }

  /**
   * Submit a tweet to Party-HQ for approval
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
      return { success: false, error: "Party-HQ not configured" };
    }

    logger.info("[PartyHQSyncService] Submitting tweet for approval", {
      contentLength: content.length,
      hasMedia: !!(mediaUrls && mediaUrls.length > 0),
    });

    const payload: PartyHQTweetSubmissionPayload = {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
      content,
      mediaUrls: mediaUrls || [],
    };

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      tweetId?: string;
      error?: string;
    }>(PARTY_HQ_WEBHOOK_PATHS.tweet, payload);

    if (!result.ok) {
      logger.error("[PartyHQSyncService] Tweet submission failed", {
        status: result.status,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    if (!result.data.tweetId) {
      return { success: false, error: result.data.error || "Missing tweetId" };
    }

    logger.info("[PartyHQSyncService] ✅ Tweet submitted successfully", {
      tweetId: result.data.tweetId,
    });
    return { success: true, tweetId: result.data.tweetId };
  }

  /**
   * Notify Party-HQ that a tweet was approved/posted locally
   *
   * This enables bidirectional sync - when a tweet is approved in the Agent CMS,
   * Party-HQ is notified so it can update its status (mark as "posted").
   *
   * @param params - Approval notification parameters
   * @returns Promise with notification result
   */
  async notifyApproval(params: {
    tweetId: string;        // Party-HQ tweet ID (from externalIds.partyHQTweetId)
    twitterId?: string;     // Posted Twitter tweet ID
    approvedAt: number;     // Timestamp of approval
    approvedBy: string;     // Source of approval (e.g., "agent-cms")
  }): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      logger.debug("[PartyHQSyncService] Not configured, skipping approval notification");
      return { success: true }; // Not an error, just not configured
    }

    logger.info("[PartyHQSyncService] Notifying Party-HQ of local approval", {
      tweetId: params.tweetId,
      twitterId: params.twitterId,
      approvedBy: params.approvedBy,
    });

    const payload: PartyHQTweetStatusUpdateEvent = {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
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
    }>(PARTY_HQ_WEBHOOK_PATHS.tweetStatus, payload);

    if (!result.ok) {
      logger.error("[PartyHQSyncService] Approval notification failed", {
        status: result.status,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    logger.info("[PartyHQSyncService] ✅ Party-HQ notified of approval", {
      tweetId: params.tweetId,
    });
    return { success: true };
  }

  /**
   * Send a message to the agent's channel in Party-HQ
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
      return { success: false, error: "Party-HQ not configured" };
    }

    const payload: PartyHQMessagePayload = {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
      content,
      channelId,
    };

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      messageId?: string;
      error?: string;
    }>(PARTY_HQ_WEBHOOK_PATHS.message, payload);

    if (!result.ok) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      messageId: result.data.messageId,
    };
  }

  async heartbeat(params: {
    status: PartyHQHeartbeatRequest["status"];
    activeRunId?: string;
    activeTicketId?: string;
    supportedCapabilities?: string[];
    maxAssignments?: number;
  }): Promise<{
    success: boolean;
    assignment?: PartyHQHeartbeatResponse["assignment"];
    message?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party-HQ not configured" };
    }

    const payload: PartyHQHeartbeatRequest = {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
      status: params.status,
      activeRunId: params.activeRunId,
      activeTicketId: params.activeTicketId,
      frameworkType: "phantasy",
      supportedCapabilities:
        params.supportedCapabilities || [...PARTY_HQ_PHANTASY_CAPABILITIES],
      maxAssignments: params.maxAssignments,
    };

    const result = await this.postAuthenticatedJson<PartyHQHeartbeatResponse>(
      PARTY_HQ_WEBHOOK_PATHS.heartbeat,
      payload,
    );

    if (!result.ok) {
      logger.error("[PartyHQSyncService] Heartbeat failed", {
        status: result.status,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    return {
      success: result.data.success !== false,
      assignment: result.data.assignment,
      message: result.data.message,
    };
  }

  async reportRunTrace(
    payload: Omit<PartyHQRunTraceRequest, "specVersion">
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party-HQ not configured" };
    }

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      error?: string;
    }>(PARTY_HQ_WEBHOOK_PATHS.runTrace, {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
      ...payload,
    });

    if (!result.ok) {
      logger.error("[PartyHQSyncService] Run trace upload failed", {
        status: result.status,
        error: result.error,
        runId: payload.runId,
      });
      return { success: false, error: result.error };
    }

    return { success: true };
  }

  async reportRunResult(
    payload: Omit<PartyHQRunResultRequest, "specVersion">
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Party-HQ not configured" };
    }

    const result = await this.postAuthenticatedJson<{
      success?: boolean;
      error?: string;
    }>(PARTY_HQ_WEBHOOK_PATHS.runResult, {
      specVersion: PARTY_HQ_PROTOCOL_VERSION,
      ...payload,
    });

    if (!result.ok) {
      logger.error("[PartyHQSyncService] Run result upload failed", {
        status: result.status,
        error: result.error,
        runId: payload.runId,
      });
      return { success: false, error: result.error };
    }

    return { success: true };
  }

  /**
   * Check Party-HQ health/connectivity
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    if (!this.partyHQUrl) {
      return { healthy: false, error: "Party-HQ URL not configured" };
    }

    const startTime = Date.now();

    try {
      const response = await fetchWithTimeout(joinPartyHQUrl(this.partyHQUrl, PARTY_HQ_WEBHOOK_PATHS.health), {
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
export const partyHQSyncService = PartyHQSyncService.getInstance();
