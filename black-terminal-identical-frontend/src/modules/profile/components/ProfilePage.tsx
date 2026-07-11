import { useMemo, useState } from "react";
import {
  BadgeCheck,
  BarChart3,
  Bell,
  BookOpen,
  ImagePlus,
  Library,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  Users,
  X
} from "lucide-react";
import { getCapabilities, resolveProductTier, type CapabilityUser } from "../../../core/permissions/capabilities";
import {
  followProfessionalUser,
  getProfessionalNetworkSnapshot,
  publishIndicator,
  publishProfilePost,
  publishStrategy,
  unfollowProfessionalUser,
  upsertProfile
} from "../professionalNetworkStore";
import type { ProfilePostType, ProfilePostVisibility } from "../types";

type ProfilePageProps = {
  currentUser: CapabilityUser;
  onClose: () => void;
  onOpenInvestmentGroups: () => void;
};

type ProfileTab =
  | "Overview"
  | "Posts"
  | "Research"
  | "Indicators"
  | "Strategies"
  | "Statistics"
  | "Followers"
  | "Following"
  | "Investment Groups";

const tabs: ProfileTab[] = [
  "Overview",
  "Posts",
  "Research",
  "Indicators",
  "Strategies",
  "Statistics",
  "Followers",
  "Following",
  "Investment Groups"
];

const postTypes: { label: string; value: ProfilePostType }[] = [
  { label: "Market Research", value: "market_research" },
  { label: "Trade Idea", value: "trade_idea" },
  { label: "Status", value: "status" },
  { label: "Indicator Release", value: "indicator_release" },
  { label: "Strategy Note", value: "strategy_note" },
  { label: "Group Announcement", value: "group_announcement" }
];

const visibilityOptions: { label: string; value: ProfilePostVisibility }[] = [
  { label: "Public", value: "public" },
  { label: "Followers", value: "followers" },
  { label: "Private", value: "private" }
];

