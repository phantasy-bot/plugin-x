/**
 * Twitter Service Type Definitions
 */

export interface TwitterConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
  bearerToken?: string;
  username?: string;
  monitorUser?: string;
  tweetInterval?: number;
  replyEnabled?: boolean;
  likesEnabled?: boolean;
  retweetsEnabled?: boolean;
  followEnabled?: boolean;
  searchTerms?: string[];
  blacklistedUsers?: string[];
  maxTweetsPerDay?: number;
  requireApproval?: boolean;
  autonomousEnabled?: boolean;
  pollInterval?: number;
}

export interface TwitterMessage {
  id: string;
  text: string;
  author_id: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{
    type: string;
    id: string;
  }>;
  public_metrics?: {
    retweet_count?: number;
    like_count?: number;
    reply_count?: number;
    quote_count?: number;
  };
}

export interface TwitterUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    listed_count?: number;
  };
}

export interface PendingNotification {
  id: string;
  type: "tweet_approval" | "reply_approval";
  platform: "twitter";
  timestamp: string;
  status: "pending";
  content: {
    text?: string;
    targetUser?: string;
    originalTweet?: string;
    reason?: string;
    mediaUrls?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface RateLimitInfo {
  count: number;
  resetTime: number;
}

export interface TwitterServiceStatus {
  connected: boolean;
  streaming: boolean;
  username?: string;
  rateLimits?: Map<string, RateLimitInfo>;
  lastActivity?: Date;
}

export interface TweetOptions {
  text: string;
  inReplyTo?: string;
  mediaIds?: string[];
  quoteTweetId?: string;
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
  sinceId?: string;
  untilId?: string;
  startTime?: string;
  endTime?: string;
  nextToken?: string;
}

export interface TimelineOptions {
  userId: string;
  maxResults?: number;
  sinceId?: string;
  untilId?: string;
  excludeReplies?: boolean;
  excludeRetweets?: boolean;
  paginationToken?: string;
}

export interface StreamRule {
  id?: string;
  value: string;
  tag?: string;
}

export const DEFAULT_CONFIG: Partial<TwitterConfig> = {
  tweetInterval: 3600000, // 1 hour
  replyEnabled: true,
  likesEnabled: true,
  retweetsEnabled: false,
  followEnabled: false,
  maxTweetsPerDay: 10,
  requireApproval: false,
  autonomousEnabled: false,
  pollInterval: 600000, // 10 minutes
};

export const TWITTER_CONSTANTS = {
  MAX_TWEET_LENGTH: 280,
  MAX_MEDIA_COUNT: 4,
  MAX_MENTIONS_PER_TWEET: 50,
  MAX_HASHTAGS_RECOMMENDED: 2,
  RATE_LIMIT_WINDOW: 900000, // 15 minutes
  USER_CACHE_TTL: 3600000, // 1 hour
  MIN_POLL_INTERVAL: 600000, // 10 minutes
  MAX_RATE_LIMIT_ENTRIES: 50,
  BACKOFF_MULTIPLIER_MAX: 8,
};
