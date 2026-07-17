import type { ProductTier } from "../../core/permissions/capabilities";

export type ProfessionalProfile = {
  userId: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  bannerUrl: string;
  country?: string;
  tradingStyleTags: string[];
  showPublicStats: boolean;
  showPublicPnl: boolean;
  showPublicDrawdown: boolean;
  showPublicEquityCurve: boolean;
  showVerifiedExchangePerformance: boolean;
  joinedAt: number;
  productTier: ProductTier;
  verified: boolean;
};

export type ProfilePostType =
  | "status"
  | "market_research"
  | "trade_idea"
  | "indicator_release"
  | "strategy_note"
  | "group_announcement";

export type ProfilePostVisibility = "public" | "followers" | "private";

export type ProfilePost = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  postType: ProfilePostType;
  body: string;
  symbol?: string;
  timeframe?: string;
  marketCategory?: string;
  visibility: ProfilePostVisibility;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type PublishedIndicator = {
  id: string;
  userId: string;
  name: string;
  description: string;
  version: string;
  visibility: ProfilePostVisibility;
  metadata: Record<string, unknown>;
  updatedAt: number;
  createdAt: number;
};

export type PublishedStrategy = {
  id: string;
  userId: string;
  name: string;
  description: string;
  market: string;
  timeframe: string;
  riskProfile: "conservative" | "balanced" | "aggressive" | "custom";
  visibility: ProfilePostVisibility;
  metadata: Record<string, unknown>;
  updatedAt: number;
  createdAt: number;
};

export type UserFollow = {
  followerUserId: string;
  followedUserId: string;
  createdAt: number;
};

export type InvestmentGroupVisibility = "public" | "private" | "invite_only" | "password_protected";
export type InvestmentGroupAccessMode = "open" | "approval_required" | "invite_only" | "password_protected";
export type InvestmentGroupStatus = "draft" | "active" | "suspended" | "archived";
export type InvestmentGroupPublicSection =
  | "performance"
  | "drawdown"
  | "positions"
  | "research"
  | "members"
  | "trading_room"
  | "risk";

export type InvestmentGroupStats = {
  followerCount: number;
  connectedInvestorCount: number;
  connectedEquity: number;
  monthlyReturn: number | null;
  yearlyReturn: number | null;
  totalReturn: number | null;
  maxDrawdown: number | null;
  currentDrawdown: number | null;
  riskScore: number | null;
  winRate: number | null;
  profitFactor: number | null;
  averageTradeDuration: string | null;
  updatedAt: number;
  verified: boolean;
};

export type InvestmentGroup = {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  firmName: string;
  slug: string;
  description: string;
  bio: string;
  logoUrl: string;
  bannerUrl: string;
  visibility: InvestmentGroupVisibility;
  accessMode: InvestmentGroupAccessMode;
  passwordHash?: string;
  tradingStyleTags: string[];
  acceptedExchanges: string[];
  acceptedWallets: string[];
  minimumEquity?: number;
  maxFollowers?: number;
  approvalRequired: boolean;
  publicSections: InvestmentGroupPublicSection[];
  status: InvestmentGroupStatus;
  riskDisclaimer: string;
  managerTermsAccepted: boolean;
  createdAt: number;
  updatedAt: number;
  stats: InvestmentGroupStats;
};

export type InvestmentGroupMemberRole = "owner" | "manager" | "member";
export type InvestmentGroupMemberStatus = "active" | "pending" | "removed";

export type InvestmentGroupMember = {
  id: string;
  groupId: string;
  userId: string;
  username: string;
  role: InvestmentGroupMemberRole;
  status: InvestmentGroupMemberStatus;
  joinedAt: number;
  createdAt: number;
};

export type InvestmentGroupJoinRequest = {
  id: string;
  groupId: string;
  userId: string;
  username: string;
  message: string;
  status: "pending" | "approved" | "declined";
  reviewedBy?: string;
  reviewedAt?: number;
  createdAt: number;
};

export type TradingRoomChannel = "announcements" | "general" | "research" | "trades";

export type InvestmentGroupMessage = {
  id: string;
  groupId: string;
  channel: TradingRoomChannel;
  userId: string;
  username: string;
  role: InvestmentGroupMemberRole;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type InvestmentGroupModerationAction = "message_deleted" | "member_removed" | "role_changed";

export type InvestmentGroupModerationEvent = {
  id: string;
  groupId: string;
  action: InvestmentGroupModerationAction;
  actorUserId: string;
  actorUsername: string;
  targetUserId?: string;
  targetUsername?: string;
  messageId?: string;
  reason: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type ProfessionalNetworkNotificationType =
  | "new_follower"
  | "follow_request"
  | "investment_group_join_request"
  | "join_request_approved"
  | "join_request_declined"
  | "group_announcement"
  | "group_message"
  | "group_message_removed"
  | "group_member_removed"
  | "group_role_changed"
  | "new_research_post"
  | "group_created"
  | "group_suspended_by_admin";

export type ProfessionalNetworkNotification = {
  id: string;
  userId: string;
  eventType: ProfessionalNetworkNotificationType;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  readAt?: number;
  createdAt: number;
};

export type ProfessionalNetworkState = {
  profiles: ProfessionalProfile[];
  follows: UserFollow[];
  posts: ProfilePost[];
  indicators: PublishedIndicator[];
  strategies: PublishedStrategy[];
  groups: InvestmentGroup[];
  groupMembers: InvestmentGroupMember[];
  joinRequests: InvestmentGroupJoinRequest[];
  messages: InvestmentGroupMessage[];
  moderationEvents: InvestmentGroupModerationEvent[];
  notifications: ProfessionalNetworkNotification[];
};
