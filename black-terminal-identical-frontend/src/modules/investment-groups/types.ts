export type ParticipationMethod = "COPY_TRADING" | "OBSIDIAN_VAULT";
export type MembershipState =
  | "DRAFT" | "RISK_ACCEPTED" | "METHOD_SELECTED" | "CONFIGURING" | "PENDING_APPROVAL"
  | "APPROVED" | "ACTIVATING" | "ACTIVE" | "PAUSED_BY_USER" | "PAUSED_BY_MANAGER"
  | "RISK_SUSPENDED" | "LEAVING" | "LEFT" | "REMOVED" | "REJECTED" | "EXPIRED";
export type PortfolioVisibility = "GROUP_ONLY" | "GROUP_AND_RISK_SUMMARY" | "FULL_SELECTED_ACCOUNT";
export type ExitPolicy = "DETACH" | "CLOSE_NOW" | "WHEN_FLAT";

export interface GroupMembership {
  id: string;
  groupId: string;
  userId: string;
  role: "owner" | "manager" | "member";
  state: MembershipState;
  coarseStatus: "pending" | "active" | "removed";
  method: ParticipationMethod | null;
  riskAcknowledgementVersion: string | null;
  mandateId: string | null;
  brokerConnectionId: string | null;
  portfolioVisibility: PortfolioVisibility;
  stateVersion: number;
  joinedAt: string | null;
  pausedAt: string | null;
  leftAt: string | null;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestmentGroupSummary {
  id: string;
  ownerUserId: string;
  ownerHandle: string | null;
  ownerDisplayName: string | null;
  ownerVerified: boolean;
  firmName: string;
  slug: string;
  description: string;
  bio: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  visibility: string;
  accessMode: string;
  approvalRequired: boolean;
  status: string;
  strategySummary: string;
  methodologySummary: string;
  tradingStyleTags: string[];
  acceptedExchanges: string[];
  supportedProviders: string[];
  supportedParticipationMethods: ParticipationMethod[];
  copyTradingEnabled: boolean;
  obsidianResearchOnly: boolean;
  minimumEquity: number | null;
  maximumMembers: number | null;
  groupMaximumLeverage: number;
  riskClassification: string;
  performanceSource: string | null;
  performancePeriodStart: string | null;
  performancePeriodEnd: string | null;
  emergencyStop: boolean;
  isOwner: boolean;
  validInvite: boolean;
  memberCount: number;
  performance: {
    verified: boolean;
    monthlyReturn: number | null;
    yearlyReturn: number | null;
    totalReturn: number | null;
    maximumDrawdown: number | null;
    currentDrawdown: number | null;
    connectedEquity: number | null;
    riskScore: number | null;
    updatedAt: string | null;
  };
  membership: GroupMembership | null;
  memberCapital?: {
    allocatedEquity: number | null;
    realizedPnl: number | null;
    unrealizedPnl: number | null;
    netPnl: number | null;
    drawdownPercent: number | null;
    activePositions: number | null;
    freshness: "LIVE" | "STALE" | "DEGRADED";
    allocationPercent: number | null;
    effectiveLeverage: number | null;
    mandateStatus: string | null;
    executionMode: string | null;
  } | null;
}

export interface InvestmentGroupWorkspace {
  discover: InvestmentGroupSummary[];
  joined: InvestmentGroupSummary[];
  managed: InvestmentGroupSummary[];
  pending: InvestmentGroupSummary[];
}

export interface RiskDocument {
  version: string;
  locale: string;
  title: string;
  text: string;
  acknowledgementKeys: RiskAcknowledgementKey[];
  documentHash: string;
  effectiveAt: string;
  legalReviewRequired: boolean;
}

export type RiskAcknowledgementKey =
  | "noProfitGuarantee" | "capitalLoss" | "leverageLiquidation" | "executionDivergence"
  | "persistentExecution" | "noWithdrawalAuthority" | "pauseOrLeaveAnytime";

export interface EligibleGroupConnection {
  id: string;
  accountId: string;
  provider: string;
  label: string;
  accountReference: string | null;
  connectionMode: "CLOUD_DELEGATED" | "HYBRID";
  healthStatus: string;
  workerState: string;
  synchronizationState: string;
  executionReadiness: string;
  executionEnvironment: string;
  equity: number;
  emsRiskCap: number;
  exchangeLeverageCap: number;
  persistent: boolean;
  withdrawalAuthority: "NONE";
  blockers: string[];
  eligible: boolean;
}

export interface GroupDetailPayload {
  group: InvestmentGroupSummary;
  owner: { handle: string; displayName: string; headline: string; bio: string; verified: boolean } | null;
  riskDocument: RiskDocument | null;
  riskAcknowledged: boolean;
  eligibleConnections: EligibleGroupConnection[];
  eligibility: { copyTradingOperational: boolean; certifiedPersistentWorker: boolean; supportedProviders: string[]; reason: string | null };
  joinDraft: JoinDraft | null;
  capacity: { current: number; maximum: number | null; available: boolean };
}

export interface JoinDraft {
  id: string;
  groupId: string;
  currentStep: "DRAFT" | "RISK_ACCEPTED" | "METHOD_SELECTED" | "CONFIGURING" | "REVIEW";
  participationMethod: ParticipationMethod | null;
  configuration: Partial<CopyTradingConfiguration>;
  expiresAt: string;
  updatedAt: string;
}

export interface CopyTradingConfiguration {
  connectionId: string;
  allocationPercent: number;
  userMaximumLeverage: number;
  maximumPositionEquityPercent: number;
  maximumTotalExposurePercent: number;
  maximumDailyLossPercent: number;
  maximumDrawdownPercent: number;
  allowedSymbols: string[];
  allowedMarketTypes: string[];
  longEnabled: boolean;
  shortEnabled: boolean;
  allowedOrderTypes: string[];
  marginMode: "CROSS" | "ISOLATED";
  maximumSlippageBps: number;
  exitPolicy: ExitPolicy;
  portfolioVisibility: PortfolioVisibility;
}

export interface MemberRiskPolicy extends CopyTradingConfiguration {
  id: string;
  membershipId: string;
  version: number;
  managerRequestedLeverage: number;
  effectiveLeverage: number;
  userConsentedAt: string;
  updatedAt: string;
}

export interface GroupPosition {
  id: string;
  membershipId: string;
  userId: string;
  connectionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  state: string;
  quantity: number;
  averagePrice: number;
  markPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  margin: number;
  leverage: number;
  liquidationPrice: number | null;
  updatedAt: string;
}

export interface MemberPortfolioSnapshot {
  membershipId: string;
  connectionId: string | null;
  membershipState: MembershipState;
  capturedAt: string;
  freshness: "LIVE" | "STALE" | "DEGRADED";
  equity: number | null;
  availableBalance: number | null;
  allocatedEquity: number;
  usedMargin: number;
  marginUtilizationPercent: number;
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  shortExposure: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  currentDrawdownPercent: number | null;
  maximumDrawdownPercent: number | null;
  openPositionCount: number;
  openOrderCount: number;
  effectiveLeverage: number;
  walletBalance?: number;
  portfolioVisibility: PortfolioVisibility;
  exactAccountDataVisible: boolean;
}

export interface CockpitMember extends GroupMembership {
  profile: { handle: string; displayName: string; verified: boolean } | null;
  riskPolicy: MemberRiskPolicy | null;
  connection: { id: string; provider: string; label: string; accountReference: string; healthStatus: string; workerState: string; synchronizationState: string; executionReadiness: string; lastHeartbeatAt: string; lastReconciledAt: string; lastErrorCode: string | null; credentialsVisible: false } | null;
  portfolio: MemberPortfolioSnapshot | null;
}

export interface GroupAggregateSnapshot {
  sampledAt: string;
  activeMembers: number;
  pausedMembers: number;
  degradedMembers: number;
  connectedEquity: number;
  allocatedEquity: number;
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  shortExposure: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  currentDrawdownPercent: number | null;
  maximumDrawdownPercent: number | null;
  weightedLeverage: number;
  marginUtilizationPercent: number;
}

export interface InvestmentGroupCockpit {
  group: InvestmentGroupSummary;
  health: { status: string; activeMembers: number; degradedMembers: number; canExecuteNewTrade: boolean };
  aggregate: GroupAggregateSnapshot;
  members: CockpitMember[];
  positions: GroupPosition[];
  analytics: {
    aggregate: GroupAggregateSnapshot;
    allocationDistribution: Distribution;
    leverageDistribution: Distribution;
    drawdownDistribution: Distribution;
    executionQuality: ExecutionQuality;
    formulas: Record<string, string>;
  };
  copyTrading: { members: CockpitMember[]; capitalIncluded: true };
  obsidian: { status: "RESEARCH_PREVIEW"; operational: false; depositsAccepted: false; vaultAddressesGenerated: false; capitalIncludedInCopyTrading: false };
  executionQuality: ExecutionQuality;
}

interface Distribution { minimum: number | null; maximum: number | null; average: number | null; median: number | null; count: number }
interface ExecutionQuality { totalPlans: number; succeeded: number; rejected: number; pending: number; divergenceCount: number; averageSlippageBps: number | null; source: string }
