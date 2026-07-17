import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  BarChart3,
  Check,
  DoorOpen,
  ImagePlus,
  Lock,
  MessageSquare,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCog,
  UserMinus,
  UserRound,
  Users,
  X
} from "lucide-react";
import type { CapabilityUser } from "../../../core/permissions/capabilities";
import {
  canCreateInvestmentGroup,
  canManageInvestmentGroup,
  canModerateInvestmentGroup,
  createInvestmentGroup,
  deleteGroupMessage,
  isInvestmentGroupMember,
  isInvestmentGroupSectionPublic,
  listInvestmentGroups,
  postGroupMessage,
  removeInvestmentGroupMember,
  requestToJoinGroup,
  reviewJoinRequest,
  setInvestmentGroupMemberRole,
  updateInvestmentGroup,
  userIdFromUsername
} from "../../profile/professionalNetworkStore";
import type {
  InvestmentGroup,
  InvestmentGroupAccessMode,
  InvestmentGroupMember,
  InvestmentGroupMessage,
  InvestmentGroupPublicSection,
  InvestmentGroupVisibility,
  TradingRoomChannel
} from "../../profile/types";

type InvestmentGroupsPageProps = {
  currentUser: CapabilityUser;
  onClose: () => void;
  onOpenProfile: (username: string) => void;
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

const publicSectionOptions: { section: InvestmentGroupPublicSection; tab: GroupTab; label: string }[] = [
  { section: "performance", tab: "Performance", label: "Performance" },
  { section: "drawdown", tab: "Drawdown", label: "Drawdown" },
  { section: "positions", tab: "Positions Visibility", label: "Positions Visibility" },
  { section: "research", tab: "Research", label: "Research" },
  { section: "members", tab: "Members", label: "Members" },
  { section: "trading_room", tab: "Trading Room", label: "Trading Room" },
  { section: "risk", tab: "Risk", label: "Risk" }
];

const publicSectionByTab = new Map<GroupTab, InvestmentGroupPublicSection>(publicSectionOptions.map((item) => [item.tab, item.section]));

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
  publicSections: [] as InvestmentGroupPublicSection[],
  riskDisclaimer: "Historical performance is not a guarantee of future returns. Followers retain explicit control over allocation and execution permissions.",
  managerTermsAccepted: false
};

