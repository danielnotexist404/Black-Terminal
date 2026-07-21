import { BarChart3, BookOpen, BriefcaseBusiness, Library, LineChart, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProfilePayload, SocialPost } from "../types";
import { AssetsPanel } from "./AssetsPanel";
import { PostCard } from "./PostCard";

type ProfileTab = "overview" | "posts" | "research" | "indicators" | "strategies" | "statistics" | "followers" | "following" | "groups";
const tabs: Array<{ id: ProfileTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "posts", label: "Posts" }, { id: "research", label: "Research" },
  { id: "indicators", label: "Indicators" }, { id: "strategies", label: "Strategies" }, { id: "statistics", label: "Statistics" },
  { id: "followers", label: "Followers" }, { id: "following", label: "Following" }, { id: "groups", label: "Investment Groups" }
];

export function ProfileWorkspace({ payload, posts, assets, currentUserId, initialTab, onTabChange, onOpenProfile, onOpenGroups, onPostChanged, onPostHidden, onShareMessage, onReloadAssets }: {
  payload: ProfilePayload;
  posts: SocialPost[];
  assets: { indicators: Array<Record<string, unknown>>; strategies: Array<Record<string, unknown>> };
  currentUserId: string;
  initialTab?: string;
  onTabChange: (tab: string) => void;
  onOpenProfile: (handle: string) => void;
  onOpenGroups: () => void;
  onPostChanged: (post: SocialPost) => void;
  onPostHidden: (postId: string) => void;
  onShareMessage: (post: SocialPost) => void;
  onReloadAssets: () => void;
}) {
  const validInitial = tabs.some((tab) => tab.id === initialTab) ? initialTab as ProfileTab : "overview";
  const [tab, setTab] = useState<ProfileTab>(validInitial);
  useEffect(() => { if (tabs.some((item) => item.id === initialTab)) setTab(initialTab as ProfileTab); }, [initialTab]);
  const choose = (next: ProfileTab) => { setTab(next); onTabChange(next); };
  const profile = payload.profile;
  const research = posts.filter((post) => ["market_research", "macro_research", "quantitative_research", "technical_analysis", "orderflow_analysis", "risk_commentary", "trade_idea"].includes(post.post_type));
  return <>
    <nav className="pn-profile-tabs" aria-label="Professional profile sections">{tabs.map((item) => <button type="button" className={tab === item.id ? "active" : ""} key={item.id} onClick={() => choose(item.id)}>{item.label}</button>)}</nav>
    <div className="pn-profile-content">
      {tab === "overview" && <div className="pn-overview-grid">
        <section className="pn-overview-main"><header><BriefcaseBusiness size={14} /><strong>Professional Mandate</strong></header><p>{profile.bio || "No professional biography has been published."}</p>{profile.location && <span><MapPin size={12} /> {profile.location}{profile.country ? `, ${profile.country}` : ""}</span>}<div className="pn-profile-tags">{(profile.trading_style_tags || []).map((tag) => <span key={tag}>{tag}</span>)}</div></section>
        <section><header><LineChart size={14} /><strong>Market Focus</strong></header><dl><dt>Markets</dt><dd>{(profile.market_specialties || []).join(" · ") || "Not published"}</dd><dt>Asset Classes</dt><dd>{(profile.asset_classes || []).join(" · ") || "Not published"}</dd><dt>Research</dt><dd>{payload.credibility.research} publications</dd></dl></section>
        <section><header><BookOpen size={14} /><strong>Featured Research</strong></header>{research.slice(0, 3).map((post) => <button type="button" className="pn-featured-row" key={post.id} onClick={() => choose("research")}><strong>{post.title || post.body.slice(0, 80)}</strong><span>{post.post_type.replaceAll("_", " ")} · {new Date(post.created_at).toLocaleDateString()}</span></button>)}{research.length === 0 && <ProfileEmpty owner={payload.viewer.isOwner} text="No featured research has been published." action="Publish research from the Feed." />}</section>
        <section><header><Library size={14} /><strong>Published Assets</strong></header><dl><dt>Indicators</dt><dd>{assets.indicators.length}</dd><dt>Strategies</dt><dd>{assets.strategies.length}</dd></dl>{assets.indicators.length + assets.strategies.length === 0 && <ProfileEmpty owner={payload.viewer.isOwner} text="No professional tools are public." action="Publish a permission-approved asset." />}</section>
        {profile.show_groups && <section className="wide"><header><Users size={14} /><strong>Investment Groups</strong></header><div className="pn-group-strip">{payload.groups.map((group) => <button type="button" key={group.id} onClick={onOpenGroups}><strong>{group.firm_name || "Investment Group"}</strong><span>{group.description || "Private market collective"}</span><em>{String(group.visibility || "private").toUpperCase()}</em></button>)}{payload.groups.length === 0 && <ProfileEmpty owner={payload.viewer.isOwner} text="No Investment Groups are visible." action="Open Investment Groups to create or join one." />}</div></section>}
      </div>}
      {(tab === "posts" || tab === "research") && <PostList posts={tab === "research" ? research : posts} currentUserId={currentUserId} empty={tab === "research" ? "No research has been published." : "No professional posts yet."} onOpenProfile={onOpenProfile} onChanged={onPostChanged} onHidden={onPostHidden} onShareMessage={onShareMessage} />}
      {(tab === "indicators" || tab === "strategies") && <AssetsPanel assets={tab === "indicators" ? { indicators: assets.indicators, strategies: [] } : { indicators: [], strategies: assets.strategies }} isOwner={payload.viewer.isOwner} onReload={onReloadAssets} />}
      {tab === "statistics" && <Statistics payload={payload} />}
      {(tab === "followers" || tab === "following") && <People title={tab === "followers" ? "Followers" : "Following"} people={tab === "followers" ? payload.followers : payload.following} onOpenProfile={onOpenProfile} />}
      {tab === "groups" && <section className="pn-profile-groups"><header><Users size={14} /><strong>Investment Groups</strong><button type="button" onClick={onOpenGroups}>Open Group Directory</button></header>{payload.groups.length ? payload.groups.map((group) => <article key={group.id}><div><strong>{group.firm_name || "Investment Group"}</strong><em>{String(group.visibility || "private").toUpperCase()}</em></div><p>{group.description || "No public group mandate."}</p><button type="button" onClick={onOpenGroups}>View Group</button></article>) : <ProfileEmpty owner={payload.viewer.isOwner} text="No Investment Groups are visible." action="Create or join an Investment Group." />}</section>}
    </div>
  </>;
}

