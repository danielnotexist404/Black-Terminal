import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowLeft, BadgeCheck, BarChart3, BookOpen, Check, ChevronRight,
  CircleDollarSign, Cloud, Copy, DoorOpen, Eye, FileText, Landmark, Layers3, Lock, Pause,
  Play, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, SlidersHorizontal, Unplug,
  UserCheck, UserMinus, Users, X
} from "lucide-react";
import type { CapabilityUser } from "../../../core/permissions/capabilities";
import { UnifiedGroupExecutionTicket } from "../../../execution/components/UnifiedGroupExecutionTicket";
import { canCreateInvestmentGroup } from "../../profile/professionalNetworkStore";
import { investmentGroupsApi, makeIdempotencyKey } from "../investmentGroupsApi";
import type {
  CockpitMember,
  CopyTradingConfiguration,
  EligibleGroupConnection,
  ExitPolicy,
  GroupDetailPayload,
  GroupMembership,
  GroupPosition,
  InvestmentGroupCockpit,
  InvestmentGroupSummary,
  InvestmentGroupWorkspace,
  MembershipState,
  ParticipationMethod,
  RiskAcknowledgementKey
} from "../types";

type PrincipalTab = "DISCOVER" | "JOINED GROUPS" | "MY INVESTMENT GROUP";
type DetailTab = "OVERVIEW" | "PERFORMANCE" | "STRATEGY" | "RISK" | "MEMBERS" | "RESEARCH";
type CockpitTab = "MEMBERS" | "POSITIONS" | "ANALYTICS" | "COPY TRADING" | "OBSIDIAN RESEARCH" | "EXECUTION";

type InvestmentGroupsPageProps = {
  currentUser: CapabilityUser;
  onClose: () => void;
  onOpenProfile: (username: string) => void;
  onOpenPositions: () => void;
};

