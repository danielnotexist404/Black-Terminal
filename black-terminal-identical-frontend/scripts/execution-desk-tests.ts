import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildExecutionDeskActions,
  buildExecutionDeskMetrics,
  executionDeskData,
  executionMarkers,
} from "../src/modules/strategy-lab/execution-desk/executionDeskModel.ts";

const data = executionDeskData({
  positions: [{ id: "open", unrealized_pnl: 125 }],
  orders: [{ id: "working", status: "WORKING" }],
  executions: [
    { id: "entry-live", side: "BUY", price: 100, quantity: 2, executed_at: "2026-08-28T10:00:00Z", signal_key: "confirmed-long" },
    { id: "tp-seven", side: "SELL", price: 121, quantity: .2, executed_at: "2026-08-28T12:00:00Z", signal_key: "swing:TP7" },
  ],
  trades: [
    { id: "closed-long", side: "LONG", quantity: 2, entry_price: 100, exit_price: 110, net_pnl: 20, opened_at: "2026-08-28T10:00:00Z", closed_at: "2026-08-28T11:00:00Z", exit_reason: "OPPOSITE_SIGNAL" },
    { id: "closed-short", side: "SHORT", quantity: 1, entry_price: 110, exit_price: 105, net_pnl: -5, opened_at: "2026-08-28T11:00:00Z", closed_at: "2026-08-28T12:30:00Z", exit_reason: "TAKE_PROFIT_3" },
  ],
  analytics: { netPnl: 15, winRate: 50, profitFactor: 4, maximumDrawdownPercent: 2.5, currentDrawdownPercent: 1 },
});

const actions = buildExecutionDeskActions(data, "LIVE");
assert.ok(actions.some((action) => action.action === "LONG" && action.role === "entry"));
assert.ok(actions.some((action) => action.action === "SHORT" && action.role === "entry"));
assert.ok(actions.some((action) => action.action === "TP7" && action.role === "takeProfit"));
assert.ok(actions.some((action) => action.action === "TP3" && action.role === "takeProfit"));
assert.ok(actions.some((action) => action.action === "CLOSE POSITION LONG" && action.role === "reversal"));

const metrics = buildExecutionDeskMetrics(data, null, {
  bindingId: "binding",
  slotIndex: 1,
  timestamp: Date.now(),
  freshness: "LIVE",
  equity: 10_140,
  availableBalance: 9_000,
  allocatedStrategyCapital: 10_000,
  usedStrategyCapital: 1_000,
  freeStrategyCapital: 9_000,
  openPositions: 1,
  openOrders: 1,
  realizedPnl: 15,
  unrealizedPnl: 125,
  grossPnl: 140,
  fees: 2,
  funding: 1,
  netPnl: 137,
  currentDrawdownPercent: 1,
  maximumDrawdownPercent: 2.5,
  winRate: 50,
  profitFactor: 4,
  tradeCount: 2,
  strategyState: "LIVE",
  connectionHealth: "LIVE",
  protectionHealth: "PROTECTED",
});
assert.equal(metrics.ongoingPnl, 137);
assert.equal(metrics.profitFactor, 4);
assert.equal(metrics.openPositions, 1);

const marker = executionMarkers(actions.filter((action) => action.action === "TP7"), [1_777_374_000, 1_777_377_600, 1_777_381_200])[0];
assert.equal(marker?.label, "TP7");
assert.equal(marker?.strategyRole, "takeProfit");

const cockpitSource = fs.readFileSync(new URL("../src/modules/strategy-lab/my-strategy/pages/StrategyCockpitPage.tsx", import.meta.url), "utf8");
const deskSource = fs.readFileSync(new URL("../src/modules/strategy-lab/execution-desk/StrategyExecutionDesk.tsx", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../server/strategy-automation/service.js", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("../server/strategy-automation/repository.js", import.meta.url), "utf8");
assert.match(cockpitSource, /\["executionDesk", "EXECUTION DESK"\]/);
assert.match(deskSource, /This chart is owned by the strategy runtime\. It never mounts the strategy onto the default discretionary chart\./);
assert.doesNotMatch(deskSource, /onDefinitionChange|onVisibleIndicatorsChange|setActiveNav/);
assert.match(serviceSource, /clean\[0\] === "group-execution-desks"/);
assert.match(repositorySource, /Join this Investment Group before opening its Strategy Execution Desk/);
assert.match(repositorySource, /definition:\s*\{[\s\S]*settings: \{\},[\s\S]*execution: \{\}/);

console.log("Strategy Execution Desk model tests passed.");