export function PostList({ posts, currentUserId, empty, onOpenProfile, onChanged, onHidden, onShareMessage }: { posts: SocialPost[]; currentUserId: string; empty: string; onOpenProfile: (handle: string) => void; onChanged: (post: SocialPost) => void; onHidden: (postId: string) => void; onShareMessage: (post: SocialPost) => void }) {
  if (!posts.length) return <div className="pn-empty tall"><BookOpen size={22} /><strong>{empty}</strong><span>Professional market intelligence will appear here when it is published.</span></div>;
  return <div className="pn-feed-list">{posts.map((post) => <PostCard key={post.id} post={post} currentUserId={currentUserId} onOpenProfile={onOpenProfile} onChanged={onChanged} onHidden={onHidden} onShareMessage={onShareMessage} />)}</div>;
}

function Statistics({ payload }: { payload: ProfilePayload }) {
  const p = payload.profile;
  const rows = [
    ["Performance", p.show_public_stats, p.verified_performance_source ? "VERIFIED" : "SELF-REPORTED"],
    ["PnL", p.show_public_pnl, p.verified_performance_source ? "VERIFIED" : "SELF-REPORTED"],
    ["Drawdown", p.show_public_drawdown, p.verified_performance_source ? "VERIFIED" : "SELF-REPORTED"],
    ["Equity Curve", p.show_public_equity_curve, p.verified_performance_source ? "VERIFIED" : "SELF-REPORTED"],
    ["Positions", p.show_positions, "LIVE VENUE DATA"]
  ] as const;
  return <section className="pn-statistics"><header><BarChart3 size={14} /><strong>Performance And Statistics</strong></header><p>Verified, self-reported, simulated, and backtested records are never combined.</p><div>{rows.map(([label, visible, source]) => <article key={label}><span>{label}</span><strong>{visible ? "AWAITING AUTHORIZED DATA" : "PRIVATE"}</strong><em>{visible ? source : "OWNER CONTROLLED"}</em></article>)}</div></section>;
}

function People({ title, people, onOpenProfile }: { title: string; people: ProfilePayload["followers"]; onOpenProfile: (handle: string) => void }) {
  return <section className="pn-people"><header><Users size={14} /><strong>{title}</strong><em>{people.length}</em></header>{people.length ? people.map((person) => <button type="button" key={person.user_id} onClick={() => onOpenProfile(person.handle)}><span>{(person.display_name || person.handle).slice(0, 2).toUpperCase()}</span><div><strong>{person.display_name || person.handle}</strong><em>@{person.handle} · {person.professional_role || "Market Professional"}</em><p>{person.headline}</p></div></button>) : <ProfileEmpty owner={false} text={`No visible ${title.toLowerCase()}.`} action="" />}</section>;
}

function ProfileEmpty({ owner, text, action }: { owner: boolean; text: string; action: string }) {
  return <div className="pn-profile-empty"><span>{text}</span>{owner && action && <em>{action}</em>}</div>;
}
