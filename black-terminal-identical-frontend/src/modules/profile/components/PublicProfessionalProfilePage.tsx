import { useMemo, useState } from "react";
import { BadgeCheck, BookOpen, Library, ShieldCheck, UserRound, X } from "lucide-react";
import { getPublicProfessionalProfileSnapshot } from "../professionalNetworkStore";

type PublicProfileTab = "Overview" | "Research" | "Published Tools" | "Investment Groups";

export function PublicProfessionalProfilePage({ username, onClose }: { username: string; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<PublicProfileTab>("Overview");
  const snapshot = useMemo(() => getPublicProfessionalProfileSnapshot(username), [username]);

  if (!snapshot) {
    return (
      <div className="network-page">
        <header className="network-head">
          <div><span>PROFESSIONAL PROFILE</span><strong>Public professional identity</strong></div>
          <button type="button" onClick={onClose} aria-label="Close public profile"><X size={14} /></button>
        </header>
        <main className="network-body"><div className="network-empty">THIS PROFESSIONAL PROFILE IS NOT AVAILABLE.</div></main>
      </div>
    );
  }

  const { profile } = snapshot;
  return (
    <div className="network-page">
      <header className="network-head">
        <div><span>PROFESSIONAL PROFILE</span><strong>Public trading identity and verified disclosures</strong></div>
        <button type="button" onClick={onClose} aria-label="Close public profile"><X size={14} /></button>
      </header>

      <section className="profile-hero public-profile-hero">
        <div className="profile-banner" style={{ backgroundImage: profile.bannerUrl ? `url(${profile.bannerUrl})` : undefined }} />
        <div className="profile-identity">
          <div className="profile-avatar" style={{ backgroundImage: profile.avatarUrl ? `url(${profile.avatarUrl})` : undefined }}>
            {!profile.avatarUrl && profile.displayName.slice(0, 2).toUpperCase()}
          </div>
          <div className="profile-title">
            <div>
              <strong>{profile.displayName}</strong>
              {profile.verified && <BadgeCheck size={15} />}
              <em>{profile.productTier.toUpperCase()}</em>
            </div>
            <span>@{profile.username}</span>
            <p>{profile.bio || "No professional biography has been published."}</p>
          </div>
          <div className="profile-counts">
            <span><b>{snapshot.followerCount}</b> Followers</span>
            <span><b>{snapshot.followingCount}</b> Following</span>
            <span><b>{new Date(profile.joinedAt).toLocaleDateString()}</b> Joined</span>
          </div>
        </div>
      </section>

      <nav className="network-tabs">
        {(["Overview", "Research", "Published Tools", "Investment Groups"] as PublicProfileTab[]).map((tab) => (
          <button type="button" key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{tab}</button>
        ))}
      </nav>

      <main className="network-body">
        {activeTab === "Overview" && (
          <div className="network-grid two">
            <section className="network-panel">
              <div className="network-panel-title"><UserRound size={14} /> Professional Mandate</div>
              <p className="network-muted public-profile-copy">{profile.bio || "No public mandate supplied."}</p>
              <div className="public-profile-tags">
                {profile.tradingStyleTags.length ? profile.tradingStyleTags.map((tag) => <span key={tag}>{tag}</span>) : <em>NO PUBLIC TRADING STYLE TAGS</em>}
              </div>
            </section>
            <section className="network-panel">
              <div className="network-panel-title"><ShieldCheck size={14} /> Disclosure Policy</div>
              <div className="profile-disclosure-grid public-disclosure-grid">
                <span>{profile.showPublicStats ? "Performance statistics public" : "Performance statistics private"}</span>
                <span>{profile.showPublicPnl ? "PnL public" : "PnL private"}</span>
                <span>{profile.showPublicDrawdown ? "Drawdown public" : "Drawdown private"}</span>
                <span>{profile.showVerifiedExchangePerformance ? "Verified venue data public" : "Venue data private"}</span>
              </div>
            </section>
          </div>
        )}

        {activeTab === "Research" && (
          <section className="network-panel">
            <div className="network-panel-title"><BookOpen size={14} /> Public Research</div>
            {snapshot.posts.length ? <div className="network-list">{snapshot.posts.map((post) => (
              <article className="network-post" key={post.id}>
                <header><strong>{post.postType.replaceAll("_", " ")}</strong><em>{new Date(post.createdAt).toLocaleString()}</em></header>
                <p>{post.body}</p>
                <footer>{post.symbol && <span>{post.symbol}</span>}{post.timeframe && <span>{post.timeframe}</span>}</footer>
              </article>
            ))}</div> : <div className="network-empty">NO PUBLIC RESEARCH PUBLISHED.</div>}
          </section>
        )}

        {activeTab === "Published Tools" && (
          <div className="network-grid two">
            <section className="network-panel"><div className="network-panel-title"><Library size={14} /> Indicators</div>{snapshot.indicators.length ? snapshot.indicators.map((item) => <div className="network-card" key={item.id}><strong>{item.name}</strong><span>{item.description}</span><em>VERSION {item.version}</em></div>) : <div className="network-empty">NO PUBLIC INDICATORS.</div>}</section>
            <section className="network-panel"><div className="network-panel-title"><Library size={14} /> Strategies</div>{snapshot.strategies.length ? snapshot.strategies.map((item) => <div className="network-card" key={item.id}><strong>{item.name}</strong><span>{item.description}</span><em>{item.market} / {item.timeframe}</em></div>) : <div className="network-empty">NO PUBLIC STRATEGIES.</div>}</section>
          </div>
        )}

        {activeTab === "Investment Groups" && (
          <section className="network-panel">
            <div className="network-panel-title"><ShieldCheck size={14} /> Managed Investment Groups</div>
            {snapshot.groups.length ? <div className="network-card-list">{snapshot.groups.map((group) => <div className="network-card" key={group.id}><strong>{group.firmName}</strong><span>{group.description || "No public description."}</span><em>{group.visibility.toUpperCase()}</em></div>)}</div> : <div className="network-empty">NO PUBLIC INVESTMENT GROUPS MANAGED.</div>}
          </section>
        )}
      </main>
    </div>
  );
}
