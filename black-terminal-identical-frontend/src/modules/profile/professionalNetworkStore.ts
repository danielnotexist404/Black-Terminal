import { blackCoreNotificationCenter } from "../../notifications/notificationCenter";
import {
  getCapabilities,
  resolveProductTier,
  type CapabilityUser
} from "../../core/permissions/capabilities";
import type {
  InvestmentGroup,
  InvestmentGroupJoinRequest,
  InvestmentGroupMember,
  InvestmentGroupMessage,
  ProfessionalNetworkNotification,
  ProfessionalNetworkNotificationType,
  ProfessionalNetworkState,
  ProfessionalProfile,
  ProfilePost,
  PublishedIndicator,
  PublishedStrategy,
  TradingRoomChannel
} from "./types";

const storageKey = "bt_professional_network_v1";

const emptyState: ProfessionalNetworkState = {
  profiles: [],
  follows: [],
  posts: [],
  indicators: [],
  strategies: [],
  groups: [],
  groupMembers: [],
  joinRequests: [],
  messages: [],
  notifications: []
};

export function userIdFromUsername(username: string) {
  return `user:${username.trim().toLowerCase()}`;
}

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function now() {
  return Date.now();
}

function readState(): ProfessionalNetworkState {
  if (typeof window === "undefined") return emptyState;

  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return { ...emptyState };
    const parsed = JSON.parse(stored) as Partial<ProfessionalNetworkState>;
    return {
      profiles: parsed.profiles ?? [],
      follows: parsed.follows ?? [],
      posts: parsed.posts ?? [],
      indicators: parsed.indicators ?? [],
      strategies: parsed.strategies ?? [],
      groups: parsed.groups ?? [],
      groupMembers: parsed.groupMembers ?? [],
      joinRequests: parsed.joinRequests ?? [],
      messages: parsed.messages ?? [],
      notifications: parsed.notifications ?? []
    };
  } catch {
    return { ...emptyState };
  }
}

