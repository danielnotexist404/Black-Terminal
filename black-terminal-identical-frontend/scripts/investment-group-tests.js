import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_RISK_ACKNOWLEDGEMENTS,
  aggregateMemberSnapshots,
  assertManagerLeverageRequest,
  calculateEffectiveLeverage,
  coarseMembershipStatus,
  normalizeRiskPolicy,
  validateRiskAcknowledgement
} from "../server/investment-groups/policy.js";
import { calculateFollowerAllocation } from "../server/cloud-execution/allocation-risk.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const document = { version: "2026-08-12.v1", document_hash: "abc", mandatory_acknowledgements: REQUIRED_RISK_ACKNOWLEDGEMENTS };
const checks = Object.fromEntries(REQUIRED_RISK_ACKNOWLEDGEMENTS.map((key) => [key, true]));
assert.equal(validateRiskAcknowledgement({ version: document.version, documentHash: document.document_hash, reachedEnd: true, acknowledgements: checks }, document), true);
assert.throws(() => validateRiskAcknowledgement({ version: document.version, documentHash: document.document_hash, reachedEnd: false, acknowledgements: checks }, document), /complete risk disclosure/i);
assert.throws(() => validateRiskAcknowledgement({ version: "stale", documentHash: document.document_hash, reachedEnd: true, acknowledgements: checks }, document), /changed/i);

const policy = normalizeRiskPolicy({
  allocationPercent: 20, userMaximumLeverage: 5, maximumPositionEquityPercent: 4,
  maximumTotalExposurePercent: 50, maximumDailyLossPercent: 3, maximumDrawdownPercent: 12,
  allowedSymbols: ["btcusdt", "BTCUSDT", "ethusdt"], allowedMarketTypes: ["perpetual"],
  longEnabled: true, shortEnabled: true, allowedOrderTypes: ["market", "limit"],
  marginMode: "cross", maximumSlippageBps: 50, exitPolicy: "detach", portfolioVisibility: "group_only"
}, { groupMaxLeverage: 20 });
assert.deepEqual(policy.allowedSymbols, ["BTCUSDT", "ETHUSDT"]);
assert.equal(policy.portfolioVisibility, "GROUP_ONLY");
assert.equal(calculateEffectiveLeverage({ managerRequestedLeverage: 8, userMaximumLeverage: 5, groupMaximumLeverage: 12, emsRiskCap: 10, exchangeInstrumentCap: 100 }), 5);
const executionAllocation = calculateFollowerAllocation({
  intent: { leverage: 9, quantity_model: "EQUITY_PERCENT", quantity_value: 2 },
  mandate: { allocation_method: "EQUITY_PERCENT", allocation_value: 20, effective_leverage: 8, max_order_notional: 10_000, max_total_exposure: 10_000 },
  account: { equityUsd: 10_000, availableMarginUsd: 10_000 }, instrument: { quantityStep: 0.001, minQuantity: 0.001, minNotional: 5, leverageLimits: { max: 6 } },
  referencePrice: 1_000, emsRiskCap: 7
});
assert.equal(executionAllocation.leverage, 6);
assert.equal(assertManagerLeverageRequest(4, { user_maximum_leverage: 5 }, { groupMaximumLeverage: 10, emsRiskCap: 3, exchangeInstrumentCap: 100 }), 3);
assert.throws(() => assertManagerLeverageRequest(6, { user_maximum_leverage: 5 }, { groupMaximumLeverage: 10, emsRiskCap: 10, exchangeInstrumentCap: 100 }), /signed maximum/i);
assert.equal(coarseMembershipStatus("PAUSED_BY_USER"), "active");
assert.equal(coarseMembershipStatus("LEFT"), "removed");

