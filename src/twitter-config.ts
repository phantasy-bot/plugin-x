export interface TwitterPostTemplate {
  id: string;
  name: string;
  template: string;
  variables?: string[];
  category: 'announcement' | 'reply' | 'engagement' | 'promotional' | 'informative';
}

export interface TwitterAdvancedConfig {
  // Autonomous posting settings
  autonomousPosting: {
    enabled: boolean;
    requireApproval: boolean;
    frequency: 'low' | 'medium' | 'high' | 'custom';
    customInterval?: number; // in minutes
    hotStart: boolean; // Whether to post immediately on startup
    postingHours?: {
      start: number; // 0-23
      end: number; // 0-23
      timezone: string;
    };
  };

  // Reply settings
  replySettings: {
    autoReplyToMentions: boolean;
    autoReplyToFollowers: boolean;
    replyToTimeline: boolean;
    requireApprovalForReplies: boolean;
    replyDelay: number; // seconds
    ignoreBots: boolean;
    blacklistedWords?: string[];
  };

  // Content moderation
  moderation: {
    filterProfanity: boolean;
    checkSentiment: boolean;
    maxNegativeSentiment: number; // 0-1
    requireApprovalForNegative: boolean;
  };

  // Engagement settings
  engagement: {
    likeFollowersTweets: boolean;
    retweetRelevantContent: boolean;
    followBackRatio: number; // 0-1
    unfollowInactive: boolean;
    inactiveDays: number;
  };

  // Post templates
  templates: TwitterPostTemplate[];

  // Rate limiting
  rateLimits: {
    maxTweetsPerHour: number;
    maxRepliesPerHour: number;
    maxLikesPerHour: number;
    maxFollowsPerDay: number;
  };
}

export const defaultTwitterAdvancedConfig: TwitterAdvancedConfig = {
  autonomousPosting: {
    enabled: true, // Enabled by default as requested
    requireApproval: true,
    frequency: 'low',
    hotStart: true, // Post within 30 seconds on startup by default
    postingHours: {
      start: 9,
      end: 21,
      timezone: 'America/New_York'
    }
  },
  replySettings: {
    autoReplyToMentions: true,
    autoReplyToFollowers: false,
    replyToTimeline: false,
    requireApprovalForReplies: false,
    replyDelay: 5,
    ignoreBots: true,
    blacklistedWords: []
  },
  moderation: {
    filterProfanity: true,
    checkSentiment: false,
    maxNegativeSentiment: 0.3,
    requireApprovalForNegative: true
  },
  engagement: {
    likeFollowersTweets: false,
    retweetRelevantContent: false,
    followBackRatio: 0.5,
    unfollowInactive: false,
    inactiveDays: 90
  },
  templates: [
    {
      id: 'greeting',
      name: 'Morning Greeting',
      template: 'Good morning! {greeting} Hope everyone has a great day! {emoji}',
      variables: ['greeting', 'emoji'],
      category: 'engagement'
    },
    {
      id: 'announcement',
      name: 'Announcement',
      template: '📢 {title}\n\n{content}\n\n{callToAction}',
      variables: ['title', 'content', 'callToAction'],
      category: 'announcement'
    }
  ],
  rateLimits: {
    maxTweetsPerHour: 3,   // Very conservative - Twitter allows ~300/hour but we limit severely
    maxRepliesPerHour: 5,  // Very conservative - Twitter allows ~300/hour but we limit severely
    maxLikesPerHour: 10,   // Very conservative 
    maxFollowsPerDay: 20   // Very conservative
  }
};