export function ProfilePage({ currentUser, onClose, onOpenInvestmentGroups }: ProfilePageProps) {
  const [revision, setRevision] = useState(0);
  const [activeTab, setActiveTab] = useState<ProfileTab>("Overview");
  const snapshot = useMemo(() => getProfessionalNetworkSnapshot(currentUser), [currentUser, revision]);
  const { profile } = snapshot;
  const tier = resolveProductTier(currentUser);
  const emailVerified = currentUser.emailVerified === true;
  const capabilities = useMemo(() => getCapabilities(currentUser), [currentUser]);
  const [status, setStatus] = useState("");
  const [profileDraft, setProfileDraft] = useState({
    displayName: profile.displayName,
    bio: profile.bio,
    country: profile.country ?? "",
    tradingStyleTags: profile.tradingStyleTags.join(", "),
    showPublicStats: profile.showPublicStats,
    showPublicPnl: profile.showPublicPnl,
    showPublicDrawdown: profile.showPublicDrawdown,
    showPublicEquityCurve: profile.showPublicEquityCurve,
    showVerifiedExchangePerformance: profile.showVerifiedExchangePerformance
  });
  const [postDraft, setPostDraft] = useState({
    postType: "market_research" as ProfilePostType,
    body: "",
    symbol: "",
    timeframe: "",
    marketCategory: "",
    visibility: "public" as ProfilePostVisibility
  });
  const [followUsername, setFollowUsername] = useState("");
  const [indicatorDraft, setIndicatorDraft] = useState({ name: "", version: "1.0.0", description: "", visibility: "public" as ProfilePostVisibility });
  const [strategyDraft, setStrategyDraft] = useState({ name: "", market: "Crypto", timeframe: "1H", riskProfile: "balanced" as const, description: "", visibility: "public" as ProfilePostVisibility });

  const refresh = () => setRevision((value) => value + 1);

  const saveProfile = () => {
    upsertProfile(currentUser, {
      displayName: profileDraft.displayName.trim() || currentUser.username,
      bio: profileDraft.bio.trim(),
      country: profileDraft.country.trim() || undefined,
      tradingStyleTags: profileDraft.tradingStyleTags.split(",").map((item) => item.trim()).filter(Boolean),
      showPublicStats: profileDraft.showPublicStats,
      showPublicPnl: profileDraft.showPublicPnl,
      showPublicDrawdown: profileDraft.showPublicDrawdown,
      showPublicEquityCurve: profileDraft.showPublicEquityCurve,
      showVerifiedExchangePerformance: profileDraft.showVerifiedExchangePerformance
    });
    setStatus("Profile updated.");
    refresh();
  };

  const uploadImage = (field: "avatarUrl" | "bannerUrl", file?: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      upsertProfile(currentUser, { [field]: String(reader.result || "") });
      setStatus(field === "avatarUrl" ? "Profile picture updated." : "Cover banner updated.");
      refresh();
    };
    reader.readAsDataURL(file);
  };

  const submitPost = () => {
    try {
      publishProfilePost(currentUser, {
        postType: postDraft.postType,
        body: postDraft.body.trim(),
        symbol: postDraft.symbol.trim().toUpperCase() || undefined,
        timeframe: postDraft.timeframe.trim().toUpperCase() || undefined,
        marketCategory: postDraft.marketCategory.trim() || undefined,
        visibility: postDraft.visibility,
        metadata: {}
      });
      setPostDraft((current) => ({ ...current, body: "", symbol: "", timeframe: "", marketCategory: "" }));
      setStatus("Research published.");
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const submitFollow = () => {
    try {
      followProfessionalUser(currentUser, followUsername);
      setFollowUsername("");
      setStatus("Follow graph updated.");
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const submitIndicator = () => {
    try {
      publishIndicator(currentUser, {
        name: indicatorDraft.name.trim(),
        description: indicatorDraft.description.trim(),
        version: indicatorDraft.version.trim() || "1.0.0",
        visibility: indicatorDraft.visibility,
        metadata: { downloadsFuture: true, ratingFuture: true }
      });
      setIndicatorDraft({ name: "", version: "1.0.0", description: "", visibility: "public" });
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const submitStrategy = () => {
    try {
      publishStrategy(currentUser, {
        name: strategyDraft.name.trim(),
        description: strategyDraft.description.trim(),
        market: strategyDraft.market.trim() || "Crypto",
        timeframe: strategyDraft.timeframe.trim() || "1H",
        riskProfile: strategyDraft.riskProfile,
        visibility: strategyDraft.visibility,
        metadata: { backtestStatusFuture: true }
      });
      setStrategyDraft({ name: "", market: "Crypto", timeframe: "1H", riskProfile: "balanced", description: "", visibility: "public" });
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="network-page">
      <header className="network-head">
        <div>
          <span>PROFESSIONAL PROFILE</span>
          <strong>Trading identity, research feed, published tools, and investment network presence</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Profile"><X size={14} /></button>
      </header>

      <section className="profile-hero">
        <div className="profile-banner" style={{ backgroundImage: profile.bannerUrl ? `url(${profile.bannerUrl})` : undefined }}>
          <label className="network-upload">
            <ImagePlus size={14} />
            <span>Cover</span>
            <input type="file" accept="image/*" onChange={(event) => uploadImage("bannerUrl", event.target.files?.[0])} />
          </label>
        </div>
        <div className="profile-identity">
          <div className="profile-avatar" style={{ backgroundImage: profile.avatarUrl ? `url(${profile.avatarUrl})` : undefined }}>
            {!profile.avatarUrl && profile.displayName.slice(0, 2).toUpperCase()}
            <label className="profile-avatar-upload">
              <ImagePlus size={13} />
              <input type="file" accept="image/*" onChange={(event) => uploadImage("avatarUrl", event.target.files?.[0])} />
            </label>
          </div>
          <div className="profile-title">
            <div>
              <strong>{profile.displayName}</strong>
              {profile.verified && <BadgeCheck size={15} />}
              <em>{tier.toUpperCase()}</em>
            </div>
            <span>@{profile.username}</span>
            <p>{profile.bio || "No bio published yet. Add a concise institutional trading profile."}</p>
          </div>
          <div className="profile-counts">
            <span><b>{snapshot.followerCount}</b> Followers</span>
            <span><b>{snapshot.followingCount}</b> Following</span>
            <span><b>{new Date(profile.joinedAt).toLocaleDateString()}</b> Joined</span>
          </div>
        </div>
      </section>

      <nav className="network-tabs">
        {tabs.map((tab) => (
          <button type="button" key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </nav>

      {status && <div className="network-status">{status}</div>}

      {!emailVerified && (
        <section className="network-panel" style={{ margin: "10px 14px 0" }}>
          <div className="network-panel-title"><ShieldCheck size={14} /> Confirm Your Email</div>
          <p className="network-muted">
            Your Black Terminal account can open the workspace, but secure broker credentials and live execution require a confirmed Supabase Auth session.
          </p>
          <p className="network-muted">
            Email: <strong>{currentUser.email || "not recorded"}</strong>. Confirm it from Supabase/Auth email flow, then sign out and sign back in to refresh this status.
          </p>
        </section>
      )}

      <main className="network-body">
        {activeTab === "Overview" && (
          <div className="network-grid two">
            <section className="network-panel">
              <div className="network-panel-title"><Settings2 size={14} /> Profile Settings</div>
              <div className="network-form-grid">
                <label>Display Name<input value={profileDraft.displayName} onChange={(event) => setProfileDraft({ ...profileDraft, displayName: event.target.value })} /></label>
                <label>Country<input value={profileDraft.country} onChange={(event) => setProfileDraft({ ...profileDraft, country: event.target.value })} /></label>
                <label className="wide">Bio<textarea value={profileDraft.bio} onChange={(event) => setProfileDraft({ ...profileDraft, bio: event.target.value })} /></label>
                <label className="wide">Trading Style Tags<input value={profileDraft.tradingStyleTags} onChange={(event) => setProfileDraft({ ...profileDraft, tradingStyleTags: event.target.value })} placeholder="orderflow, crypto futures, HDLX" /></label>
              </div>
              <button className="network-primary" type="button" onClick={saveProfile}>Save Profile</button>
            </section>

            <section className="network-panel">
              <div className="network-panel-title"><Send size={14} /> Research Feed Composer</div>
              <Composer postDraft={postDraft} onChange={setPostDraft} onSubmit={submitPost} disabled={!capabilities.has("can_publish_research") && !capabilities.has("admin.override")} />
            </section>

            <section className="network-panel">
              <div className="network-panel-title"><Users size={14} /> Professional Discovery</div>
              <div className="network-inline-form">
                <input value={followUsername} onChange={(event) => setFollowUsername(event.target.value)} placeholder="Username to follow" />
                <button type="button" onClick={submitFollow}>Follow</button>
              </div>
              <p className="network-muted">Follow graph is professional-only: it powers research discovery and future allocation reputation. No generic social reactions are enabled.</p>
            </section>

            <section className="network-panel">
              <div className="network-panel-title"><Bell size={14} /> Network Notifications</div>
              <ListEmpty items={snapshot.notifications.slice(0, 5)} empty="NO PROFESSIONAL NETWORK EVENTS YET.">
                {(item) => (
                  <div className="network-list-row" key={item.id}>
                    <strong>{item.title}</strong>
                    <span>{item.body}</span>
                    <em>{new Date(item.createdAt).toLocaleString()}</em>
                  </div>
                )}
              </ListEmpty>
            </section>
          </div>
        )}

        {(activeTab === "Posts" || activeTab === "Research") && (
          <div className="network-grid feed">
            <section className="network-panel">
              <div className="network-panel-title"><Radio size={14} /> Research Feed</div>
              <ListEmpty items={activeTab === "Posts" ? snapshot.ownPosts : snapshot.researchFeed} empty="NO RESEARCH POSTS PUBLISHED YET.">
                {(post) => <PostCard key={post.id} post={post} />}
              </ListEmpty>
            </section>
            <section className="network-panel">
              <div className="network-panel-title"><Send size={14} /> Publish Market Research</div>
              <Composer postDraft={postDraft} onChange={setPostDraft} onSubmit={submitPost} disabled={!capabilities.has("can_publish_research") && !capabilities.has("admin.override")} />
            </section>
          </div>
        )}

        {activeTab === "Indicators" && (
          <AssetPanel
            icon={Library}
            title="Published Indicators"
            canPublish={capabilities.has("can_publish_indicators") || capabilities.has("admin.override")}
            items={snapshot.indicators}
            empty="NO PUBLISHED INDICATORS YET."
            form={
              <>
                <input placeholder="Indicator name" value={indicatorDraft.name} onChange={(event) => setIndicatorDraft({ ...indicatorDraft, name: event.target.value })} />
                <input placeholder="Version" value={indicatorDraft.version} onChange={(event) => setIndicatorDraft({ ...indicatorDraft, version: event.target.value })} />
                <textarea placeholder="Description" value={indicatorDraft.description} onChange={(event) => setIndicatorDraft({ ...indicatorDraft, description: event.target.value })} />
                <button type="button" onClick={submitIndicator}>Publish Indicator</button>
              </>
            }
          />
        )}

        {activeTab === "Strategies" && (
          <AssetPanel
            icon={BookOpen}
            title="Published Strategies"
            canPublish={capabilities.has("can_publish_strategies") || capabilities.has("admin.override")}
            items={snapshot.strategies}
            empty="NO PUBLISHED STRATEGIES YET."
            form={
              <>
                <input placeholder="Strategy name" value={strategyDraft.name} onChange={(event) => setStrategyDraft({ ...strategyDraft, name: event.target.value })} />
                <input placeholder="Market" value={strategyDraft.market} onChange={(event) => setStrategyDraft({ ...strategyDraft, market: event.target.value })} />
                <input placeholder="Timeframe" value={strategyDraft.timeframe} onChange={(event) => setStrategyDraft({ ...strategyDraft, timeframe: event.target.value })} />
                <textarea placeholder="Description" value={strategyDraft.description} onChange={(event) => setStrategyDraft({ ...strategyDraft, description: event.target.value })} />
                <button type="button" onClick={submitStrategy}>Publish Strategy</button>
              </>
            }
          />
        )}

        {activeTab === "Statistics" && (
          <section className="network-panel">
            <div className="network-panel-title"><BarChart3 size={14} /> Optional Performance Disclosure</div>
            <div className="profile-disclosure-grid">
              {[
                ["showPublicStats", "Show performance statistics publicly"],
                ["showPublicPnl", "Show PnL publicly"],
                ["showPublicDrawdown", "Show drawdown publicly"],
                ["showPublicEquityCurve", "Show equity curve publicly"],
                ["showVerifiedExchangePerformance", "Show verified exchange performance publicly"]
              ].map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={Boolean(profileDraft[key as keyof typeof profileDraft])}
                    onChange={(event) => setProfileDraft({ ...profileDraft, [key]: event.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <button className="network-primary" type="button" onClick={saveProfile}>Save Disclosure Settings</button>
            <div className="network-stat-grid">
              {["Daily PnL", "Weekly PnL", "Monthly PnL", "Yearly PnL", "Win Rate", "Profit Factor", "Max Drawdown", "Average R/R", "Average Holding Time", "Total Trades"].map((label) => (
                <div className="network-stat" key={label}>
                  <span>{label}</span>
                  <b>{profile.showPublicStats ? "AWAITING VERIFIED DATA" : "HIDDEN"}</b>
                  <em>{profile.showVerifiedExchangePerformance ? "VERIFIED FEED REQUIRED" : "UNVERIFIED / PRIVATE"}</em>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "Followers" && (
          <PeopleList
            title="Followers"
            profiles={snapshot.followers}
            empty="NO FOLLOWERS YET."
          />
        )}

        {activeTab === "Following" && (
          <PeopleList
            title="Following"
            profiles={snapshot.following}
            empty="NO FOLLOWED PROFESSIONALS YET."
            onUnfollow={(userId) => {
              unfollowProfessionalUser(currentUser, userId);
              refresh();
            }}
          />
        )}

        {activeTab === "Investment Groups" && (
          <section className="network-panel">
            <div className="network-panel-title"><ShieldCheck size={14} /> Investment Groups</div>
            <button className="network-primary compact" type="button" onClick={onOpenInvestmentGroups}>Open Investment Groups</button>
            <div className="network-card-list">
              {[...snapshot.ownedGroups, ...snapshot.joinedGroups].map((group) => (
                <div className="network-card" key={group.id}>
                  <strong>{group.firmName}</strong>
                  <span>{group.description || "No public description."}</span>
                  <em>{group.ownerUserId === profile.userId ? "OWNER" : "MEMBER"} / {group.visibility.toUpperCase()}</em>
                </div>
              ))}
              {snapshot.ownedGroups.length + snapshot.joinedGroups.length === 0 && <div className="network-empty">NO OWNED OR JOINED INVESTMENT GROUPS.</div>}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Composer({ postDraft, onChange, onSubmit, disabled }: {
  postDraft: {
    postType: ProfilePostType;
    body: string;
    symbol: string;
    timeframe: string;
    marketCategory: string;
    visibility: ProfilePostVisibility;
  };
  onChange: (draft: typeof postDraft) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="network-composer">
      <textarea
        placeholder="Publish market research..."
        value={postDraft.body}
        onChange={(event) => onChange({ ...postDraft, body: event.target.value })}
      />
      <div className="network-form-grid compact">
        <select value={postDraft.postType} onChange={(event) => onChange({ ...postDraft, postType: event.target.value as ProfilePostType })}>
          {postTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select value={postDraft.visibility} onChange={(event) => onChange({ ...postDraft, visibility: event.target.value as ProfilePostVisibility })}>
          {visibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input placeholder="Symbol" value={postDraft.symbol} onChange={(event) => onChange({ ...postDraft, symbol: event.target.value })} />
        <input placeholder="Timeframe" value={postDraft.timeframe} onChange={(event) => onChange({ ...postDraft, timeframe: event.target.value })} />
        <input className="wide" placeholder="Market category" value={postDraft.marketCategory} onChange={(event) => onChange({ ...postDraft, marketCategory: event.target.value })} />
      </div>
      <button type="button" disabled={disabled || postDraft.body.trim().length < 4} onClick={onSubmit}>Publish Research</button>
    </div>
  );
}

function PostCard({ post }: { post: ReturnType<typeof getProfessionalNetworkSnapshot>["researchFeed"][number] }) {
  return (
    <article className="network-post">
      <header>
        <strong>{post.displayName}</strong>
        <span>@{post.username}</span>
        <em>{post.postType.replace(/_/g, " ").toUpperCase()}</em>
      </header>
      <p>{post.body}</p>
      <footer>
        {post.symbol && <span>{post.symbol}</span>}
        {post.timeframe && <span>{post.timeframe}</span>}
        {post.marketCategory && <span>{post.marketCategory}</span>}
        <b>{post.visibility.toUpperCase()}</b>
        <time>{new Date(post.createdAt).toLocaleString()}</time>
      </footer>
    </article>
  );
}

function AssetPanel<T extends { id: string; name: string; description: string; visibility: string; updatedAt: number }>(
  { title, icon: Icon, canPublish, items, empty, form }: {
    title: string;
    icon: typeof Library;
    canPublish: boolean;
    items: T[];
    empty: string;
    form: JSX.Element;
  }
) {
  return (
    <div className="network-grid feed">
      <section className="network-panel">
        <div className="network-panel-title"><Icon size={14} /> {title}</div>
        <ListEmpty items={items} empty={empty}>
          {(item) => (
            <div className="network-card" key={item.id}>
              <strong>{item.name}</strong>
              <span>{item.description || "No description published."}</span>
              <em>{item.visibility.toUpperCase()} / UPDATED {new Date(item.updatedAt).toLocaleDateString()}</em>
              <button type="button" disabled>Open / Install Future</button>
            </div>
          )}
        </ListEmpty>
      </section>
      <section className="network-panel">
        <div className="network-panel-title"><Send size={14} /> Publish</div>
        {canPublish ? <div className="network-asset-form">{form}</div> : <div className="network-empty">PUBLISHING REQUIRES PROFESSIONAL, ENTERPRISE, OR ADMIN PERMISSIONS.</div>}
      </section>
    </div>
  );
}

function PeopleList({ title, profiles, empty, onUnfollow }: { title: string; profiles: ReturnType<typeof getProfessionalNetworkSnapshot>["followers"]; empty: string; onUnfollow?: (userId: string) => void }) {
  return (
    <section className="network-panel">
      <div className="network-panel-title"><Users size={14} /> {title}</div>
      <ListEmpty items={profiles} empty={empty}>
        {(profile) => (
          <div className="network-list-row" key={profile.userId}>
            <strong>{profile.displayName}</strong>
            <span>@{profile.username}</span>
            <em>{profile.productTier.toUpperCase()}</em>
            {onUnfollow && <button type="button" onClick={() => onUnfollow(profile.userId)}>Unfollow</button>}
          </div>
        )}
      </ListEmpty>
    </section>
  );
}

function ListEmpty<T>({ items, empty, children }: { items: T[]; empty: string; children: (item: T) => JSX.Element }) {
  if (items.length === 0) return <div className="network-empty">{empty}</div>;
  return <div className="network-list">{items.map(children)}</div>;
}
