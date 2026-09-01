import { deleteLocalDocument, getLocalDocument, putLocalDocument } from "../../core/local-runtime/localDocumentStore";
import { listLocalP2pInbox, publishLocalP2p, sendLocalP2pDirect } from "../../core/local-runtime/localP2pClient";
import { getCachedLocalRuntimeStatus } from "../../core/local-runtime/localRuntimeClient";
import { listAllLocalInvestmentGroups } from "../profile/professionalNetworkStore";
import type {
  CommentReactionType,
  ConversationSummary,
  DirectMessage,
  FeedMode,
  NetworkNotification,
  NotificationPreferences,
  PostMedia,
  ProfilePayload,
  ProfessionalProfile,
  ReactionType,
  SavedCollection,
  SearchResults,
  SocialComment,
  SocialPost,
} from "./types";

const namespace = "professional-network";
const stateKey = "social-state-v1";
const mediaNamespace = "professional-media";
const pageSize = 50;
const defaultPreferences: NotificationPreferences = {
  follows: true,
  reactions: true,
  comments: true,
  reposts: true,
  messages: true,
  mentions: true,
  group_activity: true,
  indicator_updates: true,
  email_digest: "off",
};

type LocalAsset = Record<string, unknown> & { id: string; user_id: string; type: "indicator" | "strategy"; visibility: string; created_at: string };
type LocalConversation = ConversationSummary & { participantIds: string[] };
type LocalMediaDocument = { mimeType: string; base64: string; byteSize: number; scope: string; createdAt: string };
type LocalSocialState = {
  schemaVersion: 1;
  profiles: ProfessionalProfile[];
  posts: SocialPost[];
  assets: LocalAsset[];
  following: string[];
  muted: string[];
  blocked: string[];
  hiddenPostIds: string[];
  collections: SavedCollection[];
  savedPosts: Array<{ postId: string; collectionId: string }>;
  conversations: LocalConversation[];
  messages: DirectMessage[];
  notifications: NetworkNotification[];
  notificationPreferences: NotificationPreferences;
  moderationReports: Array<Record<string, unknown>>;
  processedP2pMessageIds: string[];
};

type PublicP2pEvent = {
  schemaVersion: 1;
  kind: "profile" | "post" | "asset";
  entity: Record<string, unknown>;
};

type DirectP2pEvent = {
  schemaVersion: 1;
  kind: "direct-message";
  senderProfile: Record<string, unknown>;
  message: Record<string, unknown>;
};

function identifier(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function iso() {
  return new Date().toISOString();
}

function runtimeIdentity() {
  const config = getCachedLocalRuntimeStatus()?.config;
  if (!config) throw new Error("The local owner identity is unavailable.");
  return {
    userId: `peer:${config.peerId}`,
    peerId: config.peerId,
    displayName: config.profile.displayName,
    username: config.profile.username,
  };
}

function normalizedHandle(value: string) {
  const clean = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 48);
  return clean || `peer-${runtimeIdentity().peerId.slice(-10).toLowerCase()}`;
}

function directConversationId(firstPeerId: string, secondPeerId: string) {
  return `dm:${[firstPeerId, secondPeerId].sort().join(":")}`;
}

function defaultProfile(): ProfessionalProfile {
  const owner = runtimeIdentity();
  return {
    user_id: owner.userId,
    handle: normalizedHandle(owner.username.split("@")[0] || owner.username),
    display_name: owner.displayName,
    headline: "Independent Black Terminal operator",
    bio: "",
    professional_role: "Trader",
    organization: null,
    website_url: null,
    location: null,
    country: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    market_specialties: [],
    asset_classes: ["Crypto"],
    trading_style_tags: [],
    avatar_storage_path: null,
    banner_storage_path: null,
    avatar_signed_url: null,
    banner_signed_url: null,
    profile_visibility: "public",
    message_policy: "everyone",
    show_public_stats: false,
    show_public_pnl: false,
    show_public_drawdown: false,
    show_public_equity_curve: false,
    show_verified_exchange_performance: false,
    show_positions: false,
    show_groups: true,
    verified_role: false,
    verified_performance_source: null,
    created_at: iso(),
    updated_at: iso(),
  };
}

function emptyState(): LocalSocialState {
  const profile = defaultProfile();
  return {
    schemaVersion: 1,
    profiles: [profile],
    posts: [],
    assets: [],
    following: [],
    muted: [],
    blocked: [],
    hiddenPostIds: [],
    collections: [{ id: "local-default", name: "Saved", is_default: true, social_saved_posts: [{ count: 0 }] }],
    savedPosts: [],
    conversations: [],
    messages: [],
    notifications: [],
    notificationPreferences: { ...defaultPreferences },
    moderationReports: [],
    processedP2pMessageIds: [],
  };
}