export function InvestmentGroupsPage({ currentUser, onClose, onOpenProfile }: InvestmentGroupsPageProps) {
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
  const selectedCanManage = selectedGroup ? canManageInvestmentGroup(currentUser, selectedGroup) : false;
  const selectedCanModerate = selectedGroup ? canModerateInvestmentGroup(currentUser, selectedGroup) : false;
  const selectedIsMember = selectedGroup ? isInvestmentGroupMember(currentUser, selectedGroup.id) : false;
  const visibleTabs = selectedGroup ? groupTabs.filter((tab) => {
    if (tab === "Settings" || tab === "Requests") return selectedCanManage;
    const publicSection = publicSectionByTab.get(tab);
    return !publicSection || selectedIsMember || selectedCanModerate || isInvestmentGroupSectionPublic(selectedGroup, publicSection);
  }) : ["Overview"] as GroupTab[];

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) setActiveTab("Overview");
  }, [activeTab, visibleTabs]);

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
        publicSections: draft.publicSections,
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
              canManage={selectedCanManage}
              isMember={selectedIsMember || selectedCanModerate}
              onJoinRequest={submitJoinRequest}
              joinMessage={joinMessage}
              joinPassword={joinPassword}
              onJoinMessageChange={setJoinMessage}
              onJoinPasswordChange={setJoinPassword}
            />
            <nav className="network-tabs compact-tabs">
              {visibleTabs.map((tab) => (
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
              onOpenProfile={onOpenProfile}
              onGroupUpdated={(message) => {
                setStatus(message);
                refresh();
              }}
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
  isMember,
  onJoinRequest,
  joinMessage,
  joinPassword,
  onJoinMessageChange,
  onJoinPasswordChange
}: {
  group: InvestmentGroup;
  currentUserId: string;
  canManage: boolean;
  isMember: boolean;
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
        <div className="investment-identity-copy">
          <div className="investment-heading-line">
            <strong>{group.firmName}</strong>
            <span>Managed by @{group.ownerUsername}</span>
          </div>
          <p>{group.bio || group.description || "No investment mandate published yet."}</p>
        </div>
        <div className="investment-badges">
          <em>{group.stats.verified ? <><BadgeCheck size={13} /> Verified Performance</> : "Performance Unverified"}</em>
          <em><ShieldCheck size={13} /> Managed Group</em>
          <em>{group.visibility.toUpperCase()}</em>
        </div>
      </div>
      {!isOwner && !canManage && !isMember && (
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
  onOpenProfile,
  onGroupUpdated,
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
  onOpenProfile: (username: string) => void;
  onGroupUpdated: (message: string) => void;
  onReview: (requestId: string, action: "approve" | "decline") => void;
}) {
  const members = data.groupMembers.filter((member) => member.groupId === group.id && member.status === "active");
  const requests = data.joinRequests.filter((request) => request.groupId === group.id && request.status === "pending");
  const messages = data.messages.filter((message) => message.groupId === group.id && message.channel === roomChannel);
  const canManage = canManageInvestmentGroup(currentUser, group);
  const canModerate = canModerateInvestmentGroup(currentUser, group);
  const isMember = isInvestmentGroupMember(currentUser, group.id) || canModerate;

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
      <TradingRoomPanel
        currentUser={currentUser}
        group={group}
        messages={messages}
        roomChannel={roomChannel}
        roomMessage={roomMessage}
        canPost={isMember}
        canModerate={canModerate}
        onChannelChange={onChannelChange}
        onMessageChange={onMessageChange}
        onPostMessage={onPostMessage}
        onOpenProfile={onOpenProfile}
        onChanged={onGroupUpdated}
      />
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
      <MembersPanel
        currentUser={currentUser}
        group={group}
        members={members}
        canManage={canManage}
        canModerate={canModerate}
        onOpenProfile={onOpenProfile}
        onChanged={onGroupUpdated}
      />
    );
  }

  if (tab === "Settings") {
    return canManage
      ? <GroupSettingsEditor currentUser={currentUser} group={group} onSaved={onGroupUpdated} />
      : <section className="network-panel"><div className="network-empty">GROUP SETTINGS ARE AVAILABLE ONLY TO THE GROUP OWNER OR ADMIN.</div></section>;
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

function TradingRoomPanel({
  currentUser,
  group,
  messages,
  roomChannel,
  roomMessage,
  canPost,
  canModerate,
  onChannelChange,
  onMessageChange,
  onPostMessage,
  onOpenProfile,
  onChanged
}: {
  currentUser: CapabilityUser;
  group: InvestmentGroup;
  messages: InvestmentGroupMessage[];
  roomChannel: TradingRoomChannel;
  roomMessage: string;
  canPost: boolean;
  canModerate: boolean;
  onChannelChange: (channel: TradingRoomChannel) => void;
  onMessageChange: (message: string) => void;
  onPostMessage: () => void;
  onOpenProfile: (username: string) => void;
  onChanged: (message: string) => void;
}) {
  const [messageToDelete, setMessageToDelete] = useState<InvestmentGroupMessage | null>(null);
  const [error, setError] = useState("");

  const confirmDelete = (reason: string) => {
    if (!messageToDelete) return;
    try {
      deleteGroupMessage(currentUser, group.id, messageToDelete.id, reason);
      setMessageToDelete(null);
      setError("");
      onChanged("Trading Room message removed and recorded in the moderation audit.");
    } catch (moderationError) {
      setError(moderationError instanceof Error ? moderationError.message : String(moderationError));
    }
  };

  return (
    <section className="network-grid feed">
      <div className="network-panel">
        <div className="network-panel-title"><MessageSquare size={14} /> Trading Room</div>
        <div className={canPost ? "network-inline-form" : "network-inline-form room-read-only"}>
          <select value={roomChannel} onChange={(event) => onChannelChange(event.target.value as TradingRoomChannel)}>
            <option value="announcements">Announcements</option>
            <option value="general">General</option>
            <option value="research">Research</option>
            <option value="trades">Trades</option>
          </select>
          {canPost ? (
            <>
              <input value={roomMessage} onChange={(event) => onMessageChange(event.target.value)} placeholder="Professional room message" />
              <button type="button" onClick={onPostMessage} disabled={roomMessage.trim().length < 2}>Post</button>
            </>
          ) : <span>PUBLIC READ-ONLY VIEW</span>}
        </div>
        {error && <div className="network-status investment-settings-status">{error}</div>}
        {messages.length === 0 ? (
          <div className="network-empty">NO TRADING ROOM MESSAGES IN THIS CHANNEL.</div>
        ) : (
          <div className="network-list trading-room-list">
            {messages.map((message) => (
              <div className="network-list-row trading-room-message" key={message.id}>
                <button className="network-profile-link" type="button" onClick={() => onOpenProfile(message.username)} title={`Open ${message.username}'s profile`}>
                  <UserRound size={13} /> @{message.username}
                </button>
                <span>{message.body}</span>
                <em>{message.role.toUpperCase()} / {new Date(message.createdAt).toLocaleString()}</em>
                {canModerate && (
                  <button className="network-icon-danger" type="button" onClick={() => setMessageToDelete(message)} title="Remove abusive message" aria-label={`Delete message from ${message.username}`}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {messageToDelete && (
        <ModerationDialog
          title="Remove Trading Room Message"
          description={`Remove @${messageToDelete.username}'s message from #${messageToDelete.channel}. The reason is retained in the moderation audit.`}
          confirmLabel="Remove Message"
          onCancel={() => { setMessageToDelete(null); setError(""); }}
          onConfirm={confirmDelete}
        />
      )}
    </section>
  );
}

function MembersPanel({
  currentUser,
  group,
  members,
  canManage,
  canModerate,
  onOpenProfile,
  onChanged
}: {
  currentUser: CapabilityUser;
  group: InvestmentGroup;
  members: InvestmentGroupMember[];
  canManage: boolean;
  canModerate: boolean;
  onOpenProfile: (username: string) => void;
  onChanged: (message: string) => void;
}) {
  const [memberToRemove, setMemberToRemove] = useState<InvestmentGroupMember | null>(null);
  const [error, setError] = useState("");
  const currentUserId = userIdFromUsername(currentUser.username);

  const changeRole = (member: InvestmentGroupMember, role: "manager" | "member") => {
    try {
      setInvestmentGroupMemberRole(currentUser, group.id, member.id, role);
      setError("");
      onChanged(role === "manager" ? `@${member.username} is now a group admin.` : `@${member.username} is now a standard member.`);
    } catch (roleError) {
      setError(roleError instanceof Error ? roleError.message : String(roleError));
    }
  };

  const confirmRemoval = (reason: string) => {
    if (!memberToRemove) return;
    try {
      removeInvestmentGroupMember(currentUser, group.id, memberToRemove.id, reason);
      const username = memberToRemove.username;
      setMemberToRemove(null);
      setError("");
      onChanged(`@${username} was removed from the group and the reason was audited.`);
    } catch (moderationError) {
      setError(moderationError instanceof Error ? moderationError.message : String(moderationError));
    }
  };

  return (
    <section className="network-panel">
      <div className="network-panel-title"><Users size={14} /> Members</div>
      {error && <div className="network-status investment-settings-status">{error}</div>}
      <div className="network-list member-management-list">
        {members.map((member) => {
          const canRemoveMember = canModerate && member.role !== "owner" && member.userId !== currentUserId && (canManage || member.role === "member");
          return (
            <div className="network-list-row member-management-row" key={member.id}>
              <button className="network-profile-link" type="button" onClick={() => onOpenProfile(member.username)} title={`Open ${member.username}'s profile`}>
                <UserRound size={13} /> @{member.username}
              </button>
              <span>{member.role.toUpperCase()}</span>
              <em>JOINED {new Date(member.joinedAt).toLocaleDateString()}</em>
              <div className="member-management-actions">
                {canManage && member.role !== "owner" && (
                  <button type="button" onClick={() => changeRole(member, member.role === "manager" ? "member" : "manager")} title={member.role === "manager" ? "Revoke group admin" : "Select as group admin"}>
                    <UserCog size={13} /> {member.role === "manager" ? "Revoke Admin" : "Make Admin"}
                  </button>
                )}
                {canRemoveMember && (
                  <button className="network-danger" type="button" onClick={() => setMemberToRemove(member)}>
                    <UserMinus size={13} /> Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {memberToRemove && (
        <ModerationDialog
          title="Remove Group Member"
          description={`Remove @${memberToRemove.username} from ${group.firmName}. A specific reason is mandatory and will be retained in the moderation audit.`}
          confirmLabel="Remove Member"
          onCancel={() => { setMemberToRemove(null); setError(""); }}
          onConfirm={confirmRemoval}
        />
      )}
    </section>
  );
}

function ModerationDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="network-modal-backdrop moderation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="network-modal moderation-dialog" role="dialog" aria-modal="true" aria-labelledby="moderation-dialog-title">
        <header>
          <strong id="moderation-dialog-title">{title}</strong>
          <button type="button" onClick={onCancel} aria-label="Cancel moderation"><X size={14} /></button>
        </header>
        <div className="moderation-dialog-body">
          <p>{description}</p>
          <label>Moderation Reason<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="State the policy or conduct reason..." /></label>
          <span>{reason.trim().length}/500 · minimum 5 characters</span>
        </div>
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="network-danger" type="button" disabled={reason.trim().length < 5} onClick={() => onConfirm(reason)}><Trash2 size={13} /> {confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}

type GroupSettingsDraft = {
  firmName: string;
  description: string;
  bio: string;
  logoUrl: string;
  bannerUrl: string;
  visibility: InvestmentGroupVisibility;
  accessMode: InvestmentGroupAccessMode;
  password: string;
  tradingStyleTags: string;
  acceptedExchanges: string;
  acceptedWallets: string;
  minimumEquity: string;
  maxFollowers: string;
  approvalRequired: boolean;
  publicSections: InvestmentGroupPublicSection[];
  riskDisclaimer: string;
};

function groupSettingsDraft(group: InvestmentGroup): GroupSettingsDraft {
  return {
    firmName: group.firmName,
    description: group.description,
    bio: group.bio,
    logoUrl: group.logoUrl,
    bannerUrl: group.bannerUrl,
    visibility: group.visibility,
    accessMode: group.accessMode,
    password: "",
    tradingStyleTags: group.tradingStyleTags.join(", "),
    acceptedExchanges: group.acceptedExchanges.join(", "),
    acceptedWallets: group.acceptedWallets.join(", "),
    minimumEquity: group.minimumEquity === undefined ? "" : String(group.minimumEquity),
    maxFollowers: group.maxFollowers === undefined ? "" : String(group.maxFollowers),
    approvalRequired: group.approvalRequired,
    publicSections: group.publicSections ?? [],
    riskDisclaimer: group.riskDisclaimer
  };
}

function GroupSettingsEditor({
  currentUser,
  group,
  onSaved
}: {
  currentUser: CapabilityUser;
  group: InvestmentGroup;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<GroupSettingsDraft>(() => groupSettingsDraft(group));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(groupSettingsDraft(group));
    setError("");
  }, [group.id, group.updatedAt]);

  const save = async () => {
    try {
      setSaving(true);
      setError("");
      if (!draft.firmName.trim()) throw new Error("Firm name is required.");
      if (draft.accessMode === "password_protected" && !group.passwordHash && !draft.password.trim()) {
        throw new Error("Set a group password before enabling password-protected access.");
      }
      updateInvestmentGroup(currentUser, group.id, {
        firmName: draft.firmName.trim(),
        description: draft.description.trim(),
        bio: draft.bio.trim(),
        logoUrl: draft.logoUrl,
        bannerUrl: draft.bannerUrl,
        visibility: draft.visibility,
        accessMode: draft.accessMode,
        ...(draft.password.trim() ? { passwordHash: await hashText(draft.password.trim()) } : {}),
        tradingStyleTags: splitList(draft.tradingStyleTags),
        acceptedExchanges: splitList(draft.acceptedExchanges),
        acceptedWallets: splitList(draft.acceptedWallets),
        minimumEquity: draft.minimumEquity ? Number(draft.minimumEquity) : undefined,
        maxFollowers: draft.maxFollowers ? Number(draft.maxFollowers) : undefined,
        approvalRequired: draft.approvalRequired,
        publicSections: draft.publicSections,
        riskDisclaimer: draft.riskDisclaimer.trim()
      });
      setDraft((current) => ({ ...current, password: "" }));
      onSaved("Investment group settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="network-panel investment-settings-panel">
      <div className="network-panel-title"><SlidersHorizontal size={14} /> Group Settings</div>
      {error && <div className="network-status investment-settings-status">{error}</div>}
      <div className="investment-settings-form">
        <div className="investment-settings-section">
          <strong>Identity</strong>
          <div className="network-form-grid">
            <label>Firm Name<input value={draft.firmName} onChange={(event) => setDraft((current) => ({ ...current, firmName: event.target.value }))} /></label>
            <GroupImagePicker label="Group Picture" value={draft.logoUrl} kind="logo" onChange={(logoUrl) => setDraft((current) => ({ ...current, logoUrl }))} />
            <GroupImagePicker label="Cover Banner" value={draft.bannerUrl} kind="banner" wide onChange={(bannerUrl) => setDraft((current) => ({ ...current, bannerUrl }))} />
            <label className="wide">Short Description<input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
            <label className="wide">Group Bio<textarea value={draft.bio} onChange={(event) => setDraft((current) => ({ ...current, bio: event.target.value }))} /></label>
          </div>
        </div>
        <div className="investment-settings-section">
          <strong>Access And Membership</strong>
          <div className="network-form-grid">
            <label>Visibility<select value={draft.visibility} onChange={(event) => setDraft((current) => ({ ...current, visibility: event.target.value as InvestmentGroupVisibility }))}><option value="public">Public</option><option value="private">Private</option><option value="invite_only">Invite Only</option><option value="password_protected">Password Protected</option></select></label>
            <label>Access Mode<select value={draft.accessMode} onChange={(event) => setDraft((current) => ({ ...current, accessMode: event.target.value as InvestmentGroupAccessMode }))}><option value="open">Open</option><option value="approval_required">Approval Required</option><option value="invite_only">Invite Only</option><option value="password_protected">Password Protected</option></select></label>
            {draft.accessMode === "password_protected" && <label className="wide">{group.passwordHash ? "Replace Group Password" : "Group Password"}<input type="password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} /></label>}
            <label>Minimum Follower Equity<input type="number" min={0} value={draft.minimumEquity} onChange={(event) => setDraft((current) => ({ ...current, minimumEquity: event.target.value }))} /></label>
            <label>Maximum Followers<input type="number" min={1} value={draft.maxFollowers} onChange={(event) => setDraft((current) => ({ ...current, maxFollowers: event.target.value }))} /></label>
            <label className="network-check wide"><input type="checkbox" checked={draft.approvalRequired} onChange={(event) => setDraft((current) => ({ ...current, approvalRequired: event.target.checked }))} /> Approval required</label>
          </div>
        </div>
        <div className="investment-settings-section">
          <strong>Mandate</strong>
          <div className="network-form-grid">
            <label className="wide">Trading Styles<input value={draft.tradingStyleTags} onChange={(event) => setDraft((current) => ({ ...current, tradingStyleTags: event.target.value }))} /></label>
            <label className="wide">Accepted Exchanges<input value={draft.acceptedExchanges} onChange={(event) => setDraft((current) => ({ ...current, acceptedExchanges: event.target.value }))} /></label>
            <label className="wide">Accepted Wallets<input value={draft.acceptedWallets} onChange={(event) => setDraft((current) => ({ ...current, acceptedWallets: event.target.value }))} /></label>
            <label className="wide">Risk Disclaimer<textarea value={draft.riskDisclaimer} onChange={(event) => setDraft((current) => ({ ...current, riskDisclaimer: event.target.value }))} /></label>
          </div>
        </div>
        <div className="investment-settings-section">
          <strong>Public Page Sections</strong>
          <p className="network-muted">Choose which group areas unaffiliated visitors may inspect. Owners, selected group admins, and active members retain complete internal access.</p>
          <div className="investment-public-sections">
            {publicSectionOptions.map(({ section, label }) => (
              <label className="network-check" key={section}>
                <input
                  type="checkbox"
                  checked={draft.publicSections.includes(section)}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    publicSections: event.target.checked
                      ? [...current.publicSections, section]
                      : current.publicSections.filter((item) => item !== section)
                  }))}
                />
                <span><b>{label}</b><em>{eventDisclosureDescription(section)}</em></span>
              </label>
            ))}
          </div>
        </div>
        <div className="investment-settings-actions">
          <button type="button" onClick={save} disabled={saving}><Check size={13} /> {saving ? "Saving" : "Save Changes"}</button>
        </div>
      </div>
    </section>
  );
}

function WizardStep({ step, draft, onChange }: { step: number; draft: typeof defaultDraft; onChange: (draft: typeof defaultDraft) => void }) {
  if (step === 1) {
    return (
      <div className="network-form-grid">
        <label>Firm Name<input value={draft.firmName} onChange={(event) => onChange({ ...draft, firmName: event.target.value })} /></label>
        <GroupImagePicker label="Group Picture" value={draft.logoUrl} kind="logo" onChange={(logoUrl) => onChange({ ...draft, logoUrl })} />
        <GroupImagePicker label="Cover Banner" value={draft.bannerUrl} kind="banner" wide onChange={(bannerUrl) => onChange({ ...draft, bannerUrl })} />
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

function GroupImagePicker({
  label,
  value,
  kind,
  wide = false,
  onChange
}: {
  label: string;
  value: string;
  kind: "logo" | "banner";
  wide?: boolean;
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState("");

  const selectImage = async (file?: File | null) => {
    if (!file) return;
    try {
      setError("");
      onChange(await readGroupImage(file, kind));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to read this image.");
    }
  };

  return (
    <div className={`group-image-picker ${kind}${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <div
        className="group-image-preview"
        style={{ backgroundImage: value ? `url(${value})` : undefined }}
      >
        {!value && <ImagePlus size={kind === "logo" ? 22 : 28} />}
      </div>
      <div className="group-image-actions">
        <label className="group-image-upload">
          <ImagePlus size={13} />
          <span>{value ? "Replace Image" : "Upload Image"}</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              void selectImage(file);
            }}
          />
        </label>
        {value && (
          <button type="button" className="group-image-remove" onClick={() => { setError(""); onChange(""); }}>
            <Trash2 size={12} /> Remove
          </button>
        )}
      </div>
      <small>{error || "PNG, JPG or WebP. Optimized automatically."}</small>
    </div>
  );
}

async function readGroupImage(file: File, kind: "logo" | "banner") {
  const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!acceptedTypes.has(file.type)) {
    throw new Error("Choose a PNG, JPG or WebP image.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Image must be 8 MB or smaller.");
  }

  const image = await loadGroupImage(file);
  const maximumWidth = kind === "logo" ? 512 : 1600;
  const maximumHeight = kind === "logo" ? 512 : 600;
  const scale = Math.min(1, maximumWidth / image.naturalWidth, maximumHeight / image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable in this browser.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const optimized = await canvasBlob(canvas, "image/webp", 0.86);
  const bounded = optimized.size <= 900 * 1024 ? optimized : await canvasBlob(canvas, "image/webp", 0.7);
  if (bounded.size > 1.2 * 1024 * 1024) throw new Error("Image remains too large after optimization.");
  return blobDataUrl(bounded);
}

function loadGroupImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The selected image could not be decoded."));
    };
    image.src = objectUrl;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The selected image could not be optimized.")), type, quality);
  });
}

function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("The selected image could not be read."));
    reader.readAsDataURL(blob);
  });
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

function eventDisclosureDescription(section: InvestmentGroupPublicSection) {
  const descriptions: Record<InvestmentGroupPublicSection, string> = {
    performance: "Verified return and performance disclosures",
    drawdown: "Current and historical drawdown disclosures",
    positions: "Position visibility policy and permitted exposure",
    research: "Published group research and market notes",
    members: "Active member and group-admin directory",
    trading_room: "Read-only public access to Trading Room channels",
    risk: "Risk mandate, score, and group disclaimer"
  };
  return descriptions[section];
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function statPercent(value: number | null) {
  return value === null || value === undefined ? "AWAITING DATA" : `${value.toFixed(2)}%`;
}