function writeState(state: ProfessionalNetworkState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function mutate(mutator: (state: ProfessionalNetworkState) => void) {
  const state = readState();
  mutator(state);
  writeState(state);
  return state;
}

export function canCreateInvestmentGroup(user: CapabilityUser | null | undefined) {
  const capabilities = getCapabilities(user);
  return capabilities.has("can_create_investment_group") || capabilities.has("admin.override");
}

export function canManageInvestmentGroup(user: CapabilityUser | null | undefined, group?: InvestmentGroup) {
  if (!user) return false;
  const capabilities = getCapabilities(user);
  return (
    capabilities.has("admin.override") ||
    (capabilities.has("can_manage_investment_group") && group ? group.ownerUserId === userIdFromUsername(user.username) : false)
  );
}

export function ensureProfessionalProfile(user: CapabilityUser): ProfessionalProfile {
  const userId = userIdFromUsername(user.username);
  const tier = resolveProductTier(user);
  let profile = readState().profiles.find((item) => item.userId === userId);

  if (profile) return profile;

  const created: ProfessionalProfile = {
    userId,
    username: user.username,
    displayName: user.username,
    bio: "",
    avatarUrl: "",
    bannerUrl: "",
    tradingStyleTags: [],
    showPublicStats: false,
    showPublicPnl: false,
    showPublicDrawdown: false,
    showPublicEquityCurve: false,
    showVerifiedExchangePerformance: false,
    joinedAt: now(),
    productTier: tier,
    verified: tier === "admin"
  };

  mutate((state) => {
    state.profiles.unshift(created);
  });
  profile = created;
  return profile;
}

export function upsertProfile(user: CapabilityUser, patch: Partial<ProfessionalProfile>) {
  const base = ensureProfessionalProfile(user);
  const next: ProfessionalProfile = {
    ...base,
    ...patch,
    userId: base.userId,
    username: base.username,
    productTier: resolveProductTier(user)
  };

  mutate((state) => {
    const index = state.profiles.findIndex((item) => item.userId === base.userId);
    if (index >= 0) state.profiles[index] = next;
    else state.profiles.unshift(next);
  });

  return next;
}

export function getProfessionalNetworkSnapshot(user: CapabilityUser) {
  const profile = ensureProfessionalProfile(user);
  const state = readState();
  const followerCount = state.follows.filter((item) => item.followedUserId === profile.userId).length;
  const followingCount = state.follows.filter((item) => item.followerUserId === profile.userId).length;
  const followingIds = new Set(state.follows.filter((item) => item.followerUserId === profile.userId).map((item) => item.followedUserId));
  const ownPosts = state.posts.filter((item) => item.userId === profile.userId);
  const researchFeed = state.posts
    .filter((post) => {
      if (post.userId === profile.userId) return true;
      if (!followingIds.has(post.userId)) return false;
      return post.visibility === "public" || post.visibility === "followers";
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return {
    state,
    profile,
    followerCount,
    followingCount,
    followers: state.follows
      .filter((item) => item.followedUserId === profile.userId)
      .map((item) => state.profiles.find((profileItem) => profileItem.userId === item.followerUserId))
      .filter(Boolean) as ProfessionalProfile[],
    following: state.follows
      .filter((item) => item.followerUserId === profile.userId)
      .map((item) => state.profiles.find((profileItem) => profileItem.userId === item.followedUserId))
      .filter(Boolean) as ProfessionalProfile[],
    ownPosts,
    researchFeed,
    indicators: state.indicators.filter((item) => item.userId === profile.userId),
    strategies: state.strategies.filter((item) => item.userId === profile.userId),
    ownedGroups: state.groups.filter((item) => item.ownerUserId === profile.userId),
    joinedGroups: state.groupMembers
      .filter((item) => item.userId === profile.userId && item.status === "active")
      .map((member) => state.groups.find((group) => group.id === member.groupId))
      .filter(Boolean) as InvestmentGroup[],
    notifications: state.notifications.filter((item) => item.userId === profile.userId)
  };
}

export function publishProfilePost(user: CapabilityUser, draft: Omit<ProfilePost, "id" | "userId" | "username" | "displayName" | "createdAt" | "updatedAt">) {
  const capabilities = getCapabilities(user);
  if (!capabilities.has("can_publish_research") && !capabilities.has("admin.override")) {
    throw new Error("Research publishing requires a professional network publishing capability.");
  }

  const profile = ensureProfessionalProfile(user);
  const timestamp = now();
  const post: ProfilePost = {
    ...draft,
    id: makeId("post"),
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  mutate((state) => {
    state.posts.unshift(post);
    state.follows
      .filter((follow) => follow.followedUserId === profile.userId)
      .forEach((follow) => {
        state.notifications.unshift(makeNotification(follow.followerUserId, "new_research_post", "New Research Post", `${profile.displayName} published market research.`, { postId: post.id }));
      });
  });

  blackCoreNotificationCenter.push({
    severity: "success",
    title: "Research Published",
    message: "Your research post was added to the professional feed."
  });

  return post;
}

export function publishIndicator(user: CapabilityUser, draft: Omit<PublishedIndicator, "id" | "userId" | "createdAt" | "updatedAt">) {
  const capabilities = getCapabilities(user);
  if (!capabilities.has("can_publish_indicators") && !capabilities.has("admin.override")) {
    throw new Error("Publishing indicators requires professional or higher permissions.");
  }

  const profile = ensureProfessionalProfile(user);
  const timestamp = now();
  const indicator: PublishedIndicator = {
    ...draft,
    id: makeId("indicator"),
    userId: profile.userId,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  mutate((state) => {
    state.indicators.unshift(indicator);
  });
  return indicator;
}

export function publishStrategy(user: CapabilityUser, draft: Omit<PublishedStrategy, "id" | "userId" | "createdAt" | "updatedAt">) {
  const capabilities = getCapabilities(user);
  if (!capabilities.has("can_publish_strategies") && !capabilities.has("admin.override")) {
    throw new Error("Publishing strategies requires professional or higher permissions.");
  }

  const profile = ensureProfessionalProfile(user);
  const timestamp = now();
  const strategy: PublishedStrategy = {
    ...draft,
    id: makeId("strategy"),
    userId: profile.userId,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  mutate((state) => {
    state.strategies.unshift(strategy);
  });
  return strategy;
}

export function followProfessionalUser(currentUser: CapabilityUser, username: string) {
  const capabilities = getCapabilities(currentUser);
  if (!capabilities.has("can_follow_users") && !capabilities.has("admin.override")) {
    throw new Error("Following users is not enabled for this account.");
  }

  const follower = ensureProfessionalProfile(currentUser);
  const targetUsername = username.trim();
  if (!targetUsername) throw new Error("Enter a username to follow.");
  if (targetUsername.toLowerCase() === currentUser.username.toLowerCase()) throw new Error("You cannot follow your own profile.");

  const followedUserId = userIdFromUsername(targetUsername);
  mutate((state) => {
    let followed = state.profiles.find((item) => item.userId === followedUserId);
    if (!followed) {
      followed = {
        userId: followedUserId,
        username: targetUsername,
        displayName: targetUsername,
        bio: "",
        avatarUrl: "",
        bannerUrl: "",
        tradingStyleTags: [],
        showPublicStats: false,
        showPublicPnl: false,
        showPublicDrawdown: false,
        showPublicEquityCurve: false,
        showVerifiedExchangePerformance: false,
        joinedAt: now(),
        productTier: "retail",
        verified: false
      };
      state.profiles.unshift(followed);
    }

    const exists = state.follows.some((item) => item.followerUserId === follower.userId && item.followedUserId === followedUserId);
    if (!exists) {
      state.follows.unshift({ followerUserId: follower.userId, followedUserId, createdAt: now() });
      state.notifications.unshift(makeNotification(followedUserId, "new_follower", "New Follower", `${follower.displayName} followed your professional profile.`, { followerUserId: follower.userId }));
    }
  });
}

export function unfollowProfessionalUser(currentUser: CapabilityUser, followedUserId: string) {
  const followerUserId = userIdFromUsername(currentUser.username);
  mutate((state) => {
    state.follows = state.follows.filter((item) => !(item.followerUserId === followerUserId && item.followedUserId === followedUserId));
  });
}

export function createInvestmentGroup(user: CapabilityUser, draft: Omit<InvestmentGroup, "id" | "ownerUserId" | "ownerUsername" | "slug" | "status" | "createdAt" | "updatedAt" | "stats">) {
  if (!canCreateInvestmentGroup(user)) {
    throw new Error("Investment group creation is restricted to Enterprise and Admin accounts.");
  }

  const owner = ensureProfessionalProfile(user);
  const timestamp = now();
  const group: InvestmentGroup = {
    ...draft,
    id: makeId("group"),
    ownerUserId: owner.userId,
    ownerUsername: owner.username,
    slug: slugify(draft.firmName),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    stats: {
      followerCount: 0,
      connectedInvestorCount: 0,
      connectedEquity: 0,
      monthlyReturn: null,
      yearlyReturn: null,
      totalReturn: null,
      maxDrawdown: null,
      currentDrawdown: null,
      riskScore: null,
      winRate: null,
      profitFactor: null,
      averageTradeDuration: null,
      updatedAt: timestamp,
      verified: false
    }
  };

  mutate((state) => {
    state.groups.unshift(group);
    state.groupMembers.unshift({
      id: makeId("member"),
      groupId: group.id,
      userId: owner.userId,
      username: owner.username,
      role: "owner",
      status: "active",
      joinedAt: timestamp,
      createdAt: timestamp
    });
    state.notifications.unshift(makeNotification(owner.userId, "group_created", "Investment Group Created", `${group.firmName} is now available in your managed groups.`, { groupId: group.id }));
  });

  blackCoreNotificationCenter.push({
    severity: "success",
    title: "Investment Group Created",
    message: `${group.firmName} was added to the professional network.`
  });

  return group;
}

export function updateInvestmentGroup(
  user: CapabilityUser,
  groupId: string,
  patch: Partial<Pick<InvestmentGroup,
    | "firmName"
    | "description"
    | "bio"
    | "logoUrl"
    | "bannerUrl"
    | "visibility"
    | "accessMode"
    | "passwordHash"
    | "tradingStyleTags"
    | "acceptedExchanges"
    | "acceptedWallets"
    | "minimumEquity"
    | "maxFollowers"
    | "approvalRequired"
    | "riskDisclaimer"
  >>
) {
  const state = readState();
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) throw new Error("Investment group not found.");
  if (!canManageInvestmentGroup(user, group)) throw new Error("You do not have permission to edit this investment group.");

  const firmName = patch.firmName?.trim();
  if (patch.firmName !== undefined && !firmName) throw new Error("Firm name is required.");

  let updated: InvestmentGroup | undefined;
  mutate((draftState) => {
    const target = draftState.groups.find((item) => item.id === groupId);
    if (!target) throw new Error("Investment group not found.");
    Object.assign(target, {
      ...patch,
      ...(firmName ? { firmName, slug: slugify(firmName) } : {}),
      updatedAt: now()
    });
    updated = target;
  });

  blackCoreNotificationCenter.push({
    severity: "success",
    title: "Investment Group Updated",
    message: `${updated?.firmName ?? group.firmName} settings were saved.`
  });

  return updated ?? group;
}

export function requestToJoinGroup(user: CapabilityUser, groupId: string, message: string, passwordHash?: string) {
  const profile = ensureProfessionalProfile(user);
  const state = readState();
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) throw new Error("Investment group not found.");
  if (group.accessMode === "password_protected" && group.passwordHash && group.passwordHash !== passwordHash) {
    throw new Error("Investment group password check failed.");
  }

  const existingMember = state.groupMembers.find((item) => item.groupId === groupId && item.userId === profile.userId && item.status === "active");
  if (existingMember) throw new Error("You are already a member of this group.");

  const existingRequest = state.joinRequests.find((item) => item.groupId === groupId && item.userId === profile.userId && item.status === "pending");
  if (existingRequest) return existingRequest;

  const request: InvestmentGroupJoinRequest = {
    id: makeId("request"),
    groupId,
    userId: profile.userId,
    username: profile.username,
    message,
    status: "pending",
    createdAt: now()
  };

  mutate((draftState) => {
    draftState.joinRequests.unshift(request);
    draftState.notifications.unshift(makeNotification(group.ownerUserId, "investment_group_join_request", "Investment Group Join Request", `${profile.displayName} requested access to ${group.firmName}.`, { groupId, requestId: request.id }));
  });

  return request;
}

export function reviewJoinRequest(user: CapabilityUser, requestId: string, action: "approve" | "decline") {
  const state = readState();
  const request = state.joinRequests.find((item) => item.id === requestId);
  if (!request) throw new Error("Join request not found.");
  const group = state.groups.find((item) => item.id === request.groupId);
  if (!group) throw new Error("Investment group not found.");
  if (!canManageInvestmentGroup(user, group)) throw new Error("You do not have permission to review this request.");

  const reviewer = ensureProfessionalProfile(user);
  mutate((draftState) => {
    const target = draftState.joinRequests.find((item) => item.id === requestId);
    if (!target) return;
    target.status = action === "approve" ? "approved" : "declined";
    target.reviewedAt = now();
    target.reviewedBy = reviewer.userId;

    if (action === "approve") {
      const memberExists = draftState.groupMembers.some((item) => item.groupId === group.id && item.userId === target.userId);
      if (!memberExists) {
        draftState.groupMembers.unshift({
          id: makeId("member"),
          groupId: group.id,
          userId: target.userId,
          username: target.username,
          role: "member",
          status: "active",
          joinedAt: now(),
          createdAt: now()
        });
        const draftGroup = draftState.groups.find((item) => item.id === group.id);
        if (draftGroup) draftGroup.stats.followerCount += 1;
      }
    }

    draftState.notifications.unshift(makeNotification(
      target.userId,
      action === "approve" ? "join_request_approved" : "join_request_declined",
      action === "approve" ? "Join Request Approved" : "Join Request Declined",
      `${group.firmName} ${action === "approve" ? "approved" : "declined"} your access request.`,
      { groupId: group.id, requestId }
    ));
  });
}

export function postGroupMessage(user: CapabilityUser, groupId: string, channel: TradingRoomChannel, body: string) {
  const profile = ensureProfessionalProfile(user);
  const state = readState();
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) throw new Error("Investment group not found.");

  const member = state.groupMembers.find((item) => item.groupId === groupId && item.userId === profile.userId && item.status === "active");
  const canManage = canManageInvestmentGroup(user, group);
  if (!member && !canManage) throw new Error("Trading Room access requires group membership.");
  if (channel === "announcements" && !canManage) throw new Error("Only group owners or admins can post announcements.");

  const role = member?.role ?? "manager";
  const message: InvestmentGroupMessage = {
    id: makeId("message"),
    groupId,
    channel,
    userId: profile.userId,
    username: profile.username,
    role,
    body,
    metadata: {},
    createdAt: now()
  };

  mutate((draftState) => {
    draftState.messages.unshift(message);
    draftState.groupMembers
      .filter((item) => item.groupId === groupId && item.userId !== profile.userId && item.status === "active")
      .forEach((memberItem) => {
        draftState.notifications.unshift(makeNotification(
          memberItem.userId,
          channel === "announcements" ? "group_announcement" : "group_message",
          channel === "announcements" ? "Group Announcement" : "Trading Room Message",
          `${group.firmName}: ${body.slice(0, 90)}`,
          { groupId, messageId: message.id, channel }
        ));
      });
  });

  return message;
}

export function listInvestmentGroups(user?: CapabilityUser | null) {
  if (user) ensureProfessionalProfile(user);
  const userId = user ? userIdFromUsername(user.username) : "";
  const state = readState();
  return {
    state,
    publicGroups: state.groups.filter((item) => item.status === "active" && item.visibility === "public"),
    myGroups: state.groups.filter((item) => item.ownerUserId === userId || state.groupMembers.some((member) => member.groupId === item.id && member.userId === userId && member.status === "active")),
    pendingRequests: state.joinRequests.filter((item) => state.groups.some((group) => group.id === item.groupId && group.ownerUserId === userId) && item.status === "pending")
  };
}

function makeNotification(
  userId: string,
  eventType: ProfessionalNetworkNotificationType,
  title: string,
  body: string,
  metadata: Record<string, unknown>
): ProfessionalNetworkNotification {
  return {
    id: makeId("notification"),
    userId,
    eventType,
    title,
    body,
    metadata,
    createdAt: now()
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `group-${Date.now()}`;
}
