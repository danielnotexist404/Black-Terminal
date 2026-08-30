import assert from "node:assert/strict";
import { brokerWorkspaceScope, isPersonalWorkspaceBroker } from "../src/connectivity/connectionWorkspaceScope.ts";

assert.equal(brokerWorkspaceScope({ workspaceScope: "PERSONAL", cloud: null }), "PERSONAL");
assert.equal(isPersonalWorkspaceBroker({ workspaceScope: "PERSONAL", cloud: null }), true);
assert.equal(brokerWorkspaceScope({ workspaceScope: "STRATEGY_LAB", cloud: { id: "strategy-cloud" } }), "STRATEGY_LAB");
assert.equal(isPersonalWorkspaceBroker({ workspaceScope: "STRATEGY_LAB", cloud: { id: "strategy-cloud" } }), false);
assert.equal(brokerWorkspaceScope({ cloud: { id: "legacy-strategy-cloud" } }), "STRATEGY_LAB", "legacy cloud automation must fail closed outside the personal chart");
assert.equal(brokerWorkspaceScope({ cloud: null }), "PERSONAL", "legacy manual accounts remain available to the personal terminal");

console.log("Connection workspace scope PASS — Strategy Lab brokers cannot enter the personal chart, portfolio, order or venue state.");