function normalizeState(value?: Partial<LocalSocialState> | null): LocalSocialState {
  const base = emptyState();
  if (!value || value.schemaVersion !== 1) return base;
  const own = base.profiles[0];
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  return {
    ...base,
    ...value,
    schemaVersion: 1,
    profiles: [profiles.find((profile) => profile.user_id === own.user_id) || own, ...profiles.filter((profile) => profile.user_id !== own.user_id)],
    posts: Array.isArray(value.posts) ? value.posts : [],
    assets: Array.isArray(value.assets) ? value.assets : [],
    following: Array.isArray(value.following) ? value.following : [],
    muted: Array.isArray(value.muted) ? value.muted : [],
    blocked: Array.isArray(value.blocked) ? value.blocked : [],
    hiddenPostIds: Array.isArray(value.hiddenPostIds) ? value.hiddenPostIds : [],
    collections: Array.isArray(value.collections) && value.collections.length ? value.collections : base.collections,
    savedPosts: Array.isArray(value.savedPosts) ? value.savedPosts : [],
    conversations: Array.isArray(value.conversations) ? value.conversations : [],
    messages: Array.isArray(value.messages) ? value.messages : [],
    notifications: Array.isArray(value.notifications) ? value.notifications : [],
    notificationPreferences: { ...defaultPreferences, ...(value.notificationPreferences || {}) },
    moderationReports: Array.isArray(value.moderationReports) ? value.moderationReports : [],
    processedP2pMessageIds: Array.isArray(value.processedP2pMessageIds) ? value.processedP2pMessageIds.slice(-2_000) : [],
  };
}

async function readState(ingest = true) {
  const document = await getLocalDocument<LocalSocialState>(namespace, stateKey);
  let state = normalizeState(document?.value);
  if (!document) await putLocalDocument(namespace, stateKey, state, 0);
  if (ingest) state = await ingestP2p(state, document?.revision);
  return state;
}

async function saveState(state: LocalSocialState, expectedRevision?: number) {
  const saved = await putLocalDocument(namespace, stateKey, state, expectedRevision);
  if (!saved) throw new Error("The encrypted local Professional Center store is unavailable.");
  return saved;
}

async function mutate<T>(operation: (state: LocalSocialState) => T | Promise<T>) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getLocalDocument<LocalSocialState>(namespace, stateKey);
    const state = normalizeState(current?.value);
    const result = await operation(state);
    try {
      await saveState(state, current?.revision ?? 0);
      return result;
    } catch (error) {
      if (!String(error).includes("LOCAL_DOCUMENT_REVISION_CONFLICT") || attempt === 3) throw error;
    }
  }
  throw new Error("The local Professional Center state changed concurrently.");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicProfile(value: unknown, peerId: string): ProfessionalProfile | null {
  const raw = object(value);
  const handle = normalizedHandle(String(raw.handle || `peer-${peerId.slice(-10)}`));
  const now = iso();
  if (String(raw.profile_visibility || "public") !== "public") return null;
  return {
    ...defaultProfile(),
    ...raw,
    user_id: `peer:${peerId}`,
    handle,
    display_name: String(raw.display_name || handle).slice(0, 100),
    profile_visibility: "public",
    avatar_storage_path: null,
    banner_storage_path: null,
    avatar_signed_url: null,
    banner_signed_url: null,
    created_at: String(raw.created_at || now),
    updated_at: String(raw.updated_at || now),
  } as ProfessionalProfile;
}

