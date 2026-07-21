import { ImagePlus, Save, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { professionalNetworkApi, sanitizeNetworkImage } from "../networkApi";
import type { ProfessionalProfile } from "../types";

export function ProfileEditor({ profile, onClose, onSaved }: { profile: ProfessionalProfile; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState({
    handle: profile.handle,
    displayName: profile.display_name || "",
    headline: profile.headline || "",
    bio: profile.bio || "",
    roleLabel: profile.professional_role || "",
    organization: profile.organization || "",
    website: profile.website_url || "",
    location: profile.location || "",
    country: profile.country || "",
    timezone: profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    marketSpecialties: (profile.market_specialties || []).join(", "),
    assetClasses: (profile.asset_classes || []).join(", "),
    tradingStyleTags: (profile.trading_style_tags || []).join(", "),
    profileVisibility: profile.profile_visibility,
    messagePolicy: profile.message_policy,
    showPublicStats: profile.show_public_stats,
    showPublicPnl: profile.show_public_pnl,
    showPublicDrawdown: profile.show_public_drawdown,
    showPublicEquityCurve: profile.show_public_equity_curve,
    showVerifiedExchangePerformance: profile.show_verified_exchange_performance,
    showPositions: profile.show_positions,
    showGroupMembership: profile.show_groups,
    avatarPath: profile.avatar_storage_path,
    bannerPath: profile.banner_storage_path
  });
  const [avatarPreview, setAvatarPreview] = useState(profile.avatar_signed_url || "");
  const [bannerPreview, setBannerPreview] = useState(profile.banner_signed_url || "");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const objectUrls = useRef<{ avatar?: string; cover?: string }>({});
  const tags = useMemo(() => draft.marketSpecialties.split(",").map((item) => item.trim()).filter(Boolean), [draft.marketSpecialties]);
  useEffect(() => () => Object.values(objectUrls.current).forEach((url) => url && URL.revokeObjectURL(url)), []);

  const upload = async (file: File | undefined, kind: "avatar" | "cover") => {
    if (!file) return;
    try {
      setStatus("Preparing private media...");
      const prepared = await sanitizeNetworkImage(file, kind === "avatar" ? 1200 : 4096);
      const uploaded = await professionalNetworkApi.uploadMedia(prepared, kind === "avatar" ? "profile-avatar" : "profile-cover");
      setDraft((current) => ({ ...current, [kind === "avatar" ? "avatarPath" : "bannerPath"]: uploaded.path }));
      const preview = URL.createObjectURL(prepared);
      if (objectUrls.current[kind]) URL.revokeObjectURL(objectUrls.current[kind]!);
      objectUrls.current[kind] = preview;
      if (kind === "avatar") setAvatarPreview(preview); else setBannerPreview(preview);
      setStatus("Media ready. Save the profile to publish it.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const save = async () => {
    setSaving(true);
    setStatus("");
    try {
      await professionalNetworkApi.updateProfile({
        ...draft,
        marketSpecialties: splitTags(draft.marketSpecialties),
        assetClasses: splitTags(draft.assetClasses),
        tradingStyleTags: splitTags(draft.tradingStyleTags)
      });
      onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pn-modal-backdrop" role="presentation">
      <section className="pn-editor" role="dialog" aria-modal="true" aria-labelledby="pn-profile-editor-title">
        <header><div><span>Professional Identity</span><h2 id="pn-profile-editor-title">Edit Profile</h2></div><button type="button" onClick={onClose} aria-label="Close profile editor"><X size={15} /></button></header>
        <div className="pn-editor-scroll">
          <div className="pn-editor-preview">
            <div className="pn-editor-cover" style={{ backgroundImage: bannerPreview ? `url(${bannerPreview})` : undefined }}><label><ImagePlus size={14} /> Cover<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => upload(event.target.files?.[0], "cover")} /></label></div>
            <div className="pn-editor-avatar" style={{ backgroundImage: avatarPreview ? `url(${avatarPreview})` : undefined }}><span>{draft.displayName.slice(0, 2).toUpperCase()}</span><label><ImagePlus size={13} /><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => upload(event.target.files?.[0], "avatar")} /></label></div>
            <div><strong>{draft.displayName || "Display Name"}</strong><span>@{draft.handle}</span><p>{draft.headline || "Professional headline"}</p><div>{tags.slice(0, 4).map((tag) => <em key={tag}>{tag}</em>)}</div></div>
          </div>

          <EditorSection title="Identity">
            <Field label="Display Name"><input value={draft.displayName} maxLength={80} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
            <Field label="Handle"><input value={draft.handle} maxLength={30} onChange={(event) => setDraft({ ...draft, handle: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} /></Field>
            <Field label="Headline" wide><input value={draft.headline} maxLength={160} onChange={(event) => setDraft({ ...draft, headline: event.target.value })} /></Field>
            <Field label="Biography" wide><textarea value={draft.bio} maxLength={3000} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></Field>
            <Field label="Professional Role"><input value={draft.roleLabel} onChange={(event) => setDraft({ ...draft, roleLabel: event.target.value })} /></Field>
            <Field label="Organization"><input value={draft.organization} onChange={(event) => setDraft({ ...draft, organization: event.target.value })} /></Field>
            <Field label="Website"><input type="url" value={draft.website} placeholder="https://" onChange={(event) => setDraft({ ...draft, website: event.target.value })} /></Field>
            <Field label="Location"><input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></Field>
            <Field label="Country"><input value={draft.country} onChange={(event) => setDraft({ ...draft, country: event.target.value })} /></Field>
            <Field label="Timezone"><input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></Field>
          </EditorSection>

          <EditorSection title="Market Specialties">
            <Field label="Markets" wide><input value={draft.marketSpecialties} placeholder="Crypto, Equities, Macro" onChange={(event) => setDraft({ ...draft, marketSpecialties: event.target.value })} /></Field>
            <Field label="Asset Classes" wide><input value={draft.assetClasses} placeholder="Perpetuals, Spot, Options" onChange={(event) => setDraft({ ...draft, assetClasses: event.target.value })} /></Field>
            <Field label="Trading Style" wide><input value={draft.tradingStyleTags} placeholder="Orderflow, Quantitative, Swing" onChange={(event) => setDraft({ ...draft, tradingStyleTags: event.target.value })} /></Field>
          </EditorSection>

          <EditorSection title="Visibility And Communication">
            <Field label="Profile Visibility"><select value={draft.profileVisibility} onChange={(event) => setDraft({ ...draft, profileVisibility: event.target.value as typeof draft.profileVisibility })}><option value="public">Public</option><option value="followers">Followers</option><option value="private">Private</option></select></Field>
            <Field label="Who Can Message Me"><select value={draft.messagePolicy} onChange={(event) => setDraft({ ...draft, messagePolicy: event.target.value as typeof draft.messagePolicy })}><option value="everyone">Everyone</option><option value="followers">Followers / Requests</option><option value="nobody">Nobody</option></select></Field>
            {[
              ["showPublicStats", "Performance Statistics"], ["showPublicPnl", "PnL"], ["showPublicDrawdown", "Drawdown"],
              ["showPublicEquityCurve", "Equity Curve"], ["showVerifiedExchangePerformance", "Verified Venue Performance"],
              ["showPositions", "Positions"], ["showGroupMembership", "Investment Groups"]
            ].map(([key, label]) => <label className="pn-check" key={key}><input type="checkbox" checked={Boolean(draft[key as keyof typeof draft])} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /><span>{label}</span></label>)}
          </EditorSection>
          {status && <div className="pn-form-status">{status}</div>}
        </div>
        <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={saving} onClick={save}><Save size={13} /> {saving ? "Saving" : "Save Profile"}</button></footer>
      </section>
    </div>
  );
}

function EditorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="pn-editor-section"><h3>{title}</h3><div className="pn-field-grid">{children}</div></section>;
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={wide ? "wide" : ""}><span>{label}</span>{children}</label>;
}

function splitTags(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}
