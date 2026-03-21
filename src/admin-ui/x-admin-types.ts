export interface XPluginConfig {
  activeHours: string;
  autonomousPosting: boolean;
  enabled: boolean;
  maxPostsPerDay: number;
  postingIntervalMinutes: number;
  requireApproval: boolean;
}

export interface XPlatformConfig {
  accessToken?: string;
  accessTokenSecret?: string;
  apiKey?: string;
  apiKeySecret?: string;
  enabled?: boolean;
  platformName?: string;
}

export interface XPluginStatus {
  autonomousPosting?: boolean;
  connected: boolean;
  enabled: boolean;
  error?: string;
  lastActivity?: string;
}

export interface TwitterTemplate {
  parameters: Record<string, string[]>;
  prompts: string[];
}

export type TemplateWeights = Record<string, number>;
export type TwitterTemplates = Record<string, TwitterTemplate>;

export interface AgentConfigPayload {
  twitter?: {
    templateWeights?: TemplateWeights;
    templates?: TwitterTemplates;
  };
  [key: string]: unknown;
}
