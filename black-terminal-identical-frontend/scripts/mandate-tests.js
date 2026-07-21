import assert from "node:assert/strict";
import { evaluateFollowerRisk } from "../server/cloud-execution/allocation-risk.js";
import { tradingSchemasForTests } from "../server/security/trading-schemas.js";

assert.equal(tradingSchemasForTests.cloud.mandate.safeParse({ action: "accept", mandateId: "m1", confirmation: "AUTHORIZE OFFLINE GROUP EXECUTION" }).success, true);
assert.equal(tradingSchemasForTests.cloud.mandate.safeParse({ action: "accept", mandateId: "m1", confirmation: "yes" }).success, false);
for (const status of ["PAUSED", "REVOKED"]) {
  const risk = evaluateFollowerRisk({ intent: { symbol:"BTCUSDT",market_type:"PERPETUAL",order_type:"LIMIT",leverage:1,reduce_only:false,valid_from:new Date(Date.now()-1e3).toISOString(),expires_at:new Date(Date.now()+1e4).toISOString() }, mandate: { status,allowed_symbols:["BTCUSDT"],allowed_market_types:["PERPETUAL"],allowed_order_types:["LIMIT"],max_leverage:2,max_total_exposure:1000,max_daily_loss:100,max_drawdown:20,allow_reduce_only:true }, connection:{connection_mode:"CLOUD_DELEGATED",health_status:"CONNECTED_CLOUD",control_state:"ACTIVE"}, capabilities:{can_execute_while_offline:true,can_receive_group_orders:true,can_withdraw:false,supported_order_types:["LIMIT"]}, allocation:{roundedQuantity:.01,targetNotional:100,estimatedMargin:100,calculatedAvailableMargin:500,belowMinimumQuantity:false,belowMinimumNotional:false} });
  assert.equal(risk.status, "REJECTED");
}
const permissionRisk = evaluateFollowerRisk({ intent: { symbol:"BTCUSDT",market_type:"PERPETUAL",order_type:"LIMIT",leverage:1,reduce_only:false,valid_from:new Date(Date.now()-1e3).toISOString(),expires_at:new Date(Date.now()+1e4).toISOString() }, mandate: { status:"ACTIVE",allow_open_positions:false,protective_orders_required:true,allowed_symbols:["BTCUSDT"],allowed_market_types:["PERPETUAL"],allowed_order_types:["LIMIT"],max_leverage:2,max_total_exposure:1000,max_daily_loss:100,max_drawdown:20,allow_reduce_only:true }, connection:{connection_mode:"CLOUD_DELEGATED",health_status:"CONNECTED_CLOUD",control_state:"ACTIVE"}, capabilities:{can_execute_while_offline:true,can_receive_group_orders:true,can_withdraw:false,can_transfer:false,supported_order_types:["LIMIT"]}, allocation:{roundedQuantity:.01,targetNotional:100,estimatedMargin:100,calculatedAvailableMargin:500,belowMinimumQuantity:false,belowMinimumNotional:false} });
assert.ok(permissionRisk.codes.includes("OPEN_PERMISSION_DENIED"));
assert.ok(permissionRisk.codes.includes("PROTECTION_REQUIRED"));
console.log("Mandate tests passed: explicit consent, pause and revocation enforcement.");
