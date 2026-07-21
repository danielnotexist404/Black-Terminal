import assert from "node:assert/strict";
import { diffBalances, diffOrders, diffPositions, findStalePositions } from "../server/exchanges/bybit-reconciliation.js";

assert.deepEqual(diffBalances([{ asset:"USDT",total:100 }],[{ asset:"USDT",total:120 }])[0].type, "balance_changed");
assert.deepEqual(diffPositions([{ symbol:"BTCUSDT",direction:"long",quantity:1 }],[{ symbol:"BTCUSDT",direction:"long",quantity:.8 }])[0].type, "position_quantity_changed");
assert.equal(diffOrders([{ id:"local",exchange_order_id:"venue-1",status:"working" }],[])[0].type, "order_not_in_open_snapshot");
assert.equal(findStalePositions([{ id:"p1",symbol:"BTCUSDT",direction:"long",quantity:1 }],[])[0].id, "p1");
assert.deepEqual(diffOrders([{ id:"local",exchange_order_id:"venue-1",status:"working" }],[{ orderId:"venue-1" }]), []);
console.log("Reconciliation tests passed: balances, partial positions, missing orders, stale repair and duplicate prevention.");