const emptyWorkspace: InvestmentGroupWorkspace = { discover: [], joined: [], managed: [], pending: [] };
const detailTabs: DetailTab[] = ["OVERVIEW", "PERFORMANCE", "STRATEGY", "RISK", "MEMBERS", "RESEARCH"];
const cockpitTabs: CockpitTab[] = ["MEMBERS", "POSITIONS", "ANALYTICS", "COPY TRADING", "OBSIDIAN RESEARCH", "EXECUTION"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

const defaultConfiguration: CopyTradingConfiguration = {
  connectionId: "",
  allocationPercent: 20,
  userMaximumLeverage: 3,
  maximumPositionEquityPercent: 5,
  maximumTotalExposurePercent: 40,
  maximumDailyLossPercent: 3,
  maximumDrawdownPercent: 12,
  allowedSymbols: ["BTCUSDT", "ETHUSDT"],
  allowedMarketTypes: ["PERPETUAL"],
  longEnabled: true,
  shortEnabled: true,
  allowedOrderTypes: ["MARKET", "LIMIT", "CONDITIONAL"],
  marginMode: "CROSS",
  maximumSlippageBps: 50,
  exitPolicy: "DETACH",
  portfolioVisibility: "GROUP_ONLY"
};

export function InvestmentGroupsPage({ currentUser, onClose, onOpenProfile, onOpenPositions }: InvestmentGroupsPageProps) {
  const [workspace, setWorkspace] = useState<InvestmentGroupWorkspace>(emptyWorkspace);
  const [activeTab, setActiveTab] = useState<PrincipalTab>("DISCOVER");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetailPayload | null>(null);
  const [cockpit, setCockpit] = useState<InvestmentGroupCockpit | null>(null);
  const [cockpitGroupId, setCockpitGroupId] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [leaveGroup, setLeaveGroup] = useState<InvestmentGroupSummary | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const canCreate = canCreateInvestmentGroup(currentUser);

  const loadWorkspace = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const payload = await investmentGroupsApi.list();
      setWorkspace(payload);
      setError("");
      if (activeTab === "MY INVESTMENT GROUP" && !cockpitGroupId && payload.managed[0]) setCockpitGroupId(payload.managed[0].id);
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeTab, cockpitGroupId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  useEffect(() => {
    if (!selectedGroupId) { setDetail(null); return; }
    let active = true;
    setLoading(true);
    investmentGroupsApi.detail(selectedGroupId)
      .then((payload) => { if (active) { setDetail(payload); setError(""); } })
      .catch((loadError) => { if (active) setError(messageOf(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedGroupId]);

  const loadCockpit = useCallback(async (silent = false) => {
    if (!cockpitGroupId) return;
    if (!silent) setLoading(true);
    try {
      setCockpit(await investmentGroupsApi.cockpit(cockpitGroupId));
      setError("");
    } catch (loadError) {
      setError(messageOf(loadError));
      setCockpit(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [cockpitGroupId]);

  useEffect(() => {
    if (activeTab !== "MY INVESTMENT GROUP" || !cockpitGroupId) return;
    void loadCockpit();
    const interval = window.setInterval(() => { if (!document.hidden) void loadCockpit(true); }, 5_000);
    return () => window.clearInterval(interval);
  }, [activeTab, cockpitGroupId, loadCockpit]);

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await operation();
      setNotice(success);
      setError("");
      await loadWorkspace(true);
      if (cockpitGroupId) await loadCockpit(true);
    } catch (operationError) {
      setError(messageOf(operationError));
    } finally {
      setBusy(false);
    }
  };

  const principalTabs = useMemo(() => {
    const tabs: PrincipalTab[] = ["DISCOVER", "JOINED GROUPS"];
    if (workspace.managed.length) tabs.push("MY INVESTMENT GROUP");
    return tabs;
  }, [workspace.managed.length]);

  if (selectedGroupId) {
    return (
      <div className="network-page capital-network-page">
        <CapitalHeader onClose={onClose} trailing={<button type="button" onClick={() => setSelectedGroupId(null)}><ArrowLeft size={14} /> Directory</button>} />
        <Feedback notice={notice} error={error} />
        {loading || !detail ? <LoadingState label="LOADING GROUP PROFILE" /> : (
          <GroupDetail
            detail={detail}
            onBack={() => setSelectedGroupId(null)}
            onJoin={() => setJoinOpen(true)}
            onOpenProfile={onOpenProfile}
            onOpenCockpit={() => { setSelectedGroupId(null); setCockpitGroupId(detail.group.id); setActiveTab("MY INVESTMENT GROUP"); }}
          />
        )}
        {joinOpen && detail && (
          <JoinWizard
            detail={detail}
            onClose={() => setJoinOpen(false)}
            onOpenPositions={onOpenPositions}
            onCompleted={async (message) => {
              setJoinOpen(false);
              setNotice(message);
              await loadWorkspace(true);
              setDetail(await investmentGroupsApi.detail(detail.group.id));
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="network-page capital-network-page">
      <CapitalHeader
        onClose={onClose}
        trailing={canCreate ? <button type="button" onClick={() => setCreateOpen(true)}><Plus size={14} /> Create Group</button> : undefined}
      />
      <Feedback notice={notice} error={error} />
      <nav className="capital-principal-tabs" aria-label="Investment Group workspaces">
        {principalTabs.map((tab) => (
          <button type="button" key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
            {tab === "DISCOVER" ? <Search size={14} /> : tab === "JOINED GROUPS" ? <Layers3 size={14} /> : <SlidersHorizontal size={14} />}
            {tab}<span>{tab === "DISCOVER" ? workspace.discover.length : tab === "JOINED GROUPS" ? workspace.joined.length : workspace.managed.length}</span>
          </button>
        ))}
        <button type="button" className="capital-refresh" onClick={() => void loadWorkspace()} aria-label="Refresh groups"><RefreshCw size={14} /></button>
      </nav>

      {loading ? <LoadingState label="LOADING BLACK CAPITAL NETWORK" /> : (
        <main className="capital-workspace">
          {activeTab === "DISCOVER" && (
            <GroupDirectory
              groups={workspace.discover}
              onOpen={setSelectedGroupId}
              onJoin={(group) => { setSelectedGroupId(group.id); setJoinOpen(true); }}
            />
          )}
          {activeTab === "JOINED GROUPS" && (
            <JoinedGroups
              groups={workspace.joined}
              busy={busy}
              onOpen={setSelectedGroupId}
              onPause={(group) => void mutate(() => investmentGroupsApi.pause(group.id), "COPY TRADING PAUSED — FUTURE ENTRIES ARE BLOCKED.")}
              onResume={(group) => void mutate(() => investmentGroupsApi.resume(group.id), "COPY TRADING RESUMED AFTER A FRESH ELIGIBILITY CHECK.")}
              onLeave={setLeaveGroup}
            />
          )}
          {activeTab === "MY INVESTMENT GROUP" && (
            <ManagerWorkspace
              groups={workspace.managed}
              selectedGroupId={cockpitGroupId}
              cockpit={cockpit}
              busy={busy}
              onSelect={setCockpitGroupId}
              onRefresh={() => void loadCockpit()}
              onMutate={mutate}
            />
          )}
        </main>
      )}

      {leaveGroup && <LeaveDialog group={leaveGroup} busy={busy} onClose={() => setLeaveGroup(null)} onLeave={async (policy, confirmed) => {
        setBusy(true);
        try {
          await investmentGroupsApi.leave(leaveGroup.id, policy, confirmed);
          setNotice("FUTURE-ENTRY AUTHORITY REVOKED. PROTECTIVE ORDERS WERE PRESERVED.");
          setLeaveGroup(null);
          await loadWorkspace(true);
        } catch (leaveError) {
          const typed = leaveError as Error & { code?: string; details?: { futureEntryRevoked?: boolean } };
          if (typed.code === "EXIT_CLOSE_PLAN_REQUIRED" && typed.details?.futureEntryRevoked) {
            setNotice("FUTURE ENTRIES WERE REVOKED. ATTRIBUTABLE POSITIONS WERE DETACHED; NO UNSAFE FORCE-CLOSE WAS SENT.");
            setLeaveGroup(null);
            await loadWorkspace(true);
          } else setError(messageOf(leaveError));
        } finally { setBusy(false); }
      }} />}
      {createOpen && <CreateGroupDialog onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); setNotice("INVESTMENT GROUP CREATED ON THE SERVER."); await loadWorkspace(); }} />}
    </div>
  );
}

function CapitalHeader({ onClose, trailing }: { onClose: () => void; trailing?: React.ReactNode }) {
  return (
    <header className="network-head capital-head">
      <div><span>BLACK CAPITAL NETWORK</span><strong>Mandate-controlled Investment Groups and institutional Copy Trading</strong></div>
      <div className="network-head-actions">{trailing}<button type="button" onClick={onClose} aria-label="Close Investment Groups"><X size={14} /></button></div>
    </header>
  );
}

function Feedback({ notice, error }: { notice: string; error: string }) {
  return <>{notice && <div className="capital-feedback success"><Check size={13} />{notice}</div>}{error && <div className="capital-feedback error"><AlertTriangle size={13} />{error}</div>}</>;
}

function LoadingState({ label }: { label: string }) {
  return <div className="capital-state loading"><RefreshCw size={18} /><strong>{label}</strong><span>Server-backed state only. No placeholder balances or members are being generated.</span></div>;
}

function GroupDirectory({ groups, onOpen, onJoin }: { groups: InvestmentGroupSummary[]; onOpen: (id: string) => void; onJoin: (group: InvestmentGroupSummary) => void }) {
  if (!groups.length) return <EmptyState icon={Search} title="NO DISCOVERABLE GROUPS" body="No public Investment Groups are currently published by the server." />;
  return (
    <section className="capital-directory">
      <header><div><span>DISCOVER</span><strong>Verified manager profiles and explicit participation readiness</strong></div><p>Unverified performance remains labelled. Obsidian is never presented as live capital.</p></header>
      <div className="capital-card-grid">{groups.map((group) => <GroupCard key={group.id} group={group} onOpen={() => onOpen(group.id)} onJoin={() => onJoin(group)} />)}</div>
    </section>
  );
}

function GroupCard({ group, onOpen, onJoin }: { group: InvestmentGroupSummary; onOpen: () => void; onJoin: () => void }) {
  const memberState = group.membership?.state;
  const primaryLabel = group.isOwner ? "OWNER — MANAGE GROUP" : memberState === "PENDING_APPROVAL" ? "REQUEST PENDING" : memberState === "ACTIVE" ? "ACTIVE MEMBER" : memberState?.startsWith("PAUSED") ? "PAUSED" : group.accessMode === "invite_only" && !group.validInvite ? "INVITE REQUIRED" : group.copyTradingEnabled ? "JOIN GROUP" : "UNAVAILABLE";
  return (
    <article className="capital-group-card">
      <div className="capital-card-cover" style={group.bannerUrl ? { backgroundImage: `url(${group.bannerUrl})` } : undefined}>
        <div className="capital-card-logo" style={group.logoUrl ? { backgroundImage: `url(${group.logoUrl})` } : undefined}>{!group.logoUrl && initials(group.firmName)}</div>
        <span className={`capital-readiness ${group.copyTradingEnabled ? "ready" : "blocked"}`}>{group.copyTradingEnabled ? "COPY TRADING" : "COPY UNAVAILABLE"}</span>
      </div>
      <div className="capital-card-body">
        <header><div><strong>{group.firmName}</strong><span>{group.ownerVerified && <BadgeCheck size={12} />} @{group.ownerHandle || "profile-unavailable"}</span></div><em>{group.visibility.toUpperCase()}</em></header>
        <p>{group.description || "No public strategy description has been published."}</p>
        <div className="capital-methods"><span><Copy size={12} /> Copy Trading</span><span className="research"><Landmark size={12} /> Obsidian Research</span></div>
        <div className="capital-card-metrics">
          <Metric label="Members" value={String(group.memberCount)} />
          <Metric label="Verified return" value={verifiedPercent(group.performance.totalReturn, group.performance.verified)} />
          <Metric label="Max drawdown" value={verifiedPercent(group.performance.maximumDrawdown, group.performance.verified)} />
          <Metric label="Risk" value={group.riskClassification} />
        </div>
        <div className="capital-provider-row"><span>Providers</span><b>{group.supportedProviders.length ? group.supportedProviders.join(" · ").toUpperCase() : "NONE CERTIFIED"}</b></div>
      </div>
      <footer><button type="button" onClick={onOpen}>View professional page</button><button type="button" className="primary" disabled={primaryLabel !== "JOIN GROUP"} onClick={onJoin}><DoorOpen size={13} />{primaryLabel}</button></footer>
    </article>
  );
}

function JoinedGroups({ groups, busy, onOpen, onPause, onResume, onLeave }: { groups: InvestmentGroupSummary[]; busy: boolean; onOpen: (id: string) => void; onPause: (group: InvestmentGroupSummary) => void; onResume: (group: InvestmentGroupSummary) => void; onLeave: (group: InvestmentGroupSummary) => void }) {
  if (!groups.length) return <EmptyState icon={Layers3} title="NO JOINED GROUPS" body="Completed or pending server-backed memberships will appear here." />;
  return (
    <section className="capital-directory">
      <header><div><span>JOINED GROUPS</span><strong>Your revocable mandates and attributed capital</strong></div><p>Pause and leave never require manager approval.</p></header>
      <div className="joined-group-list">{groups.map((group) => {
        const capital = group.memberCapital;
        const paused = group.membership?.state === "PAUSED_BY_USER";
        const canPause = group.membership?.state === "ACTIVE";
        return (
          <article key={group.id} className="joined-group-card">
            <header><button type="button" onClick={() => onOpen(group.id)}><strong>{group.firmName}</strong><span>{group.membership?.method?.replaceAll("_", " ") || "METHOD NOT SELECTED"}</span></button><StateBadge state={group.membership?.state || "DRAFT"} /></header>
            <div className="joined-capital-grid">
              <Metric label="Allocation" value={valueOrUnavailable(capital?.allocationPercent, "%")} />
              <Metric label="Allocated equity" value={currencyOrUnavailable(capital?.allocatedEquity)} />
              <PnlMetric label="Realized PnL" value={capital?.realizedPnl} />
              <PnlMetric label="Unrealized PnL" value={capital?.unrealizedPnl} />
              <PnlMetric label="Net PnL" value={capital?.netPnl} />
              <Metric label="Drawdown" value={valueOrUnavailable(capital?.drawdownPercent, "%")} />
              <Metric label="Open positions" value={capital?.activePositions == null ? "UNAVAILABLE" : String(capital.activePositions)} />
              <Metric label="Execution" value={capital?.executionMode === "CLOUD_DELEGATED" ? "PERSISTENT" : capital?.executionMode || "UNAVAILABLE"} />
            </div>
            <footer><span className={`freshness ${String(capital?.freshness || "STALE").toLowerCase()}`}>{capital?.freshness || "STALE"} DATA</span><div><button type="button" disabled={busy || (!canPause && !paused)} onClick={() => paused ? onResume(group) : onPause(group)}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? "Resume" : "Pause"}</button><button type="button" className="danger" disabled={busy} onClick={() => onLeave(group)}><DoorOpen size={13} />Leave</button></div></footer>
          </article>
        );
      })}</div>
    </section>
  );
}

function GroupDetail({ detail, onBack, onJoin, onOpenProfile, onOpenCockpit }: { detail: GroupDetailPayload; onBack: () => void; onJoin: () => void; onOpenProfile: (handle: string) => void; onOpenCockpit: () => void }) {
  const [tab, setTab] = useState<DetailTab>("OVERVIEW");
  const group = detail.group;
  const membership = group.membership;
  const action = group.isOwner || ["owner", "manager"].includes(membership?.role || "") ? "OWNER — MANAGE GROUP" : membership?.state === "PENDING_APPROVAL" ? "REQUEST PENDING" : membership?.state === "ACTIVE" ? "ACTIVE MEMBER" : membership?.state?.startsWith("PAUSED") ? "PAUSED" : !detail.capacity.available ? "UNAVAILABLE" : group.accessMode === "invite_only" && !group.validInvite ? "INVITE REQUIRED" : "JOIN GROUP";
  return (
    <main className="capital-detail-page">
      <button type="button" className="capital-back" onClick={onBack}><ArrowLeft size={13} /> Back to groups</button>
      <section className="capital-detail-hero" style={group.bannerUrl ? { backgroundImage: `linear-gradient(90deg, rgba(4,5,6,.96), rgba(4,5,6,.7)), url(${group.bannerUrl})` } : undefined}>
        <div className="capital-detail-logo" style={group.logoUrl ? { backgroundImage: `url(${group.logoUrl})` } : undefined}>{!group.logoUrl && initials(group.firmName)}</div>
        <div className="capital-detail-identity"><span>INVESTMENT GROUP</span><h1>{group.firmName}</h1><button type="button" disabled={!detail.owner?.handle} onClick={() => detail.owner?.handle && onOpenProfile(detail.owner.handle)}>{group.ownerVerified && <BadgeCheck size={13} />} Managed by @{detail.owner?.handle || "profile-unavailable"}</button><p>{group.bio || group.description || "No manager biography has been published."}</p></div>
        <div className="capital-detail-actions"><StateBadge state={group.emergencyStop ? "RISK_SUSPENDED" : group.status.toUpperCase() as MembershipState} /><button type="button" className="primary" disabled={!action.includes("JOIN") && !action.includes("MANAGE")} onClick={action.includes("MANAGE") ? onOpenCockpit : onJoin}>{action}</button></div>
      </section>
      <div className="capital-profile-strip">
        <Metric label="Active capital" value={verifiedCurrency(group.performance.connectedEquity, group.performance.verified)} />
        <Metric label="Members" value={String(detail.capacity.current)} />
        <Metric label="Current drawdown" value={verifiedPercent(group.performance.currentDrawdown, group.performance.verified)} />
        <Metric label="Maximum drawdown" value={verifiedPercent(group.performance.maximumDrawdown, group.performance.verified)} />
        <Metric label="Return" value={verifiedPercent(group.performance.totalReturn, group.performance.verified)} />
        <Metric label="Risk class" value={group.riskClassification} />
      </div>
      <nav className="capital-detail-tabs">{detailTabs.map((item) => <button type="button" className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item}</button>)}</nav>
      <section className="capital-detail-body">
        {tab === "OVERVIEW" && <InfoGrid items={[["Identity", group.firmName], ["Owner", detail.owner?.displayName || "UNAVAILABLE"], ["Group status", group.status.toUpperCase()], ["Join availability", detail.capacity.available ? "AVAILABLE" : "CAPACITY REACHED"], ["Participation", "COPY TRADING + OBSIDIAN RESEARCH PREVIEW"], ["Providers", group.supportedProviders.join(", ").toUpperCase() || "NONE"]]} />}
        {tab === "PERFORMANCE" && <PerformancePanel group={group} />}
        {tab === "STRATEGY" && <TextPanels panels={[["STRATEGY SUMMARY", group.strategySummary], ["METHODOLOGY", group.methodologySummary], ["TRADING STYLES", group.tradingStyleTags.join(" · ")]]} />}
        {tab === "RISK" && <TextPanels panels={[["RISK CLASSIFICATION", group.riskClassification], ["MAXIMUM GROUP LEVERAGE", `${group.groupMaximumLeverage}x — member caps always take precedence`], ["MANDATE BOUNDARY", "Read and trade only. Withdrawal, transfer and arbitrary-call authority are prohibited."], ["PERSISTENCE", detail.eligibility.certifiedPersistentWorker ? "Certified Black Cloud worker detected" : "NOT OPERATIONAL — NO CERTIFIED PERSISTENT WORKER"]]} />}
        {tab === "MEMBERS" && <InfoGrid items={[["Member count", String(detail.capacity.current)], ["Capacity", detail.capacity.maximum == null ? "NO PUBLISHED LIMIT" : String(detail.capacity.maximum)], ["Directory privacy", "MEMBER ACCOUNT DATA IS NOT PUBLIC"], ["Manager access", "GROUP-ORIGINATED DATA + EXPLICITLY CONSENTED RISK DATA"]]} />}
        {tab === "RESEARCH" && <TextPanels panels={[["OBSIDIAN VAULT", "RESEARCH PREVIEW — future protocol research only. No deposits, staking, lock commitments, vault addresses or redemption promises."], ["PERFORMANCE SOURCE", group.performanceSource || "NO VERIFIED SOURCE PUBLISHED"], ["LEGAL STATUS", "Final public risk wording requires qualified legal review before broad launch."]]} />}
      </section>
    </main>
  );
}

function PerformancePanel({ group }: { group: InvestmentGroupSummary }) {
  if (!group.performance.verified) return <EmptyState icon={BarChart3} title="PERFORMANCE UNVERIFIED" body="No verified performance is presented as fact. Connect a verified server-side source before publishing metrics." />;
  return <InfoGrid items={[["Verified period", group.performancePeriodStart && group.performancePeriodEnd ? `${date(group.performancePeriodStart)} — ${date(group.performancePeriodEnd)}` : "PERIOD NOT PUBLISHED"], ["Source", group.performanceSource || "SOURCE NOT PUBLISHED"], ["Monthly return", percent(group.performance.monthlyReturn)], ["Yearly return", percent(group.performance.yearlyReturn)], ["Total return", percent(group.performance.totalReturn)], ["Maximum drawdown", percent(group.performance.maximumDrawdown)]]} />;
}

function JoinWizard({ detail, onClose, onOpenPositions, onCompleted }: { detail: GroupDetailPayload; onClose: () => void; onOpenPositions: () => void; onCompleted: (message: string) => Promise<void> }) {
  const initialDraft = detail.joinDraft;
  const initialStep = detail.riskAcknowledged ? (initialDraft?.currentStep === "REVIEW" ? 4 : initialDraft?.currentStep === "CONFIGURING" ? 3 : 2) : 1;
  const [step, setStep] = useState(initialStep);
  const [method, setMethod] = useState<ParticipationMethod>(initialDraft?.participationMethod || "COPY_TRADING");
  const [configuration, setConfiguration] = useState<CopyTradingConfiguration>({
    ...defaultConfiguration,
    ...(initialDraft?.configuration || {}),
    connectionId: initialDraft?.configuration?.connectionId || detail.eligibleConnections.find((item) => item.eligible)?.id || ""
  });
  const [acknowledgements, setAcknowledgements] = useState<Record<RiskAcknowledgementKey, boolean>>(() => Object.fromEntries((detail.riskDocument?.acknowledgementKeys || []).map((key) => [key, false])) as Record<RiskAcknowledgementKey, boolean>);
  const [reachedEnd, setReachedEnd] = useState(detail.riskAcknowledged);
  const [finalConsent, setFinalConsent] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activation, setActivation] = useState<"ACTIVE" | "PENDING" | null>(null);
  const idempotencyKey = useRef(makeIdempotencyKey("join"));
  const disclosureRef = useCallback((node: HTMLDivElement | null) => { if (node && node.scrollHeight <= node.clientHeight + 4) setReachedEnd(true); }, []);
  const selectedConnection = detail.eligibleConnections.find((item) => item.id === configuration.connectionId);
  const allChecked = detail.riskDocument?.acknowledgementKeys.every((key) => acknowledgements[key]) === true;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); } catch (operationError) { setError(messageOf(operationError)); } finally { setBusy(false); }
  };

  const continueRisk = () => run(async () => {
    const document = detail.riskDocument;
    if (!document) throw new Error("The server has no active risk disclosure.");
    if (!detail.riskAcknowledged) await investmentGroupsApi.acknowledgeRisk(detail.group.id, { version: document.version, documentHash: document.documentHash, locale: document.locale, reachedEnd, acknowledgements, applicationVersion: "black-terminal-preview" });
    setStep(2);
  });

  const continueMethod = () => run(async () => {
    if (method !== "COPY_TRADING") throw new Error("Obsidian remains research-only and cannot activate membership.");
    await investmentGroupsApi.saveDraft(detail.group.id, { participationMethod: method, currentStep: "METHOD_SELECTED" });
    setStep(3);
  });

  const continueConfiguration = () => run(async () => {
    if (!selectedConnection?.eligible) throw new Error("Select an eligible, reconciled persistent broker connection.");
    await investmentGroupsApi.saveDraft(detail.group.id, { participationMethod: method, currentStep: "REVIEW", configuration });
    setStep(4);
  });

  const submit = () => run(async () => {
    if (!finalConsent) throw new Error("Explicit final consent is required.");
    const passwordHash = detail.group.accessMode === "password_protected" ? await hashText(password) : undefined;
    const result = await investmentGroupsApi.join(detail.group.id, { participationMethod: "COPY_TRADING", connectionId: configuration.connectionId, riskPolicy: configuration, finalConsent: true, idempotencyKey: idempotencyKey.current, passwordHash });
    setActivation(result.pendingApproval ? "PENDING" : "ACTIVE");
    setStep(5);
  });

  return (
    <div className="network-modal-backdrop capital-modal-backdrop">
      <section className="capital-join-wizard" role="dialog" aria-modal="true" aria-label="Join Investment Group">
        <header><div><span>JOIN GROUP</span><strong>{detail.group.firmName}</strong></div><button type="button" onClick={onClose}><X size={14} /></button></header>
        <div className="capital-stepper">{["RISK", "METHOD", "CONFIGURE", "REVIEW", "ACTIVATION"].map((label, index) => <span key={label} className={step === index + 1 ? "active" : step > index + 1 ? "done" : ""}><b>{step > index + 1 ? <Check size={12} /> : index + 1}</b>{label}</span>)}</div>
        {error && <div className="capital-feedback error"><AlertTriangle size={13} />{error}</div>}
        <div className="capital-wizard-body">
          {step === 1 && detail.riskDocument && (
            <section className="risk-document-step">
              <div className="risk-document" ref={disclosureRef} onScroll={(event) => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 8) setReachedEnd(true); }}>
                <span>VERSION {detail.riskDocument.version} · HASH {detail.riskDocument.documentHash.slice(0, 12)}…</span>
                <h2>{detail.riskDocument.title}</h2>
                {detail.riskDocument.text.split("\n\n").map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              </div>
              <div className="risk-checklist">{detail.riskDocument.acknowledgementKeys.map((key) => <label key={key}><input type="checkbox" checked={acknowledgements[key]} onChange={(event) => setAcknowledgements((current) => ({ ...current, [key]: event.target.checked }))} /><span>{riskAcknowledgementLabel(key)}</span></label>)}</div>
              {!reachedEnd && <p className="wizard-hint"><FileText size={13} /> Reach the end of the disclosure to continue.</p>}
            </section>
          )}
          {step === 2 && (
            <section className="method-selection">
              <button type="button" className={method === "COPY_TRADING" ? "selected" : ""} onClick={() => setMethod("COPY_TRADING")}><Copy size={22} /><span>OPERATIONAL METHOD</span><strong>Copy Trading</strong><p>Authorize permitted trades through a revocable, withdrawal-prohibited mandate on an independent broker account.</p><ul><li>Persistent Black Cloud required</li><li>Read + trade only</li><li>Pause or leave at any time</li></ul></button>
              <article className="obsidian-method"><Landmark size={22} /><span>RESEARCH PREVIEW</span><strong>Obsidian Vault</strong><p>Future zero-trust smart-contract vault research. Future protocols may include lock or redemption terms.</p><ul><li>No deposits or staking</li><li>No vault address generation</li><li>No instant-redemption promise</li></ul><button type="button" onClick={() => run(async () => { await investmentGroupsApi.joinObsidianWaitlist(detail.group.id); setError("Research waitlist joined. No financial product or deposit was activated."); })}>Join research waitlist</button></article>
            </section>
          )}
          {step === 3 && <CopyConfiguration detail={detail} value={configuration} onChange={setConfiguration} onOpenPositions={onOpenPositions} />}
          {step === 4 && (
            <section className="consent-review">
              <h2>Copy-Trading Consent Summary</h2>
              <InfoGrid items={[["Group", detail.group.firmName], ["Participation method", "COPY TRADING"], ["Broker", selectedConnection ? `${selectedConnection.provider.toUpperCase()} · ${selectedConnection.label}` : "NOT SELECTED"], ["Allocation", `${configuration.allocationPercent}% of follower equity`], ["Maximum leverage", `${configuration.userMaximumLeverage}x`], ["Effective cap", `${Math.min(configuration.userMaximumLeverage, detail.group.groupMaximumLeverage, selectedConnection?.emsRiskCap || Infinity, selectedConnection?.exchangeLeverageCap || Infinity)}x`], ["Daily loss", `${configuration.maximumDailyLossPercent}%`], ["Drawdown", `${configuration.maximumDrawdownPercent}%`], ["Symbols", configuration.allowedSymbols.join(", ")], ["Order types", configuration.allowedOrderTypes.join(", ")], ["Margin", configuration.marginMode], ["Slippage", `${configuration.maximumSlippageBps} bps`], ["Exit policy", configuration.exitPolicy], ["Portfolio visibility", configuration.portfolioVisibility.replaceAll("_", " ")], ["Persistence after logout", "YES — CERTIFIED BLACK CLOUD ONLY"], ["Withdrawal authority", "NEVER"]]} />
              {detail.group.accessMode === "password_protected" && <label className="capital-field"><span>Group password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
              <label className="capital-final-consent"><input type="checkbox" checked={finalConsent} onChange={(event) => setFinalConsent(event.target.checked)} /><span>I explicitly authorize this bounded Copy-Trading mandate. I understand it may continue after logout, and I can pause or leave at any time.</span></label>
            </section>
          )}
          {step === 5 && <section className="activation-result">{activation === "ACTIVE" ? <><ShieldCheck size={34} /><span>ACTIVE</span><h2>Copy Trading activated</h2><p>The signed mandate passed broker, worker and reconciliation checks. Withdrawal authority remains NONE.</p></> : <><UserCheck size={34} /><span>PENDING APPROVAL</span><h2>Application submitted</h2><p>Your signed mandate remains inactive for new entries until manager approval and a fresh activation check.</p></>}</section>}
        </div>
        <footer>
          <button type="button" onClick={step === 1 || step === 5 ? onClose : () => setStep((current) => current - 1)}>{step === 5 ? "Close" : "Back"}</button>
          {step === 1 && <button type="button" className="primary" disabled={busy || !reachedEnd || !allChecked} onClick={continueRisk}>Accept & Continue</button>}
          {step === 2 && <button type="button" className="primary" disabled={busy || method !== "COPY_TRADING"} onClick={continueMethod}>Configure Copy Trading</button>}
          {step === 3 && <button type="button" className="primary" disabled={busy || !selectedConnection?.eligible} onClick={continueConfiguration}>Review consent</button>}
          {step === 4 && <button type="button" className="primary" disabled={busy || !finalConsent} onClick={submit}>{busy ? "Submitting…" : "Submit signed mandate"}</button>}
          {step === 5 && <button type="button" className="primary" onClick={() => void onCompleted(activation === "ACTIVE" ? "COPY TRADING MEMBERSHIP ACTIVATED." : "COPY TRADING APPLICATION SUBMITTED FOR APPROVAL.")}>Open Joined Groups</button>}
        </footer>
      </section>
    </div>
  );
}

function CopyConfiguration({ detail, value, onChange, onOpenPositions }: { detail: GroupDetailPayload; value: CopyTradingConfiguration; onChange: (value: CopyTradingConfiguration) => void; onOpenPositions: () => void }) {
  const connection = detail.eligibleConnections.find((item) => item.id === value.connectionId);
  const numberField = (key: keyof CopyTradingConfiguration, next: string) => onChange({ ...value, [key]: Number(next) });
  const listField = (key: "allowedSymbols" | "allowedMarketTypes" | "allowedOrderTypes", next: string) => onChange({ ...value, [key]: next.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) });
  return (
    <section className="copy-configuration">
      <div className="eligibility-banner"><Cloud size={17} /><div><strong>{detail.eligibility.copyTradingOperational ? "PERSISTENT COPY TRADING READY" : "COPY TRADING NOT READY"}</strong><span>{detail.eligibility.reason || "At least one certified connection passed all server-side checks."}</span></div><button type="button" onClick={onOpenPositions}>Positions → Connection Manager</button></div>
      <div className="connection-cards">{detail.eligibleConnections.length ? detail.eligibleConnections.map((item) => <ConnectionCard key={item.id} connection={item} selected={value.connectionId === item.id} onSelect={() => item.eligible && onChange({ ...value, connectionId: item.id })} />) : <EmptyState icon={Unplug} title="NO BROKER CONNECTIONS" body="Create and certify a trade-only connection in Positions. Credentials are never collected here." />}</div>
      <div className="capital-form-grid">
        <NumericField label="Equity allocation" value={value.allocationPercent} suffix="%" min={0.01} max={100} onChange={(next) => numberField("allocationPercent", next)} />
        <NumericField label="Maximum leverage" value={value.userMaximumLeverage} suffix="x" min={1} max={Math.min(125, detail.group.groupMaximumLeverage)} onChange={(next) => numberField("userMaximumLeverage", next)} />
        <NumericField label="Max position equity" value={value.maximumPositionEquityPercent} suffix="%" min={0.01} max={100} onChange={(next) => numberField("maximumPositionEquityPercent", next)} />
        <NumericField label="Max total exposure" value={value.maximumTotalExposurePercent} suffix="%" min={0.01} max={500} onChange={(next) => numberField("maximumTotalExposurePercent", next)} />
        <NumericField label="Max daily loss" value={value.maximumDailyLossPercent} suffix="%" min={0.01} max={100} onChange={(next) => numberField("maximumDailyLossPercent", next)} />
        <NumericField label="Max group drawdown" value={value.maximumDrawdownPercent} suffix="%" min={0.01} max={100} onChange={(next) => numberField("maximumDrawdownPercent", next)} />
        <NumericField label="Maximum slippage" value={value.maximumSlippageBps} suffix="bps" min={0} max={10000} onChange={(next) => numberField("maximumSlippageBps", next)} />
        <label className="capital-field"><span>Margin mode</span><select value={value.marginMode} onChange={(event) => onChange({ ...value, marginMode: event.target.value as "CROSS" | "ISOLATED" })}><option value="CROSS">Cross</option><option value="ISOLATED">Isolated</option></select></label>
        <label className="capital-field wide"><span>Allowed symbols</span><input value={value.allowedSymbols.join(", ")} onChange={(event) => listField("allowedSymbols", event.target.value)} /></label>
        <label className="capital-field"><span>Market types</span><input value={value.allowedMarketTypes.join(", ")} onChange={(event) => listField("allowedMarketTypes", event.target.value)} /></label>
        <label className="capital-field"><span>Order types</span><input value={value.allowedOrderTypes.join(", ")} onChange={(event) => listField("allowedOrderTypes", event.target.value)} /></label>
        <label className="capital-field"><span>Exit policy</span><select value={value.exitPolicy} onChange={(event) => onChange({ ...value, exitPolicy: event.target.value as ExitPolicy })}><option value="DETACH">Detach and manage myself</option><option value="CLOSE_NOW">Close attributable positions now</option><option value="WHEN_FLAT">Leave when positions are flat</option></select></label>
        <label className="capital-field"><span>Portfolio visibility</span><select value={value.portfolioVisibility} onChange={(event) => onChange({ ...value, portfolioVisibility: event.target.value as CopyTradingConfiguration["portfolioVisibility"] })}><option value="GROUP_ONLY">Group-originated data only</option><option value="GROUP_AND_RISK_SUMMARY">Group data + risk summary</option><option value="FULL_SELECTED_ACCOUNT">Full selected account</option></select></label>
        <div className="direction-controls"><span>Directions</span><label><input type="checkbox" checked={value.longEnabled} onChange={(event) => onChange({ ...value, longEnabled: event.target.checked })} /> Long</label><label><input type="checkbox" checked={value.shortEnabled} onChange={(event) => onChange({ ...value, shortEnabled: event.target.checked })} /> Short</label></div>
      </div>
      {connection && <div className="effective-leverage"><span>Group requested (initial)</span><b>{Math.min(value.userMaximumLeverage, detail.group.groupMaximumLeverage)}x</b><span>User maximum</span><b>{value.userMaximumLeverage}x</b><span>Effective</span><strong>{Math.min(value.userMaximumLeverage, detail.group.groupMaximumLeverage, connection.emsRiskCap, connection.exchangeLeverageCap)}x</strong></div>}
    </section>
  );
}

function ConnectionCard({ connection, selected, onSelect }: { connection: EligibleGroupConnection; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={`connection-card ${selected ? "selected" : ""} ${connection.eligible ? "eligible" : "blocked"}`} onClick={onSelect} disabled={!connection.eligible}><div><Cloud size={15} /><strong>{connection.label}</strong><span>{connection.provider.toUpperCase()} · {connection.executionEnvironment}</span></div><em>{connection.eligible ? "ELIGIBLE" : "BLOCKED"}</em><p>{connection.eligible ? `${money.format(connection.equity)} synchronized equity · withdrawal authority NONE` : connection.blockers.join(" · ").replaceAll("_", " ")}</p></button>;
}

function ManagerWorkspace({ groups, selectedGroupId, cockpit, busy, onSelect, onRefresh, onMutate }: { groups: InvestmentGroupSummary[]; selectedGroupId: string | null; cockpit: InvestmentGroupCockpit | null; busy: boolean; onSelect: (id: string) => void; onRefresh: () => void; onMutate: (operation: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [tab, setTab] = useState<CockpitTab>("MEMBERS");
  const [selectedMember, setSelectedMember] = useState<CockpitMember | null>(null);
  const [executionTicketOpen, setExecutionTicketOpen] = useState(false);
  const [executionNotice, setExecutionNotice] = useState("");
  if (!groups.length) return <EmptyState icon={SlidersHorizontal} title="NO MANAGED GROUP" body="This cockpit is visible only to authorized owners and managers." />;
  return (
    <section className="manager-workspace">
      <header className="manager-selector"><div><span>MY INVESTMENT GROUP</span><strong>Institutional group-manager cockpit</strong></div><select value={selectedGroupId || ""} onChange={(event) => onSelect(event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.firmName}</option>)}</select><button type="button" onClick={onRefresh}><RefreshCw size={13} /> Refresh</button></header>
      {!cockpit ? <LoadingState label="LOADING AUTHORIZED COCKPIT" /> : <>
        <div className="cockpit-status-bar"><div><span>GROUP STATUS</span><strong>{cockpit.health.status.replaceAll("_", " ")}</strong></div><div><span>BLACK CLOUD</span><strong>{cockpit.health.degradedMembers ? `${cockpit.health.degradedMembers} DEGRADED` : cockpit.health.activeMembers ? "HEALTHY" : "NO ACTIVE MEMBERS"}</strong></div><div><span>NEW TRADE</span><strong>{cockpit.health.canExecuteNewTrade ? "SAFE TO OPEN TICKET" : "BLOCKED"}</strong></div><button type="button" className="danger" disabled={busy || cockpit.group.emergencyStop} onClick={() => { const reason = window.prompt("Emergency-stop reason (positions will not be closed automatically):", "Risk officer initiated group-wide pause."); if (reason && window.confirm("Stop all new group entries? Existing broker-native protective orders remain active.")) void onMutate(() => investmentGroupsApi.emergencyStop(cockpit.group.id, reason), "GROUP EMERGENCY STOP ACTIVATED. EXISTING POSITIONS WERE NOT FORCE-CLOSED."); }}><ShieldAlert size={14} /> Emergency stop</button></div>
        <div className="cockpit-metrics"><Metric label="Connected equity" value={compactMoney.format(cockpit.aggregate.connectedEquity)} /><Metric label="Allocated equity" value={compactMoney.format(cockpit.aggregate.allocatedEquity)} /><Metric label="Active members" value={String(cockpit.aggregate.activeMembers)} /><PnlMetric label="Net PnL" value={cockpit.aggregate.netPnl} /><Metric label="Gross exposure" value={compactMoney.format(cockpit.aggregate.grossExposure)} /><Metric label="Net exposure" value={compactMoney.format(cockpit.aggregate.netExposure)} /><Metric label="Weighted leverage" value={`${cockpit.aggregate.weightedLeverage.toFixed(2)}x`} /><Metric label="Data health" value={cockpit.aggregate.degradedMembers ? `${cockpit.aggregate.degradedMembers} DEGRADED` : "LIVE"} /></div>
        <nav className="cockpit-tabs">{cockpitTabs.map((item) => <button type="button" key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
        <div className="cockpit-body">
          {tab === "MEMBERS" && <MembersTable members={cockpit.members} onSelect={setSelectedMember} />}
          {tab === "POSITIONS" && <PositionsTable positions={cockpit.positions} />}
          {tab === "ANALYTICS" && <AnalyticsPanel cockpit={cockpit} />}
          {tab === "COPY TRADING" && <CopyTradingPanel cockpit={cockpit} />}
          {tab === "OBSIDIAN RESEARCH" && <ObsidianPanel />}
          {tab === "EXECUTION" && <ExecutionPanel cockpit={cockpit} notice={executionNotice} onOpenTicket={() => setExecutionTicketOpen(true)} />}
        </div>
        {selectedMember && <MemberDrawer groupId={cockpit.group.id} groupMaximumLeverage={cockpit.group.groupMaximumLeverage} member={selectedMember} busy={busy} onClose={() => setSelectedMember(null)} onMutate={async (operation, success) => { await onMutate(operation, success); setSelectedMember(null); }} />}
        {executionTicketOpen && <UnifiedGroupExecutionTicket groupId={cockpit.group.id} groupName={cockpit.group.firmName} groupMaximumLeverage={cockpit.group.groupMaximumLeverage} onClose={() => setExecutionTicketOpen(false)} onSubmitted={(message) => { setExecutionNotice(message); onRefresh(); }} />}
      </>}
    </section>
  );
}

function MembersTable({ members, onSelect }: { members: CockpitMember[]; onSelect: (member: CockpitMember) => void }) {
  const operational = members.filter((member) => member.role === "member");
  if (!operational.length) return <EmptyState icon={Users} title="NO MEMBERS" body="No pending or active member records were returned by the server." />;
  return <div className="capital-table members-table"><div className="capital-table-head"><span>MEMBER</span><span>STATUS</span><span>EQUITY</span><span>ALLOCATED</span><span>PNL</span><span>LEVERAGE</span><span>HEALTH</span><span></span></div>{operational.map((member) => <button type="button" className="capital-table-row" key={member.id} onClick={() => onSelect(member)}><span><strong>{member.profile?.displayName || member.profile?.handle || "PROFILE UNAVAILABLE"}</strong><em>@{member.profile?.handle || member.userId.slice(0, 8)}</em></span><StateBadge state={member.state} /><span>{currencyOrUnavailable(member.portfolio?.equity)}</span><span>{currencyOrUnavailable(member.portfolio?.allocatedEquity)}</span><PnlValue value={member.portfolio?.netPnl} /><span>{member.riskPolicy ? `${member.riskPolicy.managerRequestedLeverage}x / ${member.riskPolicy.effectiveLeverage}x` : "UNAVAILABLE"}</span><span className={`freshness ${String(member.portfolio?.freshness || "STALE").toLowerCase()}`}>{member.portfolio?.freshness || "STALE"}</span><ChevronRight size={14} /></button>)}</div>;
}

function PositionsTable({ positions }: { positions: GroupPosition[] }) {
  if (!positions.length) return <EmptyState icon={BarChart3} title="NO OPEN POSITIONS" body="No group-attributed PositionManager records exist. Account-wide unrelated positions are not shown." />;
  return <div className="capital-table positions-table"><div className="capital-table-head"><span>SYMBOL</span><span>SIDE</span><span>SIZE</span><span>ENTRY</span><span>MARK</span><span>LEVERAGE</span><span>UNREALIZED</span><span>NET PNL</span><span>STATE</span><span>UPDATED</span></div>{positions.map((position) => <div className="capital-table-row" key={position.id}><strong>{position.symbol}</strong><span className={position.direction === "LONG" ? "positive" : "negative"}>{position.direction}</span><span>{position.quantity}</span><span>{position.averagePrice}</span><span>{position.markPrice}</span><span>{position.leverage}x</span><PnlValue value={position.unrealizedPnl} /><PnlValue value={position.netPnl} /><span>{position.state}</span><span>{time(position.updatedAt)}</span></div>)}</div>;
}

function AnalyticsPanel({ cockpit }: { cockpit: InvestmentGroupCockpit }) {
  const analytics = cockpit.analytics;
  return <section className="analytics-grid"><article><span>GROSS PNL</span><PnlValue value={analytics.aggregate.grossPnl} /><small>{analytics.formulas.grossPnl}</small></article><article><span>NET PNL</span><PnlValue value={analytics.aggregate.netPnl} /><small>{analytics.formulas.netPnl}</small></article><article><span>FEES + FUNDING</span><strong>{money.format(analytics.aggregate.fees + analytics.aggregate.funding)}</strong><small>Deducted from gross PnL</small></article><article><span>GROSS / NET EXPOSURE</span><strong>{compactMoney.format(analytics.aggregate.grossExposure)} / {compactMoney.format(analytics.aggregate.netExposure)}</strong><small>{analytics.formulas.netExposure}</small></article><Distribution label="Allocation distribution" value={analytics.allocationDistribution} suffix="%" /><Distribution label="Effective leverage" value={analytics.leverageDistribution} suffix="x" /><Distribution label="Drawdown" value={analytics.drawdownDistribution} suffix="%" /><article><span>DATA FRESHNESS</span><strong>{analytics.aggregate.degradedMembers ? `${analytics.aggregate.degradedMembers} DEGRADED` : "LIVE"}</strong><small>{dateTime(analytics.aggregate.sampledAt)}</small></article></section>;
}

function CopyTradingPanel({ cockpit }: { cockpit: InvestmentGroupCockpit }) {
  if (!cockpit.copyTrading.members.length) return <EmptyState icon={Copy} title="NO ACTIVE COPY TRADERS" body="No Copy-Trading members are pending, active or paused." />;
  return <section className="copy-member-grid">{cockpit.copyTrading.members.map((member) => <article key={member.id}><header><strong>{member.profile?.displayName || member.profile?.handle || "Member"}</strong><StateBadge state={member.state} /></header><InfoGrid items={[["Allocation", valueOrUnavailable(member.riskPolicy?.allocationPercent, "%")], ["User leverage cap", valueOrUnavailable(member.riskPolicy?.userMaximumLeverage, "x")], ["Manager requested", valueOrUnavailable(member.riskPolicy?.managerRequestedLeverage, "x")], ["Effective leverage", valueOrUnavailable(member.riskPolicy?.effectiveLeverage, "x")], ["Connection", member.connection?.executionReadiness || "UNAVAILABLE"], ["Withdrawal authority", "NONE"]]} /></article>)}</section>;
}

function ObsidianPanel() {
  return <section className="obsidian-research-panel"><Landmark size={28} /><span>RESEARCH PREVIEW</span><h2>Obsidian Vault is not operational</h2><p>This section is intentionally isolated from live Copy-Trading capital. It does not accept deposits, issue shares, generate vault addresses, promise instant redemption or claim audited custody.</p><div><b>Deposits</b><strong>DISABLED</strong><b>Vault addresses</b><strong>NOT GENERATED</strong><b>Capital totals</b><strong>EXCLUDED</strong><b>Lock / redemption terms</b><strong>FUTURE RESEARCH</strong></div></section>;
}

function ExecutionPanel({ cockpit, notice, onOpenTicket }: { cockpit: InvestmentGroupCockpit; notice: string; onOpenTicket: () => void }) {
  const quality = cockpit.executionQuality;
  return <section className="execution-panel"><div className="execution-flow"><span>UNIFIED EXECUTION TICKET</span><ChevronRight /><span>GROUP TRADE INTENT</span><ChevronRight /><span>OMS / EMS</span><ChevronRight /><span>FOLLOWER PLANS</span><ChevronRight /><span>BLACK CLOUD</span></div><InfoGrid items={[["Total follower plans", String(quality.totalPlans)], ["Succeeded / working", String(quality.succeeded)], ["Rejected", String(quality.rejected)], ["Pending", String(quality.pending)], ["Divergence", String(quality.divergenceCount)], ["Average slippage", quality.averageSlippageBps == null ? "UNAVAILABLE" : `${quality.averageSlippageBps.toFixed(2)} bps`], ["Execution source", quality.source], ["Browser fan-out", "PROHIBITED"]]} />{notice && <p className="group-ticket-success">{notice}</p>}<button type="button" disabled={!cockpit.health.canExecuteNewTrade} onClick={onOpenTicket}>Open canonical execution ticket</button></section>;
}

function MemberDrawer({ groupId, groupMaximumLeverage, member, busy, onClose, onMutate }: { groupId: string; groupMaximumLeverage: number; member: CockpitMember; busy: boolean; onClose: () => void; onMutate: (operation: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [leverage, setLeverage] = useState(member.riskPolicy?.managerRequestedLeverage || 1);
  const [reason, setReason] = useState("");
  const pending = member.state === "PENDING_APPROVAL";
  return <div className="member-drawer-backdrop" onClick={onClose}><aside className="member-drawer" onClick={(event) => event.stopPropagation()}><header><div><span>MEMBER OPERATIONS</span><strong>{member.profile?.displayName || member.profile?.handle || member.userId}</strong></div><button type="button" onClick={onClose}><X size={14} /></button></header><div className="member-drawer-body"><StateBadge state={member.state} /><InfoGrid items={[["Method", member.method?.replaceAll("_", " ") || "UNAVAILABLE"], ["Connection", member.connection ? `${member.connection.provider.toUpperCase()} · ${member.connection.label}` : "UNAVAILABLE"], ["Worker", member.connection?.workerState || "UNAVAILABLE"], ["Reconciliation", member.connection?.synchronizationState || "UNAVAILABLE"], ["Allocated equity", currencyOrUnavailable(member.portfolio?.allocatedEquity)], ["Net PnL", currencyOrUnavailable(member.portfolio?.netPnl)], ["Visibility", member.portfolioVisibility.replaceAll("_", " ")], ["API credentials", "INACCESSIBLE"]]} />{member.riskPolicy && <div className="leverage-control"><label><span>Manager requested leverage</span><input type="number" min={1} max={member.riskPolicy.userMaximumLeverage} value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} /></label><div><span>User maximum <b>{member.riskPolicy.userMaximumLeverage}x</b></span><span>Projected upper bound <b>{Math.min(leverage, member.riskPolicy.userMaximumLeverage, groupMaximumLeverage)}x</b></span><span>Current effective <b>{member.riskPolicy.effectiveLeverage}x</b></span></div><button type="button" disabled={busy || leverage > member.riskPolicy.userMaximumLeverage} onClick={() => void onMutate(() => investmentGroupsApi.updateRequestedLeverage(groupId, member.id, member.riskPolicy!.version, leverage, reason || "Manager requested leverage update."), "MEMBER LEVERAGE UPDATED WITHIN THE SIGNED CAP.")}>Update leverage</button></div>}<label className="capital-field"><span>Operational reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required for reject, pause or removal" /></label></div><footer>{pending ? <><button type="button" disabled={busy} onClick={() => void onMutate(() => investmentGroupsApi.approve(groupId, member.id), "MEMBERSHIP APPROVED AND ACTIVATED AFTER ELIGIBILITY CHECKS.")}><UserCheck size={13} /> Approve</button><button type="button" className="danger" disabled={busy || reason.trim().length < 5} onClick={() => void onMutate(() => investmentGroupsApi.reject(groupId, member.id, reason), "MEMBERSHIP APPLICATION REJECTED; MANDATE REVOKED.")}><X size={13} /> Reject</button></> : <><button type="button" disabled={busy || !["ACTIVE", "PAUSED_BY_MANAGER"].includes(member.state)} onClick={() => void onMutate(() => member.state === "PAUSED_BY_MANAGER" ? investmentGroupsApi.resumeMember(groupId, member.id, reason || "Manager pause lifted.") : investmentGroupsApi.pauseMember(groupId, member.id, reason || "Manager risk pause."), member.state === "PAUSED_BY_MANAGER" ? "MEMBER RESUMED AFTER FRESH ELIGIBILITY CHECKS." : "MEMBER FUTURE ENTRIES PAUSED. PROTECTIVE ORDERS REMAIN ACTIVE.")}>{member.state === "PAUSED_BY_MANAGER" ? <Play size={13} /> : <Pause size={13} />}{member.state === "PAUSED_BY_MANAGER" ? "Resume member" : "Pause member"}</button><button type="button" className="danger" disabled={busy || reason.trim().length < 5} onClick={() => { if (window.confirm("Remove this member? Future entries will be revoked and positions detached, not force-closed.")) void onMutate(() => investmentGroupsApi.removeMember(groupId, member.id, reason), "MEMBER REMOVED; POSITIONS DETACHED WITHOUT FORCE-CLOSE."); }}><UserMinus size={13} /> Remove</button></>}</footer></aside></div>;
}

function LeaveDialog({ group, busy, onClose, onLeave }: { group: InvestmentGroupSummary; busy: boolean; onClose: () => void; onLeave: (policy: ExitPolicy, confirmed: boolean) => void }) {
  const [policy, setPolicy] = useState<ExitPolicy>("DETACH");
  const [confirmed, setConfirmed] = useState(false);
  return <div className="network-modal-backdrop"><section className="capital-dialog"><header><div><span>LEAVE COPY TRADING</span><strong>{group.firmName}</strong></div><button type="button" onClick={onClose}><X size={14} /></button></header><div><p>Future-entry authority is revoked immediately after a successful request. No manager approval is required. Broker-native protective orders remain active.</p>{(["DETACH", "CLOSE_NOW", "WHEN_FLAT"] as ExitPolicy[]).map((item) => <label className={policy === item ? "selected" : ""} key={item}><input type="radio" checked={policy === item} onChange={() => { setPolicy(item); setConfirmed(false); }} /><span><strong>{exitPolicyTitle(item)}</strong><small>{exitPolicyBody(item)}</small></span></label>)}{policy === "CLOSE_NOW" && <label className="capital-final-consent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm a second time that attributable positions should be submitted for an exit-only OMS treatment. If safe attribution is unavailable, they must be detached instead of force-closed.</span></label>}</div><footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="danger" disabled={busy || (policy === "CLOSE_NOW" && !confirmed)} onClick={() => onLeave(policy, confirmed)}>{busy ? "Revoking…" : "Revoke authority & leave"}</button></footer></section></div>;
}

function CreateGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [draft, setDraft] = useState({ firmName: "", description: "", strategySummary: "", methodologySummary: "", riskClassification: "UNCLASSIFIED", groupMaximumLeverage: 20, approvalRequired: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => { setBusy(true); try { if (!draft.firmName.trim()) throw new Error("Group name is required."); await investmentGroupsApi.create({ ...draft, visibility: "public", accessMode: draft.approvalRequired ? "approval_required" : "open", supportedProviders: ["bybit"], copyTradingEnabled: true }); await onCreated(); } catch (submitError) { setError(messageOf(submitError)); } finally { setBusy(false); } };
  return <div className="network-modal-backdrop"><section className="capital-dialog create-group-dialog"><header><div><span>CREATE INVESTMENT GROUP</span><strong>Server-backed group identity</strong></div><button type="button" onClick={onClose}><X size={14} /></button></header>{error && <div className="capital-feedback error">{error}</div>}<div className="capital-form-grid"><label className="capital-field wide"><span>Group name</span><input value={draft.firmName} onChange={(event) => setDraft({ ...draft, firmName: event.target.value })} /></label><label className="capital-field wide"><span>Description</span><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label className="capital-field wide"><span>Strategy summary</span><textarea value={draft.strategySummary} onChange={(event) => setDraft({ ...draft, strategySummary: event.target.value })} /></label><label className="capital-field wide"><span>Methodology</span><textarea value={draft.methodologySummary} onChange={(event) => setDraft({ ...draft, methodologySummary: event.target.value })} /></label><label className="capital-field"><span>Risk classification</span><select value={draft.riskClassification} onChange={(event) => setDraft({ ...draft, riskClassification: event.target.value })}><option>UNCLASSIFIED</option><option>LOW</option><option>MODERATE</option><option>HIGH</option><option>VERY_HIGH</option></select></label><NumericField label="Group leverage ceiling" value={draft.groupMaximumLeverage} suffix="x" min={1} max={125} onChange={(next) => setDraft({ ...draft, groupMaximumLeverage: Number(next) })} /><label className="capital-final-consent wide"><input type="checkbox" checked={draft.approvalRequired} onChange={(event) => setDraft({ ...draft, approvalRequired: event.target.checked })} /><span>Require manager approval for new memberships.</span></label></div><footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Creating…" : "Create group"}</button></footer></section></div>;
}

function NumericField({ label, value, suffix, min, max, onChange }: { label: string; value: number; suffix: string; min: number; max: number; onChange: (value: string) => void }) {
  return <label className="capital-field numeric"><span>{label}</span><div><input type="number" value={value} min={min} max={max} step="any" onChange={(event) => onChange(event.target.value)} /><b>{suffix}</b></div></label>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="capital-metric"><span>{label}</span><strong>{value}</strong></div>; }
function PnlMetric({ label, value }: { label: string; value: number | null | undefined }) { return <div className="capital-metric"><span>{label}</span><PnlValue value={value} /></div>; }
function PnlValue({ value }: { value: number | null | undefined }) { return value == null ? <strong className="unavailable">UNAVAILABLE</strong> : <strong className={value > 0 ? "positive" : value < 0 ? "negative" : "neutral"}>{value >= 0 ? "+" : "−"}{money.format(Math.abs(value))}</strong>; }
function StateBadge({ state }: { state: MembershipState }) { return <span className={`state-badge state-${String(state).toLowerCase().replaceAll("_", "-")}`}>{String(state).replaceAll("_", " ")}</span>; }
function InfoGrid({ items }: { items: Array<[string, string]> }) { return <div className="capital-info-grid">{items.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || "NOT PUBLISHED"}</strong></div>)}</div>; }
function TextPanels({ panels }: { panels: Array<[string, string]> }) { return <div className="capital-text-panels">{panels.map(([label, value]) => <article key={label}><span>{label}</span><p>{value || "No verified information has been published."}</p></article>)}</div>; }
function EmptyState({ icon: Icon, title, body }: { icon: typeof Search; title: string; body: string }) { return <div className="capital-state"><Icon size={20} /><strong>{title}</strong><span>{body}</span></div>; }
function Distribution({ label, value, suffix }: { label: string; value: { minimum: number | null; maximum: number | null; average: number | null; median: number | null; count: number }; suffix: string }) { return <article><span>{label.toUpperCase()}</span><strong>{value.average == null ? "UNAVAILABLE" : `${value.average.toFixed(2)}${suffix} AVG`}</strong><small>{value.count ? `${value.minimum?.toFixed(2)}${suffix} — ${value.maximum?.toFixed(2)}${suffix} · median ${value.median?.toFixed(2)}${suffix}` : "No server samples"}</small></article>; }

function verifiedPercent(value: number | null, verified: boolean) { return verified ? percent(value) : "UNVERIFIED"; }
function verifiedCurrency(value: number | null, verified: boolean) { return verified && value != null ? compactMoney.format(value) : "UNVERIFIED"; }
function percent(value: number | null | undefined) { return value == null ? "UNAVAILABLE" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`; }
function currencyOrUnavailable(value: number | null | undefined) { return value == null ? "UNAVAILABLE" : money.format(value); }
function valueOrUnavailable(value: number | null | undefined, suffix: string) { return value == null ? "UNAVAILABLE" : `${value}${suffix}`; }
function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase(); }
function date(value: string) { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value)); }
function time(value: string) { return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function dateTime(value: string) { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function riskAcknowledgementLabel(key: RiskAcknowledgementKey) { return ({ noProfitGuarantee: "I understand that profit is not guaranteed.", capitalLoss: "I understand that I may lose some or all allocated capital.", leverageLiquidation: "I understand the risks of leverage and liquidation.", executionDivergence: "I understand that copied executions may differ from the manager's execution.", persistentExecution: "I understand that Copy Trading may continue after logout or browser closure.", noWithdrawalAuthority: "I understand that the group manager cannot withdraw or transfer my funds.", pauseOrLeaveAnytime: "I understand that I may pause or leave Copy Trading at any time." } as Record<RiskAcknowledgementKey, string>)[key]; }
function exitPolicyTitle(policy: ExitPolicy) { return policy === "DETACH" ? "Detach and manage positions myself" : policy === "CLOSE_NOW" ? "Close all group-originated positions now" : "Leave when group-originated positions are flat"; }
function exitPolicyBody(policy: ExitPolicy) { return policy === "DETACH" ? "Default. Manager control ends immediately; positions remain in your account." : policy === "CLOSE_NOW" ? "Requires second confirmation and safe group attribution through OMS/EMS. No blind account-level close." : "New entries stop now; membership finishes after attributed positions are flat."; }
async function hashText(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
