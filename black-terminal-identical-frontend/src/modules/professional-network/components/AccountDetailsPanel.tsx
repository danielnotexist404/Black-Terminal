import { BadgeCheck, Building2, Mail, MapPin, Phone, Save, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { CapabilityUser } from "../../../core/permissions/capabilities";
import { dbGetCurrentUserProfile, dbUpdateCurrentUserProfile, type DBUser } from "../../../lib/supabase";

type AccountDraft = {
  displayName: string;
  firstName: string;
  lastName: string;
  organization: string;
  residentialAddress: string;
  purposeOfUse: "personal" | "commercial";
  phone: string;
  referredBy: string;
  newsletterOptIn: boolean;
};

function emptyDraft(user: CapabilityUser): AccountDraft {
  return {
    displayName: user.displayName || user.username,
    firstName: "",
    lastName: "",
    organization: "",
    residentialAddress: "",
    purposeOfUse: "personal",
    phone: "",
    referredBy: "",
    newsletterOptIn: false
  };
}

export function AccountDetailsPanel({ currentUser, onProfileUpdated }: {
  currentUser: CapabilityUser;
  onProfileUpdated?: (profile: DBUser) => void;
}) {
  const [draft, setDraft] = useState<AccountDraft>(() => emptyDraft(currentUser));
  const [email, setEmail] = useState(currentUser.email || "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void dbGetCurrentUserProfile()
      .then((profile) => {
        if (!active || !profile) return;
        setEmail(profile.email);
        setDraft({
          displayName: profile.displayName || profile.username,
          firstName: profile.firstName || "",
          lastName: profile.lastName || "",
          organization: profile.organization || "",
          residentialAddress: profile.billingAddress || "",
          purposeOfUse: profile.purposeOfUse || "personal",
          phone: profile.phone || "",
          referredBy: profile.referredBy || "",
          newsletterOptIn: profile.newsletterOptIn || false
        });
      })
      .catch((error) => active && setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const completeness = useMemo(() => {
    const fields = [draft.displayName, draft.firstName, draft.lastName, draft.phone, draft.residentialAddress, draft.organization];
    return Math.round((fields.filter((value) => value.trim()).length / fields.length) * 100);
  }, [draft]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setStatus("");
    try {
      const profile = await dbUpdateCurrentUserProfile({
        displayName: draft.displayName.trim(),
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        organization: draft.organization.trim(),
        billingAddress: draft.residentialAddress.trim(),
        purposeOfUse: draft.purposeOfUse,
        phone: draft.phone.trim(),
        referredBy: draft.referredBy.trim(),
        newsletterOptIn: draft.newsletterOptIn
      });
      setSaved(true);
      onProfileUpdated?.(profile);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pn-account-panel" aria-labelledby="pn-account-title">
      <header className="pn-account-hero">
        <div className="pn-account-avatar" aria-hidden><UserRound size={24} /></div>
        <div>
          <span>Authenticated Google account</span>
          <h1 id="pn-account-title">Welcome, {draft.firstName || draft.displayName.split(/\s+/)[0] || currentUser.username}</h1>
          <p>Complete your private account details whenever you are ready. These details are not required for Google sign-in.</p>
        </div>
        <div className="pn-account-completeness">
          <strong>{completeness}%</strong>
          <span>Profile complete</span>
          <i style={{ "--account-progress": `${completeness}%` } as CSSProperties} />
        </div>
      </header>

      <div className="pn-account-security">
        <BadgeCheck size={15} />
        <div><strong>{email || "Verified Google account"}</strong><span>Identity verified through Google SSO</span></div>
        <ShieldCheck size={17} />
      </div>

      <div className="pn-account-form">
        <label><span><UserRound size={13} /> Display name</span><input value={draft.displayName} disabled={loading} autoComplete="name" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label><span><Mail size={13} /> Verified email</span><input value={email} disabled readOnly /></label>
        <label><span>First name</span><input value={draft.firstName} disabled={loading} autoComplete="given-name" onChange={(event) => setDraft({ ...draft, firstName: event.target.value })} /></label>
        <label><span>Last name</span><input value={draft.lastName} disabled={loading} autoComplete="family-name" onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} /></label>
        <label><span><Phone size={13} /> Phone number</span><input type="tel" value={draft.phone} disabled={loading} autoComplete="tel" placeholder="+972 50 000 0000" onChange={(event) => setDraft({ ...draft, phone: event.target.value })} /></label>
        <label><span><Building2 size={13} /> Organization / company</span><input value={draft.organization} disabled={loading} autoComplete="organization" placeholder="Optional" onChange={(event) => setDraft({ ...draft, organization: event.target.value })} /></label>
        <label className="wide"><span><MapPin size={13} /> Residential address</span><input value={draft.residentialAddress} disabled={loading} autoComplete="street-address" placeholder="Street, number, city and postal code" onChange={(event) => setDraft({ ...draft, residentialAddress: event.target.value })} /></label>
        <label><span>Purpose of use</span><select value={draft.purposeOfUse} disabled={loading} onChange={(event) => setDraft({ ...draft, purposeOfUse: event.target.value as AccountDraft["purposeOfUse"] })}><option value="personal">Personal</option><option value="commercial">Commercial</option></select></label>
        <label><span>How did you find us?</span><input value={draft.referredBy} disabled={loading} placeholder="Optional" onChange={(event) => setDraft({ ...draft, referredBy: event.target.value })} /></label>
        <label className="pn-account-check wide"><input type="checkbox" checked={draft.newsletterOptIn} disabled={loading} onChange={(event) => setDraft({ ...draft, newsletterOptIn: event.target.checked })} /><span>Send me product updates and important system announcements</span></label>
      </div>

      <footer>
        <div>{status ? <span className="error">{status}</span> : saved ? <span className="success">Profile details saved securely.</span> : <span>Private details are stored in your secured account profile.</span>}</div>
        <button type="button" disabled={loading || saving} onClick={save}><Save size={14} /> {saving ? "Saving..." : "Save account details"}</button>
      </footer>
    </section>
  );
}
