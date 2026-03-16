import crypto from "crypto";

// Keep this mirror in sync with apps/party-hq/packages/shared/src/protocol.ts.
// scripts/validate-standards.ts fails CI if the public contract drifts.
export const PARTY_HQ_PROTOCOL_VERSION = "party-hq.v1" as const;

export const PARTY_HQ_WEBHOOK_PATHS = {
  tweet: "/webhook/tweet",
  message: "/webhook/message",
  agentSync: "/webhook/agent-sync",
  tweetStatus: "/webhook/tweet-status",
  heartbeat: "/webhook/heartbeat",
  runTrace: "/webhook/run-trace",
  runResult: "/webhook/run-result",
  health: "/health",
} as const;

export const PARTY_HQ_CONTROL_PATHS = {
  bootstrapExchange: "/bootstrap/exchange",
} as const;

export const PARTY_HQ_FRAMEWORKS = [
  "phantasy",
  "openclaw",
  "claude-code",
  "opencode",
  "codex",
  "paperclip",
  "custom",
] as const;

export const PARTY_HQ_CAPABILITIES = [
  "tweet-approval",
  "tweet-posting",
  "chat",
  "messages",
  "character-card",
  "voice",
  "memory",
  "tool-calling",
  "task-routing",
  "multi-agent",
  "workspaces",
  "observability",
] as const;

export const PARTY_HQ_GOAL_STATUSES = [
  "draft",
  "active",
  "blocked",
  "completed",
  "archived",
] as const;

export const PARTY_HQ_TICKET_STATUSES = [
  "queued",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export const PARTY_HQ_TICKET_PRIORITIES = [
  "critical",
  "high",
  "normal",
  "low",
] as const;

export const PARTY_HQ_RUN_STATUSES = [
  "assigned",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export const PARTY_HQ_POLICY_MODES = [
  "auto",
  "require_approval",
  "deny",
] as const;

export const PARTY_HQ_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;

export const PARTY_HQ_BUDGET_PERIODS = [
  "daily",
  "weekly",
  "monthly",
  "lifetime",
] as const;

export const PARTY_HQ_PHANTASY_CAPABILITIES = [
  "tweet-approval",
  "tweet-posting",
  "chat",
  "messages",
  "character-card",
  "voice",
  "memory",
  "tool-calling",
  "multi-agent",
] as const;

export const PARTY_HQ_PHANTASY_ENDPOINT_PATHS = {
  callback: "/admin/api/webhooks/party-hq",
  characterCard: "/admin/api/character-card",
  health: "/health",
  status: "/admin/api/integrations/party-hq/status",
} as const;

export type PartyHQEndpointMap = Partial<{
  callback: string;
  characterCard: string;
  health: string;
  messages: string;
  tasks: string;
}>;

export interface PartyHQMediaAttachment {
  url: string;
  mimeType: string;
}

export interface PartyHQAgentSyncPayload {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  agentFrameworkId: string;
  name?: string;
  title?: string;
  bio?: string;
  avatarUrl?: string | null;
  callbackUrl: string;
  callbackSecret: string;
  characterCardApiKey?: string;
  twitterUsername?: string | null;
  frameworkType?: string;
  frameworkVersion?: string;
  capabilities?: string[];
  endpoints?: PartyHQEndpointMap;
}

export interface PartyHQBootstrapExchangeRequest {
  token: string;
}

export interface PartyHQBootstrapExchangeResponse {
  success: boolean;
  agentId?: string;
  agentFrameworkId?: string;
  apiKey?: string;
  callbackSecret?: string;
  callbackUrl?: string;
  frameworkType?: string;
  endpoints?: PartyHQEndpointMap;
  error?: string;
}

export interface PartyHQTweetSubmissionPayload {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  content: string;
  mediaUrls?: PartyHQMediaAttachment[];
}

export interface PartyHQMessagePayload {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  content: string;
  channelId?: string;
}

export interface PartyHQTweetStatusUpdateEvent {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  event: "tweet.status_update";
  timestamp: number;
  data: {
    tweetId: string;
    status: "posted" | "sent" | "approved" | "rejected" | "failed";
    twitterId?: string | null;
    approvedAt?: number;
    approvedBy?: string;
    error?: string | null;
  };
}

export interface PartyHQTweetApprovedEvent {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  event: "tweet.approved";
  timestamp: number;
  data: {
    tweetId: string;
    agentId: string;
    agentFrameworkId: string;
    frameworkType?: string;
    content: string;
    media?: PartyHQMediaAttachment[];
    agentName?: string;
    twitterUsername?: string;
  };
}

export interface PartyHQWebhookResult {
  success: boolean;
  twitterId?: string;
  error?: string;
}

export interface PartyHQTicketSummary {
  ticketId: string;
  goalId?: string | null;
  title: string;
  description?: string;
  type: string;
  status: (typeof PARTY_HQ_TICKET_STATUSES)[number];
  priority: (typeof PARTY_HQ_TICKET_PRIORITIES)[number];
  requestedFrameworkType?: string;
  requiredCapabilities?: string[];
  budgetLimitUsd?: number | null;
  approvalPolicyId?: string | null;
}

export interface PartyHQRunAssignment {
  runId: string;
  leaseExpiresAt: number;
  ticket: PartyHQTicketSummary;
}

export interface PartyHQHeartbeatRequest {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  status: "idle" | "busy" | "blocked";
  activeRunId?: string;
  activeTicketId?: string;
  frameworkType?: string;
  supportedCapabilities?: string[];
  maxAssignments?: number;
}

export interface PartyHQHeartbeatResponse {
  success: boolean;
  assignment?: PartyHQRunAssignment;
  message?: string;
}

export interface PartyHQTraceEventInput {
  eventType: string;
  status?: string;
  message?: string;
  metadataJson?: string;
  timestamp?: number;
}

export interface PartyHQRunTraceRequest {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  runId: string;
  ticketId?: string;
  status?: string;
  events: PartyHQTraceEventInput[];
}

export interface PartyHQArtifactInput {
  kind: string;
  title: string;
  url?: string;
  content?: string;
  mimeType?: string;
}

export interface PartyHQRunResultRequest {
  specVersion?: typeof PARTY_HQ_PROTOCOL_VERSION;
  runId: string;
  ticketId?: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  summary?: string;
  error?: string;
  costUsd?: number;
  artifacts?: PartyHQArtifactInput[];
}

export function normalizePartyHQUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function joinPartyHQUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizePartyHQUrl(baseUrl)}${normalizedPath}`;
}

export function buildPhantasyEndpointMap(
  baseUrl: string,
): PartyHQEndpointMap & {
  callback: string;
  characterCard: string;
  health: string;
} {
  return {
    callback: joinPartyHQUrl(baseUrl, PARTY_HQ_PHANTASY_ENDPOINT_PATHS.callback),
    characterCard: joinPartyHQUrl(
      baseUrl,
      PARTY_HQ_PHANTASY_ENDPOINT_PATHS.characterCard,
    ),
    health: joinPartyHQUrl(baseUrl, PARTY_HQ_PHANTASY_ENDPOINT_PATHS.health),
  };
}

export function verifyPartyHQSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !signature) {
    return false;
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload, "utf8")
      .digest("hex");

    const actual = Buffer.from(signature, "hex");
    const expected = Buffer.from(expectedSignature, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function isPartyHQTimestampValid(
  timestamp: number,
  maxAgeMs = 5 * 60 * 1000,
): boolean {
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < maxAgeMs;
}
