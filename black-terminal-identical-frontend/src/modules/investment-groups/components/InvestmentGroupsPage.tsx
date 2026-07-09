import { useMemo, useState } from "react";
import {
  BadgeCheck,
  BarChart3,
  Check,
  DoorOpen,
  Lock,
  MessageSquare,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X
} from "lucide-react";
import type { CapabilityUser } from "../../../core/permissions/capabilities";
import {
  canCreateInvestmentGroup,
  canManageInvestmentGroup,
  createInvestmentGroup,
  listInvestmentGroups,
  postGroupMessage,
  requestToJoinGroup,
  reviewJoinRequest,
  userIdFromUsername
} from "../../profile/professionalNetworkStore";
import type { InvestmentGroup, InvestmentGroupAccessMode, InvestmentGroupVisibility, TradingRoomChannel } from "../../profile/types";

type InvestmentGroupsPageProps = {
  currentUser: CapabilityUser;
  onClose: () => void;
};

type GroupTab =
  | "Overview"
  | "Performance"
  | "Drawdown"
  | "Positions Visibility"
  | "Research"
  | "Members"
  | "Trading Room"
  | "Risk"
  | "Requests"
  | "Settings";

const groupTabs: GroupTab[] = [
  "Overview",
  "Performance",
  "Drawdown",
  "Positions Visibility",
  "Research",
  "Members",
  "Trading Room",
  "Risk",
  "Requests",
  "Settings"
];

const tradingStyles = ["scalping", "swing trading", "macro", "crypto futures", "spot", "DeFi", "orderflow", "volume profile", "quant", "discretionary", "HDLX"];

const defaultDraft = {
  firmName: "",
  logoUrl: "",
  bannerUrl: "",
  description: "",
  bio: "",
  tradingStyleTags: [] as string[],
  visibility: "public" as InvestmentGroupVisibility,
  accessMode: "approval_required" as InvestmentGroupAccessMode,
  password: "",
  minimumEquity: "",
  acceptedExchanges: "Hyperliquid, Bybit, Binance",
  acceptedWallets: "MetaMask, Phantom",
  maxFollowers: "",
  approvalRequired: true,
  riskDisclaimer: "Historical performance is not a guarantee of future returns. Followers retain explicit control over allocation and execution permissions.",
  managerTermsAccepted: false
};

