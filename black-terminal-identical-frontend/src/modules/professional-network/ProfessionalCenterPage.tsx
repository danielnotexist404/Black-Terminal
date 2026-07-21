import { Bell, BookOpen, Building2, Home, Inbox, Library, Search, ShieldCheck, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CapabilityUser } from "../../core/permissions/capabilities";
import { AssetsPanel } from "./components/AssetsPanel";
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import { FeedComposer } from "./components/FeedComposer";
import { MessagingPanel } from "./components/MessagingPanel";
import { ModerationPanel } from "./components/ModerationPanel";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { ProfileEditor } from "./components/ProfileEditor";
import { ProfileHeader } from "./components/ProfileHeader";
import { PostList, ProfileWorkspace } from "./components/ProfileWorkspace";
import { professionalNetworkApi } from "./networkApi";
import { parseProfessionalNetworkHash } from "./routing";
import type { FeedMode, NetworkSection, ProfilePayload, SocialPost } from "./types";

const navigation: Array<{ id: NetworkSection; label: string; icon: typeof Home }> = [
  { id: "feed", label: "Feed", icon: Home }, { id: "profile", label: "Profile", icon: UserRound },
  { id: "research", label: "Research", icon: BookOpen }, { id: "assets", label: "Published Assets", icon: Library },
  { id: "groups", label: "Investment Groups", icon: Building2 }, { id: "messages", label: "Messages", icon: Inbox },
  { id: "notifications", label: "Notifications", icon: Bell }, { id: "discovery", label: "Discovery", icon: Search }
];
const feedFilters: Array<{ id: FeedMode; label: string }> = [
  { id: "for_you", label: "For You" }, { id: "following", label: "Following" }, { id: "research", label: "Research" },
  { id: "market_analysis", label: "Market Analysis" }, { id: "indicators", label: "Indicators" },
  { id: "strategies", label: "Strategies" }, { id: "investment_groups", label: "Investment Groups" }, { id: "saved", label: "Saved" }
];