function publicPost(value: unknown, peerId: string, profile?: ProfessionalProfile): SocialPost | null {
  const raw = object(value);
  if (String(raw.visibility || "private") !== "public" || !String(raw.id || "").trim()) return null;
  return {
    id: String(raw.id),
    user_id: `peer:${peerId}`,
    post_type: String(raw.post_type || "status"),
    title: raw.title == null ? null : String(raw.title).slice(0, 240),
    body: String(raw.body || "").slice(0, 20_000),
    summary: raw.summary == null ? null : String(raw.summary).slice(0, 600),
    asset_class: raw.asset_class == null ? null : String(raw.asset_class),
    directional_bias: raw.directional_bias == null ? null : String(raw.directional_bias),
    timeframe: raw.timeframe == null ? null : String(raw.timeframe),
    visibility: "public",
    risk_disclaimer: String(raw.risk_disclaimer || ""),
    status: "published",
    metadata: object(raw.metadata),
    edited_at: raw.edited_at == null ? null : String(raw.edited_at),
    created_at: String(raw.created_at || iso()),
    author: profile ? authorFromProfile(profile) : null,
    symbols: Array.isArray(raw.symbols) ? raw.symbols.map(String).slice(0, 20) : [],
    media: [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments.slice(0, 8) as SocialPost["attachments"] : [],
    reactions: {},
    viewerReaction: null,
    comments: [],
    commentCount: Number(raw.commentCount || 0),
    repostCount: Number(raw.repostCount || 0),
    viewerReposted: false,
    saved: false,
  };
}

function publicAsset(value: unknown, peerId: string): LocalAsset | null {
  const raw = object(value);
  if (String(raw.visibility || "private") !== "public" || !String(raw.id || "").trim()) return null;
  const type = raw.type === "strategy" ? "strategy" : raw.type === "indicator" ? "indicator" : null;
  if (!type) return null;
  return { ...raw, id: String(raw.id), user_id: `peer:${peerId}`, type, visibility: "public", created_at: String(raw.created_at || iso()) } as LocalAsset;
}

async function ingestP2p(source: LocalSocialState, sourceRevision?: number) {
  const inbox = await listLocalP2pInbox(500).catch(() => []);
  const pending = inbox.filter((message) => (message.topic.includes("social") || message.topic.includes("direct")) && !source.processedP2pMessageIds.includes(message.messageId));
  if (!pending.length) return source;
  const state = structuredClone(source);
  for (const message of pending.reverse()) {
    const envelope = object(message.payload);
    const event = object(envelope.payload) as PublicP2pEvent | DirectP2pEvent;
    if (event.schemaVersion !== 1) continue;
    if (event.kind === "direct-message") {
      const owner = runtimeIdentity();
      const profile = publicProfile({ ...event.senderProfile, profile_visibility: "public" }, message.sourcePeerId);
      const rawMessage = object(event.message);
      const body = String(rawMessage.body || "").slice(0, 8_000);
      const messageId = String(rawMessage.id || message.messageId);
      if (profile && messageId && body) {
        state.profiles = [profile, ...state.profiles.filter((item) => item.user_id !== profile.user_id)];
        const conversationId = directConversationId(owner.peerId, message.sourcePeerId);
        let conversation = state.conversations.find((item) => item.id === conversationId);
        if (!conversation) {
          conversation = {
            id: conversationId,
            conversation_type: "direct",
            title: null,
            last_message_at: null,
            participants: [{ user_id: profile.user_id, handle: profile.handle, display_name: profile.display_name, professional_role: profile.professional_role }],
            request: { status: "accepted", sender_user_id: profile.user_id, recipient_user_id: `peer:${owner.peerId}` },
            lastMessage: null,
            read: null,
            membership: { archived_at: null, muted_until: null },
            participantIds: [`peer:${owner.peerId}`, profile.user_id],
          };
          state.conversations.push(conversation);
        }
        const directMessage: DirectMessage = {
          id: messageId,
          conversation_id: conversationId,
          sender_user_id: profile.user_id,
          body,
          message_type: String(rawMessage.message_type || "text"),
          shared_object_type: rawMessage.shared_object_type ? String(rawMessage.shared_object_type) : null,
          shared_object_id: rawMessage.shared_object_id ? String(rawMessage.shared_object_id) : null,
          created_at: String(rawMessage.created_at || iso()),
          attachments: [],
        };
        if (!state.messages.some((item) => item.id === directMessage.id)) state.messages.push(directMessage);
        conversation.last_message_at = directMessage.created_at;
        conversation.lastMessage = { id: directMessage.id, body: directMessage.body, message_type: directMessage.message_type, sender_user_id: directMessage.sender_user_id, created_at: directMessage.created_at };
        state.notifications.unshift(notification("message", "Encrypted P2P Message", `${profile.display_name || profile.handle} sent a direct message.`, profile));
      }
    }
    if (event.kind === "profile") {
      const profile = publicProfile(event.entity, message.sourcePeerId);
      if (profile) state.profiles = [profile, ...state.profiles.filter((item) => item.user_id !== profile.user_id)];
    }
    if (event.kind === "post") {
      const profile = state.profiles.find((item) => item.user_id === `peer:${message.sourcePeerId}`);
      const post = publicPost(event.entity, message.sourcePeerId, profile);
      if (post && !state.blocked.includes(post.user_id)) state.posts = [post, ...state.posts.filter((item) => item.id !== post.id)];
    }
    if (event.kind === "asset") {
      const asset = publicAsset(event.entity, message.sourcePeerId);
      if (asset) state.assets = [asset, ...state.assets.filter((item) => item.id !== asset.id)];
    }
    state.processedP2pMessageIds.push(message.messageId);
  }
  state.processedP2pMessageIds = state.processedP2pMessageIds.slice(-2_000);
  try {
    const saved = await saveState(state, sourceRevision ?? 0);
    return normalizeState(saved.value);
  } catch (error) {
    if (String(error).includes("LOCAL_DOCUMENT_REVISION_CONFLICT")) return readState(false);
    throw error;
  }
}

function broadcast(kind: PublicP2pEvent["kind"], entity: Record<string, unknown>) {
  void publishLocalP2p("social", { schemaVersion: 1, kind, entity }).catch(() => undefined);
}

function ownProfile(state: LocalSocialState) {
  const userId = runtimeIdentity().userId;
  return state.profiles.find((profile) => profile.user_id === userId) || state.profiles[0];
}

function authorFromProfile(profile: ProfessionalProfile) {
  return {
    user_id: profile.user_id,
    handle: profile.handle,
    display_name: profile.display_name,
    professional_role: profile.professional_role,
    avatar_signed_url: profile.avatar_signed_url,
    verified_role: profile.verified_role,
  };
}

function relationshipProfile(profile: ProfessionalProfile) {
  return {
    user_id: profile.user_id,
    handle: profile.handle,
    display_name: profile.display_name,
    headline: profile.headline,
    professional_role: profile.professional_role,
    verified_role: profile.verified_role,
  };
}

async function materializeMedia(media: PostMedia[]) {
  return Promise.all(media.map(async (item) => {
    if (!item.storage_path.startsWith("local-media:")) return item;
    const document = await getLocalDocument<LocalMediaDocument>(mediaNamespace, item.storage_path.slice("local-media:".length));
    return { ...item, signed_url: document ? `data:${document.value.mimeType};base64,${document.value.base64}` : null };
  }));
}

async function materializePost(post: SocialPost) {
  return { ...post, media: await materializeMedia(post.media || []) };
}

async function profilePayload(state: LocalSocialState, profile: ProfessionalProfile): Promise<ProfilePayload> {
  const viewer = ownProfile(state);
  const followers = state.profiles.filter((candidate) => state.following.includes(viewer.user_id) && candidate.user_id === viewer.user_id);
  const groups = listAllLocalInvestmentGroups().filter((group) => group.ownerUserId === profile.user_id || group.ownerUsername.toLowerCase() === profile.handle.toLowerCase());
  const avatar = profile.avatar_storage_path?.startsWith("local-media:")
    ? (await materializeMedia([{ id: "avatar", storage_path: profile.avatar_storage_path, signed_url: null, media_type: "image", alt_text: "Profile avatar" }]))[0].signed_url
    : profile.avatar_signed_url;
  const banner = profile.banner_storage_path?.startsWith("local-media:")
    ? (await materializeMedia([{ id: "banner", storage_path: profile.banner_storage_path, signed_url: null, media_type: "image", alt_text: "Profile banner" }]))[0].signed_url
    : profile.banner_signed_url;
  return {
    profile: { ...profile, avatar_signed_url: avatar, banner_signed_url: banner },
    viewer: {
      isOwner: profile.user_id === viewer.user_id,
      isFollowing: state.following.includes(profile.user_id),
      isBlocked: state.blocked.includes(profile.user_id),
      isMuted: state.muted.includes(profile.user_id),
    },
    credibility: {
      followers: followers.length,
      following: profile.user_id === viewer.user_id ? state.following.length : 0,
      research: state.posts.filter((post) => post.user_id === profile.user_id && post.post_type.includes("research")).length,
      indicators: state.assets.filter((asset) => asset.user_id === profile.user_id && asset.type === "indicator").length,
      strategies: state.assets.filter((asset) => asset.user_id === profile.user_id && asset.type === "strategy").length,
      groups: groups.length,
    },
    groups: groups.map((group) => ({ id: group.id, firm_name: group.firmName, slug: group.slug, description: group.description, visibility: group.visibility })),
    followers: [],
    following: state.profiles.filter((candidate) => profile.user_id === viewer.user_id && state.following.includes(candidate.user_id)).map(relationshipProfile),
  };
}

function postForViewer(state: LocalSocialState, post: SocialPost) {
  const viewer = ownProfile(state);
  const saved = state.savedPosts.some((item) => item.postId === post.id);
  return { ...post, saved, author: state.profiles.find((profile) => profile.user_id === post.user_id) ? authorFromProfile(state.profiles.find((profile) => profile.user_id === post.user_id)!) : post.author, viewerReaction: post.user_id === viewer.user_id ? post.viewerReaction : post.viewerReaction };
}

function cursorSlice<T>(items: T[], cursor?: string) {
  const offset = Math.max(0, Number.parseInt(cursor || "0", 10) || 0);
  return { items: items.slice(offset, offset + pageSize), nextCursor: offset + pageSize < items.length ? String(offset + pageSize) : null };
}

function requireOwnedPost(state: LocalSocialState, postId: string) {
  const post = state.posts.find((item) => item.id === postId);
  if (!post) throw new Error("The professional post was not found.");
  if (post.user_id !== ownProfile(state).user_id) throw new Error("Only the author can modify this post.");
  return post;
}

function notification(eventType: string, title: string, body: string, actor?: ProfessionalProfile): NetworkNotification {
  return { id: identifier("notification"), event_type: eventType, title, body, deep_link: null, read_at: null, created_at: iso(), actor_user_id: actor?.user_id, actor: actor ? authorFromProfile(actor) : null };
}

export const localProfessionalNetworkApi = {
  async profile(handle?: string) {
    const state = await readState();
    const profile = handle ? state.profiles.find((item) => item.handle.toLowerCase() === handle.toLowerCase()) : ownProfile(state);
    if (!profile) throw new Error("That P2P professional profile has not been discovered on this device.");
    return profilePayload(state, profile);
  },
  async updateProfile(patch: Record<string, unknown>) {
    let updated!: ProfessionalProfile;
    await mutate(async (state) => {
      const current = ownProfile(state);
      updated = {
        ...current,
        handle: patch.handle === undefined ? current.handle : normalizedHandle(String(patch.handle)),
        display_name: patch.displayName === undefined ? current.display_name : String(patch.displayName).trim().slice(0, 100),
        headline: patch.headline === undefined ? current.headline : String(patch.headline).slice(0, 180),
        bio: patch.bio === undefined ? current.bio : String(patch.bio).slice(0, 4_000),
        professional_role: patch.professionalRole === undefined ? current.professional_role : String(patch.professionalRole).slice(0, 100),
        organization: patch.organization === undefined ? current.organization : String(patch.organization || "") || null,
        website_url: patch.websiteUrl === undefined ? current.website_url : String(patch.websiteUrl || "") || null,
        location: patch.location === undefined ? current.location : String(patch.location || "") || null,
        country: patch.country === undefined ? current.country : String(patch.country || "") || null,
        timezone: patch.timezone === undefined ? current.timezone : String(patch.timezone || "") || null,
        market_specialties: Array.isArray(patch.marketSpecialties) ? patch.marketSpecialties.map(String).slice(0, 30) : current.market_specialties,
        asset_classes: Array.isArray(patch.assetClasses) ? patch.assetClasses.map(String).slice(0, 30) : current.asset_classes,
        trading_style_tags: Array.isArray(patch.tradingStyleTags) ? patch.tradingStyleTags.map(String).slice(0, 30) : current.trading_style_tags,
        profile_visibility: ["public", "followers", "private"].includes(String(patch.profileVisibility)) ? patch.profileVisibility as ProfessionalProfile["profile_visibility"] : current.profile_visibility,
        message_policy: ["everyone", "followers", "nobody"].includes(String(patch.messagePolicy)) ? patch.messagePolicy as ProfessionalProfile["message_policy"] : current.message_policy,
        show_public_stats: patch.showPublicStats === undefined ? current.show_public_stats : patch.showPublicStats === true,
        show_public_pnl: patch.showPublicPnl === undefined ? current.show_public_pnl : patch.showPublicPnl === true,
        show_public_drawdown: patch.showPublicDrawdown === undefined ? current.show_public_drawdown : patch.showPublicDrawdown === true,
        show_public_equity_curve: patch.showPublicEquityCurve === undefined ? current.show_public_equity_curve : patch.showPublicEquityCurve === true,
        show_verified_exchange_performance: patch.showVerifiedExchangePerformance === undefined ? current.show_verified_exchange_performance : patch.showVerifiedExchangePerformance === true,
        show_positions: patch.showPositions === undefined ? current.show_positions : patch.showPositions === true,
        show_groups: patch.showGroups === undefined ? current.show_groups : patch.showGroups === true,
        avatar_storage_path: patch.avatarStoragePath === undefined ? current.avatar_storage_path : String(patch.avatarStoragePath || "") || null,
        banner_storage_path: patch.bannerStoragePath === undefined ? current.banner_storage_path : String(patch.bannerStoragePath || "") || null,
        updated_at: iso(),
      };
      state.profiles = [updated, ...state.profiles.filter((item) => item.user_id !== updated.user_id)];
    });
    if (updated.profile_visibility === "public") broadcast("profile", updated as unknown as Record<string, unknown>);
    return this.profile(updated.handle);
  },
  async posts(mode: FeedMode | "profile", cursor?: string, handle?: string) {
    const state = await readState();
    const viewer = ownProfile(state);
    const target = handle ? state.profiles.find((item) => item.handle.toLowerCase() === handle.toLowerCase()) : null;
    let posts = state.posts.filter((post) => !state.hiddenPostIds.includes(post.id) && !state.blocked.includes(post.user_id));
    if (mode === "profile") posts = posts.filter((post) => post.user_id === (target?.user_id || viewer.user_id));
    if (mode === "following") posts = posts.filter((post) => state.following.includes(post.user_id) || post.user_id === viewer.user_id);
    if (mode === "saved") posts = posts.filter((post) => state.savedPosts.some((item) => item.postId === post.id));
    if (mode === "research") posts = posts.filter((post) => post.post_type.includes("research") || post.post_type.includes("analysis"));
    if (mode === "market_analysis") posts = posts.filter((post) => post.post_type.includes("analysis") || post.post_type === "trade_idea");
    if (mode === "indicators") posts = posts.filter((post) => post.post_type.includes("indicator"));
    if (mode === "strategies") posts = posts.filter((post) => post.post_type.includes("strategy"));
    if (mode === "investment_groups") posts = posts.filter((post) => post.post_type.includes("group"));
    posts.sort((left, right) => right.created_at.localeCompare(left.created_at));
    const page = cursorSlice(posts, cursor);
    return { posts: await Promise.all(page.items.map((post) => materializePost(postForViewer(state, post)))), nextCursor: page.nextCursor };
  },
  async post(postId: string) {
    const state = await readState();
    const post = state.posts.find((item) => item.id === postId);
    if (!post) throw new Error("The professional post was not found on this peer.");
    return { post: await materializePost(postForViewer(state, post)) };
  },
  async createPost(draft: Record<string, unknown>) {
    let post!: SocialPost;
    await mutate((state) => {
      const profile = ownProfile(state);
      const mediaDrafts = Array.isArray(draft.media) ? draft.media.map(object).slice(0, 8) : [];
      post = {
        id: String(draft.idempotencyKey || identifier("post")),
        user_id: profile.user_id,
        post_type: String(draft.postType || "status"),
        title: String(draft.title || "").trim() || null,
        body: String(draft.body || "").trim().slice(0, 20_000),
        summary: String(draft.summary || "").trim() || null,
        asset_class: String(draft.assetClass || "").trim() || null,
        directional_bias: String(draft.directionalBias || "").trim() || null,
        timeframe: String(draft.timeframe || "").trim() || null,
        visibility: ["public", "followers", "group", "private"].includes(String(draft.visibility)) ? draft.visibility as SocialPost["visibility"] : "private",
        risk_disclaimer: String(draft.riskDisclaimer || ""),
        status: "published",
        metadata: object(draft.metadata),
        edited_at: null,
        created_at: iso(),
        author: authorFromProfile(profile),
        symbols: Array.isArray(draft.symbols) ? draft.symbols.map(String).slice(0, 20) : [],
        media: mediaDrafts.map((media) => ({ id: identifier("media"), storage_path: String(media.storagePath || ""), signed_url: null, media_type: media.mediaType === "chart_snapshot" ? "chart_snapshot" : "image", alt_text: String(media.altText || "") })),
        attachments: Array.isArray(draft.attachments) ? draft.attachments.map((attachment) => { const item = object(attachment); return { id: identifier("attachment"), attachment_type: String(item.type || "file"), title: String(item.title || "Attachment"), public_metadata: object(item.metadata) }; }).slice(0, 8) : [],
        reactions: {},
        viewerReaction: null,
        comments: [],
        commentCount: 0,
        repostCount: 0,
        viewerReposted: false,
        saved: false,
      };
      if (!post.body) throw new Error("Post body is required.");
      if (!state.posts.some((item) => item.id === post.id)) state.posts.unshift(post);
    });
    if (post.visibility === "public") broadcast("post", { ...post, media: [] } as unknown as Record<string, unknown>);
    return { post: await materializePost(post) };
  },
  async updatePost(postId: string, patch: Record<string, unknown>) {
    let post!: SocialPost;
    await mutate((state) => {
      post = requireOwnedPost(state, postId);
      if (patch.title !== undefined) post.title = String(patch.title || "") || null;
      if (patch.body !== undefined) post.body = String(patch.body || "").slice(0, 20_000);
      if (patch.metadata !== undefined) post.metadata = object(patch.metadata);
      post.edited_at = iso();
    });
    if (post.visibility === "public") broadcast("post", { ...post, media: [] } as unknown as Record<string, unknown>);
    return { post: await materializePost(post) };
  },
  async deletePost(postId: string) {
    await mutate((state) => { requireOwnedPost(state, postId); state.posts = state.posts.filter((item) => item.id !== postId); });
    return { deleted: true };
  },
  async react(postId: string, reactionType: ReactionType | null) {
    await mutate((state) => {
      const post = state.posts.find((item) => item.id === postId);
      if (!post) throw new Error("The professional post was not found.");
      const previous = post.viewerReaction;
      if (previous) post.reactions[previous] = Math.max(0, Number(post.reactions[previous] || 0) - 1);
      post.viewerReaction = reactionType;
      if (reactionType) post.reactions[reactionType] = Number(post.reactions[reactionType] || 0) + 1;
    });
    return { ok: true };
  },
  async comment(postId: string, body: string, parentCommentId?: string, clientCommentId = identifier("comment")) {
    let comment!: SocialComment;
    await mutate((state) => {
      const post = state.posts.find((item) => item.id === postId);
      if (!post) throw new Error("The professional post was not found.");
      const profile = ownProfile(state);
      comment = { id: clientCommentId, post_id: postId, parent_comment_id: parentCommentId || null, author_user_id: profile.user_id, body: body.trim().slice(0, 8_000), created_at: iso(), edited_at: null, reactions: {}, viewerReaction: null, author: authorFromProfile(profile) };
      if (!comment.body) throw new Error("Comment body is required.");
      if (!post.comments.some((item) => item.id === comment.id)) post.comments.push(comment);
      post.commentCount = post.comments.length;
    });
    return { comment };
  },
  async comments(postId: string, cursor?: string) {
    const state = await readState();
    const comments = state.posts.find((item) => item.id === postId)?.comments || [];
    const page = cursorSlice(comments, cursor);
    return { comments: page.items, nextCursor: page.nextCursor };
  },
  async editComment(commentId: string, body: string) {
    let comment!: SocialComment;
    await mutate((state) => {
      const owner = ownProfile(state);
      for (const post of state.posts) {
        const target = post.comments.find((item) => item.id === commentId);
        if (!target) continue;
        if (target.author_user_id !== owner.user_id) throw new Error("Only the author can edit this comment.");
        target.body = body.trim().slice(0, 8_000); target.edited_at = iso(); comment = target; return;
      }
      throw new Error("The comment was not found.");
    });
    return { comment };
  },
  async deleteComment(commentId: string) {
    await mutate((state) => {
      const owner = ownProfile(state);
      for (const post of state.posts) {
        const target = post.comments.find((item) => item.id === commentId);
        if (target && target.author_user_id !== owner.user_id && post.user_id !== owner.user_id) throw new Error("You cannot remove this comment.");
        post.comments = post.comments.filter((item) => item.id !== commentId);
        post.commentCount = post.comments.length;
      }
    });
    return { deleted: true };
  },
  async reactToComment(commentId: string, reactionType: CommentReactionType | null) {
    await mutate((state) => {
      const comment = state.posts.flatMap((post) => post.comments).find((item) => item.id === commentId);
      if (!comment) throw new Error("The comment was not found.");
      const previous = comment.viewerReaction;
      if (previous) comment.reactions![previous] = Math.max(0, Number(comment.reactions?.[previous] || 0) - 1);
      comment.viewerReaction = reactionType;
      if (reactionType) comment.reactions![reactionType] = Number(comment.reactions?.[reactionType] || 0) + 1;
    });
    return { ok: true };
  },
  async collections() {
    const state = await readState();
    return { collections: state.collections.map((collection) => ({ ...collection, social_saved_posts: [{ count: state.savedPosts.filter((saved) => saved.collectionId === collection.id).length }] })) };
  },
  async collectionAction(action: "create" | "rename" | "delete", payload: Record<string, unknown>) {
    let collection: SavedCollection | undefined;
    await mutate((state) => {
      if (action === "create") { collection = { id: identifier("collection"), name: String(payload.name || "Collection").slice(0, 80), is_default: false, social_saved_posts: [{ count: 0 }] }; state.collections.push(collection); }
      if (action === "rename") { collection = state.collections.find((item) => item.id === payload.collectionId); if (collection && !collection.is_default) collection.name = String(payload.name || collection.name).slice(0, 80); }
      if (action === "delete") { const id = String(payload.collectionId || ""); state.collections = state.collections.filter((item) => item.id !== id || item.is_default); state.savedPosts = state.savedPosts.filter((item) => item.collectionId !== id); }
    });
    return { ok: true, collection };
  },
  async save(postId: string, saved: boolean, collectionId?: string) {
    await mutate((state) => {
      state.savedPosts = state.savedPosts.filter((item) => item.postId !== postId);
      if (saved) state.savedPosts.push({ postId, collectionId: collectionId || state.collections.find((item) => item.is_default)?.id || "local-default" });
    });
    return { ok: true };
  },
  async repost(postId: string, commentary = "", reposted = true) {
    await mutate((state) => { const post = state.posts.find((item) => item.id === postId); if (!post) throw new Error("The post was not found."); post.viewerReposted = reposted; post.repostCount = Math.max(0, post.repostCount + (reposted ? 1 : -1)); if (commentary.trim()) post.feed_context = { type: "repost", user_id: ownProfile(state).user_id, commentary: commentary.trim().slice(0, 1_000), created_at: iso() }; });
    return { ok: true };
  },
  async hide(postId: string) { await mutate((state) => { if (!state.hiddenPostIds.includes(postId)) state.hiddenPostIds.push(postId); }); return { ok: true }; },
  async report(targetType: string, targetId: string, reason: string, details = "") {
    await mutate((state) => state.moderationReports.push({ id: identifier("report"), reporter_user_id: ownProfile(state).user_id, target_type: targetType, target_id: targetId, reason, details, status: "pending", created_at: iso() }));
    return { ok: true };
  },
  async relationship(operation: string, targetUserId: string, extra: Record<string, unknown> = {}) {
    let relationship = operation;
    await mutate((state) => {
      if (targetUserId === ownProfile(state).user_id) throw new Error("You cannot apply this relationship to your own profile.");
      if (operation === "follow") { if (!state.following.includes(targetUserId)) state.following.push(targetUserId); relationship = "following"; }
      if (operation === "unfollow") state.following = state.following.filter((id) => id !== targetUserId);
      if (operation === "mute") { if (!state.muted.includes(targetUserId)) state.muted.push(targetUserId); }
      if (operation === "unmute") state.muted = state.muted.filter((id) => id !== targetUserId);
      if (operation === "block") { if (!state.blocked.includes(targetUserId)) state.blocked.push(targetUserId); state.following = state.following.filter((id) => id !== targetUserId); }
      if (operation === "unblock") state.blocked = state.blocked.filter((id) => id !== targetUserId);
      if (operation === "review_follow_request" && extra.accept === true && !state.following.includes(targetUserId)) state.following.push(targetUserId);
    });
    return { relationship };
  },
  async conversations() { const state = await readState(); return { conversations: state.conversations.filter((item) => !item.membership.archived_at) }; },
  async messages(conversationId: string, cursor?: string) { const state = await readState(); const values = state.messages.filter((item) => item.conversation_id === conversationId).sort((left, right) => left.created_at.localeCompare(right.created_at)); const page = cursorSlice(values, cursor); return { messages: page.items, nextCursor: page.nextCursor }; },
  async messageAction<T = Record<string, unknown>>(operation: string, payload: Record<string, unknown>) {
    let result: Record<string, unknown> = { ok: true };
    await mutate(async (state) => {
      const owner = ownProfile(state);
      if (operation === "start") {
        const targetId = String(payload.targetUserId || "");
        const existingConversation = state.conversations.find((item) => item.participantIds.includes(targetId));
        let conversationId = existingConversation?.id;
        if (!conversationId) {
          const target = state.profiles.find((item) => item.user_id === targetId);
          if (!target) throw new Error("The message recipient was not found.");
          const remotePeerId = targetId.startsWith("peer:") ? targetId.slice("peer:".length) : null;
          const created: LocalConversation = {
            id: remotePeerId ? directConversationId(runtimeIdentity().peerId, remotePeerId) : identifier("conversation"),
            conversation_type: "direct",
            title: null,
            last_message_at: null,
            participants: [{ user_id: target.user_id, handle: target.handle, display_name: target.display_name, professional_role: target.professional_role }],
            request: null,
            lastMessage: null,
            read: null,
            membership: { archived_at: null, muted_until: null },
            participantIds: [owner.user_id, targetId],
          };
          state.conversations.push(created);
          conversationId = created.id;
        }
        result = { conversationId };
      } else if (operation === "send") {
        const conversationId = String(payload.conversationId || "");
        const conversation = state.conversations.find((item) => item.id === conversationId);
        if (!conversation) throw new Error("The local conversation was not found.");
        const message: DirectMessage = { id: String(payload.clientMessageId || identifier("message")), conversation_id: conversationId, sender_user_id: owner.user_id, body: String(payload.body || "").slice(0, 8_000), message_type: String(payload.messageType || "text"), shared_object_type: payload.sharedObjectType ? String(payload.sharedObjectType) : null, shared_object_id: payload.sharedObjectId ? String(payload.sharedObjectId) : null, created_at: iso(), attachments: [] };
        const remoteUserId = conversation.participantIds.find((id) => id.startsWith("peer:") && id !== owner.user_id);
        if (remoteUserId) {
          if (message.message_type === "image") throw new Error("Encrypted P2P image transfer is not enabled yet; send text or a shared local object reference.");
          const senderProfile = {
            user_id: owner.user_id,
            handle: owner.handle,
            display_name: owner.display_name,
            headline: owner.headline,
            professional_role: owner.professional_role,
            profile_visibility: "public",
          };
          await sendLocalP2pDirect(remoteUserId.slice("peer:".length), message.id, {
            schemaVersion: 1,
            kind: "direct-message",
            senderProfile,
            message: {
              id: message.id,
              body: message.body,
              message_type: message.message_type,
              shared_object_type: message.shared_object_type,
              shared_object_id: message.shared_object_id,
              created_at: message.created_at,
            },
          });
        }
        if (!state.messages.some((item) => item.id === message.id)) state.messages.push(message);
        conversation.last_message_at = message.created_at;
        conversation.lastMessage = { id: message.id, body: message.body, message_type: message.message_type, sender_user_id: message.sender_user_id, created_at: message.created_at };
        result = { message };
      } else {
        const conversation = state.conversations.find((item) => item.id === payload.conversationId);
        if (operation === "archive" && conversation) conversation.membership.archived_at = iso();
        if (operation === "mute" && conversation) conversation.membership.muted_until = "9999-12-31T23:59:59.999Z";
        if (operation === "read" && conversation) conversation.read = { last_read_message_id: String(payload.messageId || "") || null, read_at: iso() };
      }
    });
    return result as T;
  },
  async notifications(cursor?: string) { const state = await readState(); const values = [...state.notifications].sort((left, right) => right.created_at.localeCompare(left.created_at)); const page = cursorSlice(values, cursor); return { notifications: page.items, unreadCount: values.filter((item) => !item.read_at).length, preferences: state.notificationPreferences, nextCursor: page.nextCursor }; },
  async notificationAction(operation: string, payload: Record<string, unknown> = {}) {
    await mutate((state) => {
      if (operation === "read") { const id = String(payload.notificationId || ""); state.notifications.forEach((item) => { if (!id || item.id === id) item.read_at = iso(); }); }
      if (operation === "preferences") state.notificationPreferences = { ...defaultPreferences, ...object(payload.preferences) } as NotificationPreferences;
    });
    return { ok: true };
  },
  async search(query: string): Promise<SearchResults> {
    const state = await readState();
    const needle = query.trim().toLowerCase();
    const matches = (values: unknown[]) => values.some((value) => String(value || "").toLowerCase().includes(needle));
    return {
      query,
      profiles: state.profiles.filter((profile) => matches([profile.handle, profile.display_name, profile.headline, profile.bio])),
      posts: await Promise.all(state.posts.filter((post) => matches([post.title, post.body, ...post.symbols])).map(materializePost)),
      groups: listAllLocalInvestmentGroups().filter((group) => matches([group.firmName, group.description, group.slug])).map((group) => ({ id: group.id, slug: group.slug, firm_name: group.firmName, description: group.description })),
      indicators: state.assets.filter((asset) => asset.type === "indicator" && matches([asset.name, asset.description])).map((asset) => asset as unknown as SearchResults["indicators"][number]),
      strategies: state.assets.filter((asset) => asset.type === "strategy" && matches([asset.name, asset.description])).map((asset) => asset as unknown as SearchResults["strategies"][number]),
    };
  },
  async assets(handle?: string) { const state = await readState(); const profile = handle ? state.profiles.find((item) => item.handle.toLowerCase() === handle.toLowerCase()) : ownProfile(state); const values = state.assets.filter((asset) => asset.user_id === profile?.user_id); return { indicators: values.filter((asset) => asset.type === "indicator"), strategies: values.filter((asset) => asset.type === "strategy") }; },
  async publishAsset(type: "indicator" | "strategy", payload: Record<string, unknown>) {
    let asset!: LocalAsset;
    await mutate((state) => { asset = { ...payload, id: identifier(type), user_id: ownProfile(state).user_id, type, visibility: String(payload.visibility || "private"), created_at: iso() }; state.assets.unshift(asset); });
    if (asset.visibility === "public") broadcast("asset", asset);
    return { asset };
  },
  async moderationReports(status = "pending") { const state = await readState(); return { reports: state.moderationReports.filter((report) => report.status === status) }; },
  async moderationAction(reportId: string, action: string, reason: string, options: { scope?: string; durationDays?: number } = {}) { await mutate((state) => { const report = state.moderationReports.find((item) => item.id === reportId); if (report) Object.assign(report, { status: "resolved", action, moderationReason: reason, ...options, resolved_at: iso() }); }); return { ok: true }; },
  async uploadMedia(file: File, scope: string, _context: Record<string, unknown> = {}, options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {}) {
    if (file.size > 1_250_000) throw new Error("Encrypted local social media is currently limited to 1.25 MB per prepared image.");
    if (options.signal?.aborted) throw new DOMException("Upload cancelled.", "AbortError");
    options.onProgress?.(10);
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const abort = () => reader.abort();
      reader.onerror = () => reject(new Error("The local media file could not be read."));
      reader.onabort = () => reject(new DOMException("Upload cancelled.", "AbortError"));
      reader.onload = () => { options.signal?.removeEventListener("abort", abort); resolve(String(reader.result || "").split(",")[1] || ""); };
      options.signal?.addEventListener("abort", abort, { once: true });
      reader.readAsDataURL(file);
    });
    const id = identifier("media");
    options.onProgress?.(70);
    await putLocalDocument(mediaNamespace, id, { mimeType: file.type, base64, byteSize: file.size, scope, createdAt: iso() } satisfies LocalMediaDocument, 0);
    options.onProgress?.(100);
    return { path: `local-media:${id}`, token: "LOCAL_ENCRYPTED_DOCUMENT", mimeType: file.type, byteSize: file.size };
  },
  async deleteDraftMedia(path: string) { if (path.startsWith("local-media:")) await deleteLocalDocument(mediaNamespace, path.slice("local-media:".length)); return { deleted: true }; },
};