export function InvestmentGroupsPage({ currentUser, onClose }: InvestmentGroupsPageProps) {
  const [revision, setRevision] = useState(0);
  const data = useMemo(() => listInvestmentGroups(currentUser), [currentUser, revision]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(data.publicGroups[0]?.id ?? data.myGroups[0]?.id ?? null);
  const selectedGroup = useMemo(
    () => data.state.groups.find((group) => group.id === selectedGroupId) ?? data.publicGroups[0] ?? data.myGroups[0],
    [data, selectedGroupId]
  );
  const [activeTab, setActiveTab] = useState<GroupTab>("Overview");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [draft, setDraft] = useState(defaultDraft);
  const [joinMessage, setJoinMessage] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [roomChannel, setRoomChannel] = useState<TradingRoomChannel>("general");
  const [roomMessage, setRoomMessage] = useState("");
  const [status, setStatus] = useState("");
  const canCreate = canCreateInvestmentGroup(currentUser);
  const currentUserId = userIdFromUsername(currentUser.username);

  const refresh = () => setRevision((value) => value + 1);

  const finishWizard = async () => {
    try {
      if (!draft.firmName.trim()) throw new Error("Firm name is required.");
      if (!draft.managerTermsAccepted) throw new Error("Manager terms acknowledgement is required.");
      const passwordHash = draft.accessMode === "password_protected" && draft.password ? await hashText(draft.password) : undefined;
      const group = createInvestmentGroup(currentUser, {
        firmName: draft.firmName.trim(),
        logoUrl: draft.logoUrl.trim(),
        bannerUrl: draft.bannerUrl.trim(),
        description: draft.description.trim(),
        bio: draft.bio.trim(),
        visibility: draft.visibility,
        accessMode: draft.accessMode,
        passwordHash,
        tradingStyleTags: draft.tradingStyleTags,
        acceptedExchanges: splitList(draft.acceptedExchanges),
        acceptedWallets: splitList(draft.acceptedWallets),
        minimumEquity: draft.minimumEquity ? Number(draft.minimumEquity) : undefined,
        maxFollowers: draft.maxFollowers ? Number(draft.maxFollowers) : undefined,
        approvalRequired: draft.approvalRequired,
        riskDisclaimer: draft.riskDisclaimer,
        managerTermsAccepted: draft.managerTermsAccepted
      });
      setSelectedGroupId(group.id);
      setWizardOpen(false);
      setDraft(defaultDraft);
      setWizardStep(1);
      setStatus("Investment group created.");
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const submitJoinRequest = async () => {
    if (!selectedGroup) return;
    try {
      const passwordHash = selectedGroup.accessMode === "password_protected" ? await hashText(joinPassword) : undefined;
      requestToJoinGroup(currentUser, selectedGroup.id, joinMessage, passwordHash);
      setJoinMessage("");
      setJoinPassword("");
      setStatus("Join request submitted.");
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const submitRoomMessage = () => {
    if (!selectedGroup) return;
    try {
      postGroupMessage(currentUser, selectedGroup.id, roomChannel, roomMessage.trim());
      setRoomMessage("");
      setStatus("Trading Room message posted.");
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const visibleGroups = [...new Map([...data.myGroups, ...data.publicGroups].map((group) => [group.id, group])).values()];

  return (
    <div className="network-page">
      <header className="network-head">
        <div>
          <span>INVESTMENT GROUPS</span>
          <strong>Professional manager discovery, join requests, Trading Rooms, and group governance</strong>
        </div>
        <div className="network-head-actions">
          {canCreate && <button type="button" onClick={() => setWizardOpen(true)}><Plus size={14} /> Create Group</button>}
          <button type="button" onClick={onClose} aria-label="Close Investment Groups"><X size={14} /></button>
        </div>
      </header>

      {status && <div className="network-status">{status}</div>}

      <main className="investment-layout">
        <aside className="investment-discovery">
          <div className="network-panel-title"><Users size={14} /> Discovery</div>
          {!canCreate && <div className="network-note"><Lock size={13} /> Group creation requires Enterprise or Admin permissions.</div>}
          {visibleGroups.length === 0 ? (
            <div className="network-empty">NO PUBLIC INVESTMENT GROUPS PUBLISHED YET.</div>
          ) : (
            visibleGroups.map((group) => (
              <button
                type="button"
                className={selectedGroup?.id === group.id ? "investment-group-row active" : "investment-group-row"}
                key={group.id}
                onClick={() => {
                  setSelectedGroupId(group.id);
                  setActiveTab("Overview");
                }}
              >
                <strong>{group.firmName}</strong>
                <span>{group.description || "Professional investment organization"}</span>
                <em>{group.visibility.toUpperCase()} / {group.ownerUsername}</em>
              </button>
            ))
          )}
        </aside>

        {selectedGroup ? (
          <section className="investment-detail">
            <GroupHeader
              group={selectedGroup}
              currentUserId={currentUserId}
              canManage={canManageInvestmentGroup(currentUser, selectedGroup)}
              onJoinRequest={submitJoinRequest}
              joinMessage={joinMessage}
              joinPassword={joinPassword}
              onJoinMessageChange={setJoinMessage}
              onJoinPasswordChange={setJoinPassword}
            />
            <nav className="network-tabs compact-tabs">
              {groupTabs.map((tab) => (
                <button type="button" key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
                  {tab}
                </button>
              ))}
            </nav>
            <GroupTabContent
              tab={activeTab}
              group={selectedGroup}
              currentUser={currentUser}
              data={data.state}
              roomChannel={roomChannel}
              roomMessage={roomMessage}
              onChannelChange={setRoomChannel}
              onMessageChange={setRoomMessage}
              onPostMessage={submitRoomMessage}
              onReview={(requestId, action) => {
                try {
                  reviewJoinRequest(currentUser, requestId, action);
                  refresh();
                } catch (error) {
                  setStatus(error instanceof Error ? error.message : String(error));
                }
              }}
            />
          </section>
        ) : (
          <section className="investment-detail empty">
            <div className="network-empty">CREATE OR DISCOVER AN INVESTMENT GROUP TO OPEN ITS PROFESSIONAL PAGE.</div>
          </section>
        )}
      </main>

      {wizardOpen && (
        <div className="network-modal-backdrop">
          <div className="network-modal">
            <header>
              <strong>Create Investment Group</strong>
              <button type="button" onClick={() => setWizardOpen(false)}><X size={14} /></button>
            </header>
            <div className="wizard-steps">
              {[1, 2, 3, 4, 5, 6].map((step) => (
                <button type="button" key={step} className={wizardStep === step ? "active" : ""} onClick={() => setWizardStep(step)}>
                  {step}
                </button>
              ))}
            </div>
            <WizardStep step={wizardStep} draft={draft} onChange={setDraft} />
            <footer>
              <button type="button" disabled={wizardStep === 1} onClick={() => setWizardStep((step) => Math.max(1, step - 1))}>Back</button>
              {wizardStep < 6 ? (
                <button type="button" onClick={() => setWizardStep((step) => Math.min(6, step + 1))}>Next</button>
              ) : (
                <button type="button" onClick={finishWizard}><Check size={14} /> Create Group</button>
              )}
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupHeader({
  group,
  currentUserId,
  canManage,
  onJoinRequest,
  joinMessage,
  joinPassword,
  onJoinMessageChange,
  onJoinPasswordChange
}: {
  group: InvestmentGroup;
  currentUserId: string;
  canManage: boolean;
  onJoinRequest: () => void;
  joinMessage: string;
  joinPassword: string;
  onJoinMessageChange: (value: string) => void;
  onJoinPasswordChange: (value: string) => void;
}) {
  const isOwner = group.ownerUserId === currentUserId;
  return (
    <section className="investment-hero">
      <div className="investment-banner" style={{ backgroundImage: group.bannerUrl ? `url(${group.bannerUrl})` : undefined }} />
      <div className="investment-title-row">
        <div className="investment-logo" style={{ backgroundImage: group.logoUrl ? `url(${group.logoUrl})` : undefined }}>
          {!group.logoUrl && group.firmName.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <strong>{group.firmName}</strong>
          <span>Owner @{group.ownerUsername}</span>
          <p>{group.bio || group.description || "No investment mandate published yet."}</p>
        </div>
        <div className="investment-badges">
          <em><BadgeCheck size={13} /> Verified Placeholder</em>
          <em><ShieldCheck size={13} /> Enterprise</em>
          <em>{group.visibility.toUpperCase()}</em>
        </div>
      </div>
      {!isOwner && !canManage && (
        <div className="investment-join">
          {group.accessMode === "password_protected" && <input type="password" value={joinPassword} onChange={(event) => onJoinPasswordChange(event.target.value)} placeholder="Group password" />}
          <input value={joinMessage} onChange={(event) => onJoinMessageChange(event.target.value)} placeholder="Optional request message" />
          <button type="button" onClick={onJoinRequest}><DoorOpen size={14} /> Request To Join</button>
        </div>
      )}
    </section>
  );
}

function GroupTabContent({
  tab,
  group,
  currentUser,
  data,
  roomChannel,
  roomMessage,
  onChannelChange,
  onMessageChange,
  onPostMessage,
  onReview
}: {
  tab: GroupTab;
  group: InvestmentGroup;
  currentUser: CapabilityUser;
  data: ReturnType<typeof listInvestmentGroups>["state"];
  roomChannel: TradingRoomChannel;
  roomMessage: string;
  onChannelChange: (channel: TradingRoomChannel) => void;
  onMessageChange: (message: string) => void;
  onPostMessage: () => void;
  onReview: (requestId: string, action: "approve" | "decline") => void;
}) {
  const members = data.groupMembers.filter((member) => member.groupId === group.id && member.status === "active");
  const requests = data.joinRequests.filter((request) => request.groupId === group.id && request.status === "pending");
  const messages = data.messages.filter((message) => message.groupId === group.id && message.channel === roomChannel);
  const canManage = canManageInvestmentGroup(currentUser, group);

  if (tab === "Overview") {
    return (
      <section className="network-grid two">
        {[
          ["Followers", group.stats.followerCount],
          ["Connected Investors", group.stats.connectedInvestorCount],
          ["Connected Equity / AUM", group.stats.connectedEquity > 0 ? money(group.stats.connectedEquity) : "AWAITING VERIFIED DATA"],
          ["Monthly Return", statPercent(group.stats.monthlyReturn)],
          ["Yearly Return", statPercent(group.stats.yearlyReturn)],
          ["Total Return", statPercent(group.stats.totalReturn)],
          ["Max Drawdown", statPercent(group.stats.maxDrawdown)],
          ["Current Drawdown", statPercent(group.stats.currentDrawdown)],
          ["Risk Score", group.stats.riskScore ?? "AWAITING DATA"],
          ["Win Rate", statPercent(group.stats.winRate)],
          ["Profit Factor", group.stats.profitFactor ?? "AWAITING DATA"],
          ["Average Trade Duration", group.stats.averageTradeDuration ?? "AWAITING DATA"]
        ].map(([label, value]) => (
          <div className="network-stat" key={label}>
            <span>{label}</span>
            <b>{value}</b>
            <em>{group.stats.verified ? "VERIFIED" : "UNVERIFIED / HISTORICAL ONLY"}</em>
          </div>
        ))}
      </section>
    );
  }

  if (tab === "Trading Room") {
    return (
      <section className="network-grid feed">
        <div className="network-panel">
          <div className="network-panel-title"><MessageSquare size={14} /> Trading Room</div>
          <div className="network-inline-form">
            <select value={roomChannel} onChange={(event) => onChannelChange(event.target.value as TradingRoomChannel)}>
              <option value="announcements">Announcements</option>
              <option value="general">General</option>
              <option value="research">Research</option>
              <option value="trades">Trades</option>
            </select>
            <input value={roomMessage} onChange={(event) => onMessageChange(event.target.value)} placeholder="Professional room message" />
            <button type="button" onClick={onPostMessage} disabled={roomMessage.trim().length < 2}>Post</button>
          </div>
          {messages.length === 0 ? (
            <div className="network-empty">NO TRADING ROOM MESSAGES IN THIS CHANNEL.</div>
          ) : (
            <div className="network-list">
              {messages.map((message) => (
                <div className="network-list-row" key={message.id}>
                  <strong>@{message.username}</strong>
                  <span>{message.body}</span>
                  <em>{message.role.toUpperCase()} / {new Date(message.createdAt).toLocaleString()}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  if (tab === "Requests") {
    return (
      <section className="network-panel">
        <div className="network-panel-title"><DoorOpen size={14} /> Join Requests</div>
        {!canManage ? (
          <div className="network-empty">REQUEST REVIEW IS AVAILABLE ONLY TO THE GROUP OWNER OR ADMIN.</div>
        ) : requests.length === 0 ? (
          <div className="network-empty">NO PENDING JOIN REQUESTS.</div>
        ) : (
          <div className="network-list">
            {requests.map((request) => (
              <div className="network-list-row request-row" key={request.id}>
                <strong>@{request.username}</strong>
                <span>{request.message || "No request message."}</span>
                <em>{new Date(request.createdAt).toLocaleString()}</em>
                <button type="button" onClick={() => onReview(request.id, "approve")}>Approve</button>
                <button type="button" onClick={() => onReview(request.id, "decline")}>Decline</button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (tab === "Members") {
    return (
      <section className="network-panel">
        <div className="network-panel-title"><Users size={14} /> Members</div>
        {members.map((member) => (
          <div className="network-list-row" key={member.id}>
            <strong>@{member.username}</strong>
            <span>{member.role.toUpperCase()}</span>
            <em>JOINED {new Date(member.joinedAt).toLocaleDateString()}</em>
          </div>
        ))}
      </section>
    );
  }

  if (tab === "Settings") {
    return (
      <section className="network-panel">
        <div className="network-panel-title"><SlidersHorizontal size={14} /> Settings</div>
        <div className="network-empty">
          GROUP SETTINGS ARE SCAFFOLDED. PRODUCTION EDITS MUST BE SERVER-AUTHORIZED AND AUDITED.
        </div>
      </section>
    );
  }

  return (
    <section className="network-panel">
      <div className="network-panel-title"><BarChart3 size={14} /> {tab}</div>
      <div className="network-empty">
        {tab.toUpperCase()} WILL POPULATE FROM VERIFIED PORTFOLIO, POSITION, RESEARCH, AND RISK FEEDS. NO GUARANTEED RETURN LANGUAGE IS SHOWN.
      </div>
    </section>
  );
}

function WizardStep({ step, draft, onChange }: { step: number; draft: typeof defaultDraft; onChange: (draft: typeof defaultDraft) => void }) {
  if (step === 1) {
    return (
      <div className="network-form-grid">
        <label>Firm Name<input value={draft.firmName} onChange={(event) => onChange({ ...draft, firmName: event.target.value })} /></label>
        <label>Logo URL<input value={draft.logoUrl} onChange={(event) => onChange({ ...draft, logoUrl: event.target.value })} /></label>
        <label className="wide">Cover Banner URL<input value={draft.bannerUrl} onChange={(event) => onChange({ ...draft, bannerUrl: event.target.value })} /></label>
        <label className="wide">Short Description<input value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label>
        <label className="wide">Long Bio<textarea value={draft.bio} onChange={(event) => onChange({ ...draft, bio: event.target.value })} /></label>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="wizard-tags">
        {tradingStyles.map((tag) => (
          <button
            type="button"
            key={tag}
            className={draft.tradingStyleTags.includes(tag) ? "active" : ""}
            onClick={() => onChange({
              ...draft,
              tradingStyleTags: draft.tradingStyleTags.includes(tag)
                ? draft.tradingStyleTags.filter((item) => item !== tag)
                : [...draft.tradingStyleTags, tag]
            })}
          >
            {tag}
          </button>
        ))}
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="network-form-grid">
        <label>Visibility
          <select value={draft.visibility} onChange={(event) => onChange({ ...draft, visibility: event.target.value as InvestmentGroupVisibility })}>
            <option value="public">Public</option>
            <option value="private">Private</option>
            <option value="invite_only">Invite Only</option>
            <option value="password_protected">Password Protected</option>
          </select>
        </label>
        <label>Access Mode
          <select value={draft.accessMode} onChange={(event) => onChange({ ...draft, accessMode: event.target.value as InvestmentGroupAccessMode })}>
            <option value="open">Open</option>
            <option value="approval_required">Approval Required</option>
            <option value="invite_only">Invite Only</option>
            <option value="password_protected">Password Protected</option>
          </select>
        </label>
        {draft.accessMode === "password_protected" && (
          <label className="wide">Connectivity Password<input type="password" value={draft.password} onChange={(event) => onChange({ ...draft, password: event.target.value })} /></label>
        )}
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="network-form-grid">
        <label>Minimum Follower Equity<input type="number" value={draft.minimumEquity} onChange={(event) => onChange({ ...draft, minimumEquity: event.target.value })} /></label>
        <label>Maximum Followers<input type="number" value={draft.maxFollowers} onChange={(event) => onChange({ ...draft, maxFollowers: event.target.value })} /></label>
        <label className="wide">Accepted Exchanges<input value={draft.acceptedExchanges} onChange={(event) => onChange({ ...draft, acceptedExchanges: event.target.value })} /></label>
        <label className="wide">Accepted Wallets<input value={draft.acceptedWallets} onChange={(event) => onChange({ ...draft, acceptedWallets: event.target.value })} /></label>
        <label className="network-check wide"><input type="checkbox" checked={draft.approvalRequired} onChange={(event) => onChange({ ...draft, approvalRequired: event.target.checked })} /> Approval required</label>
      </div>
    );
  }

  if (step === 5) {
    return (
      <div className="network-form-grid">
        <label className="wide">Risk Disclaimer<textarea value={draft.riskDisclaimer} onChange={(event) => onChange({ ...draft, riskDisclaimer: event.target.value })} /></label>
        <label className="network-check wide"><input type="checkbox" checked={draft.managerTermsAccepted} onChange={(event) => onChange({ ...draft, managerTermsAccepted: event.target.checked })} /> I acknowledge no guaranteed returns, historical performance only, and manager terms.</label>
      </div>
    );
  }

  return (
    <div className="network-summary">
      <strong>{draft.firmName || "Unnamed Group"}</strong>
      <span>{draft.visibility.toUpperCase()} / {draft.accessMode.replace(/_/g, " ").toUpperCase()}</span>
      <p>{draft.riskDisclaimer}</p>
    </div>
  );
}

async function hashText(value: string) {
  if (!value) return "";
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return btoa(value);
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function statPercent(value: number | null) {
  return value === null || value === undefined ? "AWAITING DATA" : `${value.toFixed(2)}%`;
}
