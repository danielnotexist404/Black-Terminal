export type NetworkSection = "feed" | "profile" | "research" | "assets" | "groups" | "messages" | "notifications" | "discovery" | "moderation";
export type FeedMode = "for_you" | "following" | "research" | "market_analysis" | "indicators" | "strategies" | "investment_groups" | "saved";
export type PostVisibility = "public" | "followers" | "group" | "private";
export type ReactionType = "insightful" | "bullish" | "bearish" | "useful" | "high_conviction" | "well_researched";
export type CommentReactionType = "insightful" | "useful" | "agree";

export interface ProfessionalProfile {
  user_id: string;
  handle: string;
  display_name: string | null;
  headline: string;
  bio: string;
  professional_role: string | null;
  organization: string | null;
  website_url: string | null;
  location: string | null;
  country: string | null;
  timezone: string | null;
  market_specialties: string[];
  asset_classes: string[];
  trading_style_tags: string[];
  avatar_storage_path: string | null;
  banner_storage_path: string | null;
  avatar_signed_url: string | null;
  banner_signed_url: string | null;
  profile_visibility: "public" | "followers" | "private";
  message_policy: "everyone" | "followers" | "nobody";
  show_public_stats: boolean;
  show_public_pnl: boolean;
  show_public_drawdown: boolean;
  show_public_equity_curve: boolean;
  show_verified_exchange_performance: boolean;
  show_positions: boolean;
  show_groups: boolean;
  verified_role: boolean;
  verified_performance_source: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfilePayload {
  profile: ProfessionalProfile;
  viewer: { isOwner: boolean; isFollowing: boolean; isBlocked?: boolean; isMuted?: boolean; followRequestPending?: boolean };
  credibility: { followers: number; following: number; research: number; indicators: number; strategies: number; groups: number };
  groups: Array<Record<string, unknown> & { id: string; firm_name?: string; slug?: string; description?: string; visibility?: string }>;
  followers: Array<Pick<ProfessionalProfile, "user_id" | "handle" | "display_name" | "headline" | "professional_role" | "verified_role">>;
  following: Array<Pick<ProfessionalProfile, "user_id" | "handle" | "display_name" | "headline" | "professional_role" | "verified_role">>;
}

export interface PostMedia {
  id: string;
  storage_path: string;
  signed_url: string | null;
  media_type: "image" | "chart_snapshot";
  alt_text: string;
  metadata?: Record<string, unknown>;
}

export interface SocialComment {
  id: string;
  post_id: string;
  parent_comment_id: string | null;
  author_user_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  reactions?: Partial<Record<CommentReactionType, number>>;
  viewerReaction?: CommentReactionType | null;
  author?: Pick<ProfessionalProfile, "user_id" | "handle" | "display_name" | "avatar_signed_url"> | null;
}

export interface SocialPost {
  id: string;
  user_id: string;
  post_type: string;
  title: string | null;
  body: string;
  summary: string | null;
  asset_class: string | null;
  directional_bias: string | null;
  timeframe: string | null;
  visibility: PostVisibility;
  risk_disclaimer: string;
  status: string;
  metadata: Record<string, unknown>;
  edited_at: string | null;
  created_at: string;
  author: Pick<ProfessionalProfile, "user_id" | "handle" | "display_name" | "professional_role" | "avatar_signed_url" | "verified_role"> | null;
  symbols: string[];
  media: PostMedia[];
  attachments: Array<{ id: string; attachment_type: string; title: string; public_metadata: Record<string, unknown> }>;
  reactions: Partial<Record<ReactionType, number>>;
  viewerReaction: ReactionType | null;
  comments: SocialComment[];
  commentCount: number;
  repostCount: number;
  viewerReposted: boolean;
  saved: boolean;
  feed_context?: { type: "repost"; user_id: string; commentary: string | null; created_at: string };
  quotedPost?: Pick<SocialPost, "id" | "user_id" | "post_type" | "title" | "body" | "created_at" | "author"> | null;
}

export interface ConversationSummary {
  id: string;
  conversation_type: "direct" | "group";
  title: string | null;
  last_message_at: string | null;
  participants: Array<Pick<ProfessionalProfile, "user_id" | "handle" | "display_name" | "professional_role">>;
  request: { status: string; sender_user_id: string; recipient_user_id: string } | null;
  lastMessage: { id: string; body: string; message_type: string; sender_user_id: string; created_at: string } | null;
  read: { last_read_message_id: string | null; read_at: string } | null;
  membership: { archived_at: string | null; muted_until: string | null };
}

export interface DirectMessage {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  body: string;
  message_type: string;
  shared_object_type: string | null;
  shared_object_id: string | null;
  created_at: string;
  attachments: PostMedia[];
}

export interface NetworkNotification {
  id: string;
  event_type: string;
  title: string;
  body: string;
  deep_link: string | null;
  read_at: string | null;
  created_at: string;
  actor_user_id?: string | null;
  actor?: Pick<ProfessionalProfile, "user_id" | "handle" | "display_name" | "professional_role"> | null;
  group_count?: number;
}

export interface NotificationPreferences {
  follows: boolean;
  reactions: boolean;
  comments: boolean;
  reposts: boolean;
  messages: boolean;
  mentions: boolean;
  group_activity: boolean;
  indicator_updates: boolean;
  email_digest: "off" | "daily" | "weekly";
}

export interface SavedCollection {
  id: string;
  name: string;
  is_default: boolean;
  social_saved_posts?: Array<{ count: number }>;
}

export interface SearchResults {
  query: string;
  profiles: ProfessionalProfile[];
  posts: SocialPost[];
  groups: Array<{ id: string; slug: string; firm_name: string; description: string }>;
  indicators: Array<{ id: string; name: string; description: string; version: string }>;
  strategies: Array<{ id: string; name: string; description: string; market: string; timeframe: string }>;
}