const snapshots = [
  { membershipState: "ACTIVE", freshness: "LIVE", equity: 10_000, allocatedEquity: 2_000, grossExposure: 1_200, netExposure: 400, longExposure: 800, shortExposure: 400, realizedPnl: 90, unrealizedPnl: 20, grossPnl: 110, fees: 6, funding: 2, netPnl: 102, usedMargin: 200, effectiveLeverage: 3, currentDrawdownPercent: 2, maximumDrawdownPercent: 5 },
  { membershipState: "ACTIVE", freshness: "STALE", equity: 2_000, allocatedEquity: 400, grossExposure: 100, netExposure: -100, longExposure: 0, shortExposure: 100, realizedPnl: -10, unrealizedPnl: -5, grossPnl: -15, fees: 1, funding: 1, netPnl: -17, usedMargin: 50, effectiveLeverage: 2, currentDrawdownPercent: 6, maximumDrawdownPercent: 8 },
  { membershipState: "PAUSED_BY_USER", freshness: "LIVE", equity: 9_999, allocatedEquity: 9_999 }
];
const aggregate = aggregateMemberSnapshots(snapshots, "2026-08-12T00:00:00.000Z");
assert.equal(aggregate.activeMembers, 2);
assert.equal(aggregate.pausedMembers, 1);
assert.equal(aggregate.degradedMembers, 1);
assert.equal(aggregate.connectedEquity, 12_000);
assert.equal(aggregate.grossPnl, 95);
assert.equal(aggregate.netPnl, 85);
assert.equal(aggregate.grossExposure, 1_300);
assert.equal(aggregate.netExposure, 300);
assert.equal(aggregate.currentDrawdownPercent, 6);
const missingDrawdownAggregate = aggregateMemberSnapshots([{ membershipState: "ACTIVE", freshness: "LIVE", allocatedEquity: 100, equity: 100, effectiveLeverage: 1 }]);
assert.equal(missingDrawdownAggregate.currentDrawdownPercent, null);
assert.equal(missingDrawdownAggregate.maximumDrawdownPercent, null);
assert.throws(() => normalizeRiskPolicy({ ...policy, allowedSymbols: [], longEnabled: true, shortEnabled: false }), /cannot be empty/i);
assert.throws(() => normalizeRiskPolicy({ ...policy, allowedSymbols: ["BTCUSDT"], longEnabled: false, shortEnabled: false }), /direction/i);

const migration = read("supabase/migrations/202608120002_phase5_chapter4_black_capital_network.sql");
const capitalRoute = read("server/network/routes/investment-group-capital.js");
const service = read("server/investment-groups/service.js");
const worker = read("server/cloud-execution/worker.js");
const ui = read("src/modules/investment-groups/components/InvestmentGroupsPage.tsx");
const groupTicket = read("src/execution/components/UnifiedGroupExecutionTicket.tsx");
const intentRoute = read("server/routes/cloud-execution/intent.js");
assert.match(service, /allow_withdrawals:\s*false/);
assert.match(service, /allow_asset_transfers:\s*false/);
assert.match(migration, /leave_investment_group_copy_trading/);
assert.match(migration, /remove_investment_group_member/);
assert.match(migration, /positions_detached.*true/s);
assert.match(migration, /idx_group_execution_one_broker_account_authority/);
assert.match(migration, /where broker_account_id is not null and status in \('ACTIVE','PAUSED','EXIT_ONLY'\)/);
assert.match(migration, /current_drawdown_percent numeric,/);
assert.match(migration, /obsidian_waitlist_entries/);
assert.match(migration, /investment_group_invites/);
assert.match(migration, /recipient_user_id=auth\.uid\(\).*status='pending'.*expires_at>now\(\)/s);
assert.match(migration, /Research-interest only/);
assert.match(migration, /group_member_snapshots_related_read/);
assert.match(migration, /group_member_snapshots_related_read[\s\S]*m\.user_id=auth\.uid\(\)/);
assert.match(service, /shapeManagerPortfolioSnapshot/);
assert.match(migration, /investment_group_can_manage/);
assert.match(capitalRoute, /risk-acknowledgements/);
assert.match(capitalRoute, /emergency-stop/);
assert.match(service, /WITHDRAWAL_OR_TRANSFER_PERMISSION_FORBIDDEN/);
assert.match(service, /ACCOUNT_ALREADY_ASSIGNED_TO_ANOTHER_GROUP/);
assert.match(service, /conflictsByAccount/);
assert.match(service, /OBSIDIAN_RESEARCH_ONLY/);
assert.match(service, /membershipState = autoAccept \? "ACTIVATING"/);
assert.match(service, /acceptedInvite.*status: "accepted"/s);
assert.match(service, /MEMBERSHIP_REJOIN_REQUIRES_REVIEW/);
assert.match(service, /assertGroupVisible/);
assert.match(service, /input\.resume === true/);
assert.match(service, /group_member_risk_policy_versions/);
assert.match(worker, /freshMandate\.status !== "ACTIVE"/);
assert.match(worker, /freshMembership\.membership_state !== "ACTIVE"/);
assert.match(worker, /FOLLOWER_EXECUTION_SUCCEEDED/);
assert.match(worker, /FOLLOWER_EXECUTION_FAILED/);
assert.match(worker, /estimated_slippage: null/);
assert.match(worker, /strategyParameters: intent\.strategy_parameters/);
assert.match(groupTicket, /QUEUE GROUP INTENT/);
assert.match(groupTicket, /submitGroupIntent/);
assert.match(groupTicket, /OMS \/ EMS/);
assert.match(intentRoute, /existingIntent.*idempotent: true/s);
assert.doesNotMatch(ui, /localStorage|requestToJoinGroup|reviewJoinRequest/);
assert.match(ui, /Positions → Connection Manager/);
assert.match(ui, /Withdrawal authority/);

console.log("Investment Group Chapter IV contract tests passed.");