export function ProfessionalCenterPage({ currentUser, initialHandle, initialSection = "feed", onClose, onOpenInvestmentGroups }: {
  currentUser: CapabilityUser;
  initialHandle?: string | null;
  initialSection?: NetworkSection;
  onClose: () => void;
  onOpenInvestmentGroups: () => void;
}) {
  const initialRoute = useMemo(() => typeof window === "undefined" ? null : parseProfessionalNetworkHash(window.location.hash), []);
  const [section, setSection] = useState<NetworkSection>(initialHandle ? "profile" : initialRoute?.section || initialSection);
  const [profileTab, setProfileTab] = useState(initialRoute?.profileTab || "overview");
  const [feedMode, setFeedMode] = useState<FeedMode>("for_you");
  const [activeHandle, setActiveHandle] = useState<string | undefined>(initialHandle || initialRoute?.handle || undefined);
  const [ownProfile, setOwnProfile] = useState<ProfilePayload | null>(null);
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [postEntities, setPostEntities] = useState<Record<string, SocialPost>>({});
  const [feedIds, setFeedIds] = useState<string[]>([]);
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [assets, setAssets] = useState<{ indicators: Array<Record<string, unknown>>; strategies: Array<Record<string, unknown>> }>({ indicators: [], strategies: [] });
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState("");
  const [relationshipBusy, setRelationshipBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(initialRoute?.conversationId || null);
  const [sharedPost, setSharedPost] = useState<SocialPost | null>(null);
  const [focusedPostId, setFocusedPostId] = useState<string | null>(initialRoute?.postId || null);
  const canModerate = currentUser.role === "admin" || currentUser.permissions?.includes("admin.override");

  const mergePosts = useCallback((posts: SocialPost[]) => setPostEntities((current) => ({ ...current, ...Object.fromEntries(posts.map((post) => [post.id, post])) })), []);
  const loadOwnProfile = useCallback(async () => {
    const result = await professionalNetworkApi.profile();
    setOwnProfile(result);
    if (!activeHandle) setActiveHandle(result.profile.handle);
    return result;
  }, [activeHandle]);

  const loadProfile = useCallback(async (handle?: string) => {
    const target = handle || activeHandle;
    if (!target) return;
    setLoading(true);
    try {
      const [profileResult, postResult, assetResult] = await Promise.all([
        professionalNetworkApi.profile(target),
        professionalNetworkApi.posts("profile", undefined, target),
        professionalNetworkApi.assets(target)
      ]);
      setProfile(profileResult);
      mergePosts(postResult.posts);
      setProfileIds(postResult.posts.map((post) => post.id));
      setAssets(assetResult);
      setStatus("");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); setProfile(null); }
    finally { setLoading(false); }
  }, [activeHandle, mergePosts]);

  const loadFeed = useCallback(async (mode = feedMode, cursor?: string) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    try {
      const result = await professionalNetworkApi.posts(mode, cursor);
      if (!cursor) setFocusedPostId(null);
      mergePosts(result.posts);
      setFeedIds((current) => cursor ? [...new Set([...current, ...result.posts.map((post) => post.id)])] : result.posts.map((post) => post.id));
      setNextCursor(result.nextCursor);
      setStatus("");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [feedMode, mergePosts]);

  const loadAssets = useCallback(async () => {
    try { setAssets(await professionalNetworkApi.assets(profile?.profile.handle || ownProfile?.profile.handle)); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [ownProfile?.profile.handle, profile?.profile.handle]);

  useEffect(() => {
    (async () => {
      try {
        const own = await loadOwnProfile();
        const targetHandle = initialHandle || initialRoute?.handle;
        if (targetHandle) await loadProfile(targetHandle);
        else if (initialRoute?.postId) { setProfile(own); await Promise.all([openPost(initialRoute.postId), professionalNetworkApi.assets(own.profile.handle).then(setAssets)]); setLoading(false); }
        else {
          setProfile(own);
          const work = [professionalNetworkApi.assets(own.profile.handle).then(setAssets)];
          if ((initialRoute?.section || initialSection) === "feed") work.push(loadFeed("for_you").then(() => undefined));
          if ((initialRoute?.section || initialSection) === "research") work.push(loadFeed("research").then(() => undefined));
          await Promise.all(work);
          setLoading(false);
        }
      } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); setLoading(false); }
    })();
  }, []); // The Professional Center initializes once; route changes use explicit navigation.

  useEffect(() => {
    const profileHandle = profile?.profile.handle || activeHandle || ownProfile?.profile.handle || "me";
    const route = section === "profile"
      ? `network/profile/${profileHandle}/${profileTab}`
      : section === "messages" && conversationId
        ? `network/messages/${conversationId}`
        : section === "feed" && focusedPostId
          ? `network/post/${focusedPostId}`
          : `network/${section}`;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${route}`);
  }, [section, profileTab, activeHandle, conversationId, focusedPostId, ownProfile?.profile.handle, profile?.profile.handle]);

  const selectSection = async (next: NetworkSection, writeHistory = true) => {
    if (writeHistory) pushNetworkRoute(`network/${next}`);
    setSection(next);
    setFocusedPostId(null);
    setStatus("");
    if (next === "feed") await loadFeed(feedMode);
    if (next === "research") await loadFeed("research");
    if ((next === "profile" || next === "assets") && ownProfile) { setActiveHandle(ownProfile.profile.handle); await loadProfile(ownProfile.profile.handle); }
  };
  const openProfile = async (handle: string, writeHistory = true) => { if (writeHistory) pushNetworkRoute(`profile/${encodeURIComponent(handle)}/overview`); setActiveHandle(handle); setSection("profile"); setProfileTab("overview"); await loadProfile(handle); };
  const updatePost = (post: SocialPost) => mergePosts([post]);
  const hidePost = (postId: string) => { setFeedIds((ids) => ids.filter((id) => id !== postId)); setProfileIds((ids) => ids.filter((id) => id !== postId)); };
  const shareMessage = (post: SocialPost) => { pushNetworkRoute("network/messages"); setSharedPost(post); setSection("messages"); };
  const openPost = useCallback(async (postId: string, writeHistory = true) => {
    try {
      if (writeHistory) pushNetworkRoute(`network/post/${postId}`);
      const result = await professionalNetworkApi.post(postId);
      mergePosts([result.post]);
      setFeedIds([postId]);
      setFocusedPostId(postId);
      setSection("feed");
      window.setTimeout(() => document.getElementById(`post-${postId}`)?.scrollIntoView({ block: "start" }), 0);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [mergePosts]);
  useEffect(() => {
    const restoreRoute = () => {
      const route = parseProfessionalNetworkHash(window.location.hash);
      if (!route) return;
      setFocusedPostId(route.postId || null);
      setSection(route.section);
      if (route.section === "profile" && route.handle) {
        setActiveHandle(route.handle);
        setProfileTab(route.profileTab || "overview");
        void loadProfile(route.handle);
      } else if (route.postId) {
        void openPost(route.postId, false);
      } else if (route.section === "messages") {
        setConversationId(route.conversationId || null);
      } else if (route.section === "feed") {
        void loadFeed(feedMode);
      } else if (route.section === "research") {
        void loadFeed("research");
      }
    };
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("hashchange", restoreRoute);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("hashchange", restoreRoute);
    };
  }, [feedMode, loadFeed, loadProfile, openPost]);
  const startMessage = async () => {
    if (!profile || profile.viewer.isOwner) return;
    setRelationshipBusy(true);
    try {
      const result = await professionalNetworkApi.messageAction<{ conversationId: string }>("start", { targetUserId: profile.profile.user_id });
      pushNetworkRoute(`network/messages/${result.conversationId}`); setConversationId(result.conversationId); setSection("messages");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setRelationshipBusy(false); }
  };
  const follow = async () => {
    if (!profile || profile.viewer.isOwner) return;
    const previous = profile;
    const operation = profile.viewer.isFollowing ? "unfollow" : "follow";
    setProfile({ ...profile, viewer: { ...profile.viewer, isFollowing: operation === "follow" }, credibility: { ...profile.credibility, followers: Math.max(0, profile.credibility.followers + (operation === "follow" ? 1 : -1)) } });
    setRelationshipBusy(true);
    try {
      const result = await professionalNetworkApi.relationship(operation, profile.profile.user_id) as { relationship?: string };
      if (result.relationship === "requested") setProfile((current) => current ? { ...current, viewer: { ...current.viewer, isFollowing: false, followRequestPending: true }, credibility: previous.credibility } : current);
    } catch (error) { setProfile(previous); setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setRelationshipBusy(false); }
  };
  const relationship = async (operation: "mute" | "unmute" | "block" | "unblock") => {
    if (!profile) return;
    setRelationshipBusy(true);
    try { await professionalNetworkApi.relationship(operation, profile.profile.user_id); await loadProfile(profile.profile.handle); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setRelationshipBusy(false); }
  };
  const deepLink = (link: string) => {
    const messageMatch = link.match(/\/network\/messages\/([^/?]+)/);
    const profileMatch = link.match(/\/profile\/([^/?]+)/);
    if (messageMatch) { pushNetworkRoute(`network/messages/${messageMatch[1]}`); setConversationId(messageMatch[1]); setSection("messages"); }
    else if (profileMatch) openProfile(profileMatch[1]);
    else if (link.includes("/network/post/")) { const postId = link.match(/\/network\/post\/([^/?]+)/)?.[1]; if (postId) void openPost(postId); }
    else if (link.includes("group")) onOpenInvestmentGroups();
  };

  const feedPosts = feedIds.map((id) => postEntities[id]).filter(Boolean);
  const profilePosts = profileIds.map((id) => postEntities[id]).filter(Boolean);
  const activePosts = section === "research" ? feedPosts.filter((post) => post.post_type.includes("research") || post.post_type.includes("analysis") || post.post_type === "trade_idea") : feedPosts;
  const activeProfile = profile || ownProfile;
  const activeUserId = ownProfile?.profile.user_id || "";
  return <div className="pn-shell">
    <header className="pn-shell-header">
      <div><span>Professional Center</span><strong>Private Market Intelligence Network</strong></div>
       <nav aria-label="Professional Center navigation">{[...navigation, ...(canModerate ? [{ id: "moderation" as NetworkSection, label: "Moderation", icon: ShieldCheck }] : [])].map(({ id, label, icon: Icon }) => <button type="button" className={section === id ? "active" : ""} key={id} title={label} onClick={() => selectSection(id)}><Icon size={14} /><span>{label}</span></button>)}</nav>
      <button type="button" className="pn-close" aria-label="Close Professional Center" onClick={onClose}><X size={15} /></button>
    </header>
    {status && <div className="pn-global-status">{status}<button type="button" onClick={() => setStatus("")}><X size={12} /></button></div>}
    <main className="pn-shell-body">
      {loading && <NetworkSkeleton />}
      {!loading && section === "feed" && <div className="pn-feed-layout"><div><FeedComposer groups={(ownProfile?.groups || []).map((group) => ({ id: group.id, firm_name: group.firm_name }))} assets={assets} onPublished={(post) => { mergePosts([post]); setFeedIds((ids) => [post.id, ...ids.filter((id) => id !== post.id)]); }} /><nav className="pn-feed-filters" aria-label="Feed filters">{feedFilters.map((filter) => <button type="button" className={feedMode === filter.id ? "active" : ""} key={filter.id} onClick={() => { setFeedMode(filter.id); loadFeed(filter.id); }}>{filter.label}</button>)}</nav><PostList posts={feedPosts} currentUserId={activeUserId} empty="No posts match this professional feed." onOpenProfile={openProfile} onChanged={updatePost} onHidden={hidePost} onShareMessage={shareMessage} />{nextCursor && <button type="button" className="pn-load-more" disabled={loadingMore} onClick={() => loadFeed(feedMode, nextCursor)}>{loadingMore ? "Loading" : "Load More Research"}</button>}</div><aside className="pn-feed-rail"><section><span>Network Pulse</span><strong>{feedPosts.length} loaded publications</strong><p>Research is ranked by professional relevance and recency. Engagement alone does not establish credibility.</p></section><section><span>Market Focus</span>{[...new Set(feedPosts.flatMap((post) => post.symbols))].slice(0, 12).map((symbol) => <em key={symbol}>{symbol}</em>)}</section><button type="button" onClick={() => void selectSection("discovery")}><Search size={13} /> Discover Professionals</button></aside></div>}
      {!loading && section === "research" && <div className="pn-research-page"><header><div><span>Research Desk</span><h1>Professional Market Intelligence</h1></div><select value={feedMode} onChange={(event) => { const mode = event.target.value as FeedMode; setFeedMode(mode); loadFeed(mode); }}><option value="research">All Research</option><option value="market_analysis">Market Analysis</option><option value="indicators">Indicators</option><option value="strategies">Strategies</option></select></header><PostList posts={activePosts} currentUserId={activeUserId} empty="No research publications match this filter." onOpenProfile={openProfile} onChanged={updatePost} onHidden={hidePost} onShareMessage={shareMessage} /></div>}
      {!loading && section === "profile" && activeProfile && <><ProfileHeader payload={activeProfile} busy={relationshipBusy} onEdit={() => setEditing(true)} onFollow={follow} onMessage={startMessage} onRelationship={relationship} /><ProfileWorkspace payload={activeProfile} posts={profilePosts} assets={assets} currentUserId={activeUserId} initialTab={profileTab} onTabChange={(tab) => { pushNetworkRoute(`profile/${encodeURIComponent(activeProfile.profile.handle)}/${tab}`); setProfileTab(tab); }} onOpenProfile={openProfile} onOpenGroups={onOpenInvestmentGroups} onPostChanged={updatePost} onPostHidden={hidePost} onShareMessage={shareMessage} onReloadAssets={loadAssets} /></>}
      {!loading && section === "assets" && <AssetsPanel assets={assets} isOwner={activeProfile?.viewer.isOwner ?? true} onReload={loadAssets} />}
      {!loading && section === "groups" && <section className="pn-groups-bridge"><Building2 size={28} /><span>Institutional Identities</span><h1>Investment Groups</h1><p>Managed research collectives, controlled membership, trading rooms, and public disclosure policies remain in the dedicated Investment Groups workspace.</p><button type="button" onClick={onOpenInvestmentGroups}>Open Investment Groups</button></section>}
      {!loading && section === "messages" && <MessagingPanel currentUserId={activeUserId} initialConversationId={conversationId} sharedPost={sharedPost} onShared={() => setSharedPost(null)} onConversationChange={(id) => { setConversationId(id); if (id) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#network/messages/${id}`); }} />}
      {!loading && section === "notifications" && <NotificationsPanel currentUserId={activeUserId} onDeepLink={deepLink} />}
      {!loading && section === "discovery" && <DiscoveryPanel onOpenProfile={openProfile} onOpenGroups={onOpenInvestmentGroups} />}
      {!loading && section === "moderation" && canModerate && <ModerationPanel />}
    </main>
    {editing && activeProfile?.viewer.isOwner && <ProfileEditor profile={activeProfile.profile} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); const own = await loadOwnProfile(); setProfile(own); await loadProfile(own.profile.handle); }} />}
  </div>;
}

function NetworkSkeleton() {
  return <div className="pn-page-skeleton" aria-label="Loading Professional Center"><div /><div /><div /><div /><div /></div>;
}

function pushNetworkRoute(route: string) {
  if (typeof window === "undefined") return;
  const target = `${window.location.pathname}${window.location.search}#${route}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== target) window.history.pushState(null, "", target);
}
