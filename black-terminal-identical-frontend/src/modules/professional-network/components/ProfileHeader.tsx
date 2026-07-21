import { BadgeCheck, Ban, BellOff, Flag, Link2, MessageSquare, MoreHorizontal, Pencil, Settings2, UserMinus, UserPlus } from "lucide-react";
import { useState } from "react";
import { professionalNetworkApi } from "../networkApi";
import type { ProfilePayload } from "../types";

export function ProfileHeader({ payload, busy, onEdit, onFollow, onMessage, onRelationship }: {
  payload: ProfilePayload;
  busy?: boolean;
  onEdit: () => void;
  onFollow: () => void;
  onMessage: () => void;
  onRelationship: (operation: "mute" | "unmute" | "block" | "unblock") => void;
}) {
  const { profile, viewer, credibility } = payload;
  const initials = (profile.display_name || profile.handle).slice(0, 2).toUpperCase();
  const share = async () => {
    const url = `${window.location.origin}/#network/profile/${profile.handle}/overview`;
    await navigator.clipboard?.writeText(url);
  };
  return (
    <section className="pn-profile-hero" aria-label={`${profile.display_name || profile.handle} professional profile`}>
      <div className="pn-profile-cover" style={{ backgroundImage: profile.banner_signed_url ? `url(${profile.banner_signed_url})` : undefined }} />
      <div className="pn-profile-main">
        <div className="pn-profile-avatar" style={{ backgroundImage: profile.avatar_signed_url ? `url(${profile.avatar_signed_url})` : undefined }}>
          {!profile.avatar_signed_url && initials}
        </div>
        <div className="pn-profile-copy">
          <div className="pn-profile-name">
            <h1>{profile.display_name || profile.handle}</h1>
            {profile.verified_role && <BadgeCheck size={16} aria-label="Verified professional role" />}
            {profile.professional_role && <span>{profile.professional_role}</span>}
          </div>
          <div className="pn-handle">@{profile.handle}{profile.organization ? ` · ${profile.organization}` : ""}</div>
          <p className="pn-headline">{profile.headline || "Professional market participant"}</p>
          <div className="pn-profile-tags">
            {[...(profile.market_specialties || []), ...(profile.asset_classes || [])].slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </div>
        <div className="pn-profile-actions">
          {viewer.isOwner ? (
            <>
              <button type="button" onClick={onEdit}><Pencil size={13} /> Edit Profile</button>
              <button type="button" onClick={onEdit}><Settings2 size={13} /> Privacy</button>
            </>
          ) : (
            <>
              <button type="button" className={viewer.isFollowing ? "subtle" : "primary"} disabled={busy || viewer.followRequestPending} onClick={onFollow}>
                {viewer.isFollowing ? <UserMinus size={13} /> : <UserPlus size={13} />}
                {viewer.followRequestPending ? "Requested" : viewer.isFollowing ? "Following" : "Follow"}
              </button>
              <button type="button" disabled={busy || viewer.isBlocked} onClick={onMessage}><MessageSquare size={13} /> Message</button>
              <details className="pn-action-menu">
                <summary aria-label="More profile actions"><MoreHorizontal size={14} /></summary>
                <div>
                  <button type="button" onClick={share}><Link2 size={12} /> Copy Profile Link</button>
                  <button type="button" onClick={() => onRelationship(viewer.isMuted ? "unmute" : "mute")}><BellOff size={12} /> {viewer.isMuted ? "Unmute" : "Mute"}</button>
                  <ProfileReportAction targetUserId={profile.user_id} />
                  <button type="button" className="danger" onClick={() => onRelationship(viewer.isBlocked ? "unblock" : "block")}><Ban size={12} /> {viewer.isBlocked ? "Unblock" : "Block"}</button>
                </div>
              </details>
            </>
          )}
        </div>
      </div>
      <div className="pn-credibility" aria-label="Professional credibility summary">
        <span><b>{credibility.followers.toLocaleString()}</b> Followers</span>
        <span><b>{credibility.following.toLocaleString()}</b> Following</span>
        <span><b>{credibility.research.toLocaleString()}</b> Research</span>
        <span><b>{credibility.indicators.toLocaleString()}</b> Indicators</span>
        <span><b>{credibility.strategies.toLocaleString()}</b> Strategies</span>
        <span><b>{credibility.groups.toLocaleString()}</b> Groups</span>
      </div>
    </section>
  );
}

function ProfileReportAction({ targetUserId }: { targetUserId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("misleading_performance_claims");
  const [status, setStatus] = useState("");
  if (status) return <span className="pn-report-confirmation">{status}</span>;
  if (!open) return <button type="button" onClick={() => setOpen(true)}><Flag size={12} /> Report</button>;
  return <div className="pn-report-options"><select aria-label="Profile report reason" value={reason} onChange={(event) => setReason(event.target.value)}><option value="misleading_performance_claims">Misleading Performance Claims</option><option value="spam">Spam</option><option value="harassment">Harassment</option><option value="impersonation">Impersonation</option><option value="scam">Scam</option><option value="market_manipulation">Market Manipulation</option><option value="sensitive_information">Sensitive Information</option><option value="other">Other</option></select><button type="button" onClick={async () => { try { await professionalNetworkApi.report("profile", targetUserId, reason); setStatus("Report submitted"); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } }}>Submit</button></div>;
}
