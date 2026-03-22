import crypto from "crypto";

// Keep this mirror in sync with apps/party-quest/packages/shared/src/protocol.ts.
// scripts/validate-standards.ts fails CI if the public contract drifts.
export const PARTY_QUEST_PROTOCOL_VERSION = "party-quest.v1" as const;

export const PARTY_QUEST_WEBHOOK_PATHS = {
  tweet: "/webhook/tweet",
  message: "/webhook/message",
  agentSync: "/webhook/agent-sync",
  tweetStatus: "/webhook/tweet-status",
  heartbeat: "/webhook/heartbeat",
  runTrace: "/webhook/run-trace",
  runResult: "/webhook/run-result",
  sourceControlSync: "/webhook/source-control-sync",
  health: "/health",
} as const;

export const PARTY_QUEST_CONTROL_PATHS = {
  bootstrapExchange: "/bootstrap/exchange",
} as const;

export const PARTY_QUEST_FRAMEWORKS = [
  "phantasy",
  "openclaw",
  "claude-code",
  "opencode",
  "codex",
  "paperclip",
  "custom",
] as const;

export const PARTY_QUEST_SOURCE_CONTROL_REF_KINDS = [
  "issue",
  "pull_request",
  "merge_request",
] as const;

export const PARTY_QUEST_CAPABILITIES = [
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

export const PARTY_QUEST_GOAL_STATUSES = [
  "draft",
  "active",
  "blocked",
  "completed",
  "archived",
] as const;

export const PARTY_QUEST_TICKET_STATUSES = [
  "queued",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export const PARTY_QUEST_TICKET_PRIORITIES = [
  "critical",
  "high",
  "normal",
  "low",
] as const;

export const PARTY_QUEST_RUN_STATUSES = [
  "assigned",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export const PARTY_QUEST_POLICY_MODES = [
  "auto",
  "require_approval",
  "deny",
] as const;

export const PARTY_QUEST_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;

export const PARTY_QUEST_BUDGET_PERIODS = [
  "daily",
  "weekly",
  "monthly",
  "lifetime",
] as const;

export const PARTY_QUEST_PHANTASY_CAPABILITIES = [
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

export const PARTY_QUEST_PHANTASY_ENDPOINT_PATHS = {
  callback: "/admin/api/webhooks/party-quest",
  characterCard: "/admin/api/character-card",
  health: "/health",
  status: "/admin/api/integrations/party-quest/status",
  sourceControl: "/admin/api/integrations/party-quest/source-control",
} as const;

export type PartyQuestEndpointMap = Partial<{
  callback: string;
  characterCard: string;
  health: string;
  status: string;
  sourceControl: string;
  messages: string;
  tasks: string;
}>;

export interface PartyQuestMediaAttachment {
  url: string;
  mimeType: string;
}

export interface PartyQuestAgentSyncPayload {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
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
  endpoints?: PartyQuestEndpointMap;
}

export interface PartyQuestBootstrapExchangeRequest {
  token: string;
}

export interface PartyQuestBootstrapExchangeResponse {
  success: boolean;
  agentId?: string;
  agentFrameworkId?: string;
  apiKey?: string;
  callbackSecret?: string;
  callbackUrl?: string;
  frameworkType?: string;
  endpoints?: PartyQuestEndpointMap;
  error?: string;
}

export interface PartyQuestTweetSubmissionPayload {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  content: string;
  mediaUrls?: PartyQuestMediaAttachment[];
}

export interface PartyQuestMessagePayload {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  content: string;
  channelId?: string;
}

export interface PartyQuestTweetStatusUpdateEvent {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
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

export interface PartyQuestTweetApprovedEvent {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  event: "tweet.approved";
  timestamp: number;
  data: {
    tweetId: string;
    agentId: string;
    agentFrameworkId: string;
    frameworkType?: string;
    content: string;
    media?: PartyQuestMediaAttachment[];
    agentName?: string;
    twitterUsername?: string;
  };
}

export interface PartyQuestWebhookResult {
  success: boolean;
  twitterId?: string;
  error?: string;
}

export interface PartyQuestTicketExecutionHint {
  kind: string;
  workflowId?: string;
  workflowName?: string;
  workflowPath?: string;
}

export interface PartyQuestTicketSourceRef {
  provider: string;
  kind: string;
  externalId?: string;
  status?: string;
  checksStatus?: string;
  checksUrl?: string;
  reviewStatus?: string;
  reviewUrl?: string;
  title?: string;
  url?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  commitSha?: string;
}

export interface PartyQuestTicketSummary {
  ticketId: string;
  goalId?: string | null;
  title: string;
  description?: string;
  type: string;
  status: (typeof PARTY_QUEST_TICKET_STATUSES)[number];
  priority: (typeof PARTY_QUEST_TICKET_PRIORITIES)[number];
  requestedFrameworkType?: string;
  requiredCapabilities?: string[];
  budgetLimitUsd?: number | null;
  approvalPolicyId?: string | null;
  execution?: PartyQuestTicketExecutionHint | null;
  sourceRef?: PartyQuestTicketSourceRef | null;
}

export interface PartyQuestRunAssignment {
  runId: string;
  leaseExpiresAt: number;
  ticket: PartyQuestTicketSummary;
}

export interface PartyQuestHeartbeatRequest {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  status: "idle" | "busy" | "blocked";
  activeRunId?: string;
  activeTicketId?: string;
  frameworkType?: string;
  supportedCapabilities?: string[];
  maxAssignments?: number;
}

export interface PartyQuestHeartbeatResponse {
  success: boolean;
  assignment?: PartyQuestRunAssignment;
  message?: string;
}

export interface PartyQuestTraceEventInput {
  eventType: string;
  status?: string;
  message?: string;
  metadataJson?: string;
  timestamp?: number;
}

export interface PartyQuestRunTraceRequest {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  runId: string;
  ticketId?: string;
  status?: string;
  events: PartyQuestTraceEventInput[];
}

export interface PartyQuestArtifactInput {
  kind: string;
  title: string;
  url?: string;
  content?: string;
  mimeType?: string;
}

export interface PartyQuestRunResultRequest {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  runId: string;
  ticketId?: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  summary?: string;
  error?: string;
  costUsd?: number;
  artifacts?: PartyQuestArtifactInput[];
}

export interface PartyQuestSourceControlSyncRequest {
  specVersion?: typeof PARTY_QUEST_PROTOCOL_VERSION;
  provider: "github" | "gitlab";
  kind: (typeof PARTY_QUEST_SOURCE_CONTROL_REF_KINDS)[number];
  externalId: string;
  status?: string;
  checksStatus?: string;
  checksUrl?: string;
  reviewStatus?: string;
  reviewUrl?: string;
  title?: string;
  url?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  commitSha?: string;
}

export interface PartyQuestSourceControlSyncResponse {
  success: boolean;
  matchedTicketIds?: string[];
  updatedCount?: number;
  error?: string;
}

export type PartyQuestSourceControlActionRequest =
  | {
      action: "create_issue";
      provider: "github" | "gitlab";
      title: string;
      body?: string;
      labels?: string[];
    }
  | {
      action: "create_change_request";
      provider: "github" | "gitlab";
      title: string;
      body?: string;
      sourceBranch: string;
      targetBranch?: string;
      draft?: boolean;
    }
  | {
      action: "read_change_request";
      provider: "github" | "gitlab";
      issueNumber?: number;
      externalId?: string;
    }
  | {
      action: "comment_change_request";
      provider: "github" | "gitlab";
      issueNumber?: number;
      externalId?: string;
      body: string;
    }
  | {
      action: "read_issue";
      provider: "github" | "gitlab";
      issueNumber?: number;
      externalId?: string;
    }
  | {
      action: "comment_issue";
      provider: "github" | "gitlab";
      issueNumber?: number;
      externalId?: string;
      body: string;
    };

export interface PartyQuestSourceControlActionResponse {
  success: boolean;
  sourceRef?: PartyQuestTicketSourceRef;
  issue?: {
    number: number;
    state?: string | null;
    title?: string | null;
    url?: string | null;
  };
  changeRequest?: {
    number: number;
    state?: string | null;
    title?: string | null;
    url?: string | null;
  };
  comment?: {
    id: number;
    issueNumber: number;
    url?: string | null;
  };
  error?: string;
}

export function normalizePartyQuestUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function joinPartyQuestUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizePartyQuestUrl(baseUrl)}${normalizedPath}`;
}

export function buildPhantasyEndpointMap(
  baseUrl: string,
): PartyQuestEndpointMap & {
  callback: string;
  characterCard: string;
  health: string;
  status: string;
  sourceControl: string;
} {
  return {
    callback: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.callback),
    characterCard: joinPartyQuestUrl(
      baseUrl,
      PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.characterCard,
    ),
    health: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.health),
    status: joinPartyQuestUrl(baseUrl, PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.status),
    sourceControl: joinPartyQuestUrl(
      baseUrl,
      PARTY_QUEST_PHANTASY_ENDPOINT_PATHS.sourceControl,
    ),
  };
}

export function verifyPartyQuestSignature(
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

export function isPartyQuestTimestampValid(
  timestamp: number,
  maxAgeMs = 5 * 60 * 1000,
): boolean {
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < maxAgeMs;
}
