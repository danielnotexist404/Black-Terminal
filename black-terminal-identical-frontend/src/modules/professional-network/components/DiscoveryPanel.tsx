import { BookOpen, Building2, Search, Shapes, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { professionalNetworkApi } from "../networkApi";
import type { SearchResults } from "../types";

const empty: SearchResults = { query: "", profiles: [], posts: [], groups: [], indicators: [], strategies: [] };

export function DiscoveryPanel({ onOpenProfile, onOpenGroups }: { onOpenProfile: (handle: string) => void; onOpenGroups: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (query.trim().length < 2) { setResults(empty); return; }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try { setResults(await professionalNetworkApi.search(query)); setStatus(""); }
      catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
      finally { setLoading(false); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query]);
  const noResults = query.trim().length >= 2 && !loading && !results.profiles.length && !results.posts.length && !results.groups.length && !results.indicators.length && !results.strategies.length;
  return <section className="pn-discovery">
    <header><div><span>Professional Discovery</span><h2>Search Market Intelligence</h2></div><p>Results favor professional relevance and recent market research, not raw popularity.</p></header>
    <label className="pn-search"><Search size={16} /><input autoFocus value={query} placeholder="Professionals, symbols, research, indicators, strategies, groups..." onChange={(event) => setQuery(event.target.value)} />{loading && <span>Searching</span>}</label>
    {status && <div className="pn-form-status">{status}</div>}
    {query.trim().length < 2 && <div className="pn-empty"><Search size={22} /><strong>Search The Professional Network</strong><span>Use a name, handle, market symbol, research subject, published tool, or Investment Group.</span></div>}
    {noResults && <div className="pn-empty"><Search size={22} /><strong>No Results</strong><span>Try a broader market term or another professional handle.</span></div>}
    <div className="pn-discovery-results">
      {results.profiles.length > 0 && <ResultSection icon={UserRound} title="Professionals">{results.profiles.map((profile) => <button type="button" className="pn-discovery-row" key={profile.user_id} onClick={() => onOpenProfile(profile.handle)}><span>{(profile.display_name || profile.handle).slice(0, 2).toUpperCase()}</span><div><strong>{profile.display_name || profile.handle}</strong><em>@{profile.handle} · {profile.professional_role || "Market Professional"}</em><p>{profile.headline}</p></div></button>)}</ResultSection>}
      {results.posts.length > 0 && <ResultSection icon={BookOpen} title="Research">{results.posts.map((post) => <div className="pn-discovery-row static" key={post.id}><BookOpen size={16} /><div><strong>{post.title || post.body.slice(0, 100)}</strong><em>{post.post_type.replaceAll("_", " ")} · {new Date(post.created_at).toLocaleDateString()}</em></div></div>)}</ResultSection>}
      {results.groups.length > 0 && <ResultSection icon={Building2} title="Investment Groups">{results.groups.map((group) => <button type="button" className="pn-discovery-row" key={group.id} onClick={onOpenGroups}><Building2 size={16} /><div><strong>{group.firm_name}</strong><em>{group.slug}</em><p>{group.description}</p></div></button>)}</ResultSection>}
      {(results.indicators.length > 0 || results.strategies.length > 0) && <ResultSection icon={Shapes} title="Published Assets">{[...results.indicators.map((item) => ({ ...item, kind: "Indicator" })), ...results.strategies.map((item) => ({ ...item, kind: "Strategy" }))].map((asset) => <div className="pn-discovery-row static" key={`${asset.kind}-${asset.id}`}><Shapes size={16} /><div><strong>{asset.name}</strong><em>{asset.kind}</em><p>{asset.description}</p></div></div>)}</ResultSection>}
    </div>
  </section>;
}

function ResultSection({ icon: Icon, title, children }: { icon: typeof Search; title: string; children: React.ReactNode }) {
  return <section className="pn-result-section"><header><Icon size={14} /><strong>{title}</strong></header><div>{children}</div></section>;
}
