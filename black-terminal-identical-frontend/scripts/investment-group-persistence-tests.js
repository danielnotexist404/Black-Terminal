import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("server/network/routes/investment-groups.js", "utf8");
const page = readFileSync("src/modules/investment-groups/components/InvestmentGroupsPage.tsx", "utf8");
const client = readFileSync("src/modules/investment-groups/investmentGroupsApi.ts", "utf8");

assert.match(page, /investmentGroupsApi\.list\(\)/, "discovery must load the authenticated server list");
assert.match(page, /investmentGroupsApi\.importLocal\(group\)/, "legacy local owner groups must migrate through the authenticated server");
assert.match(route, /owner_user_id.*firm_name[\s\S]*?maybeSingle\(\)/, "legacy import must be idempotent per owner and firm name");
assert.match(route, /visibility\.eq\.public,owner_user_id\.eq\./, "discovery must include public groups plus the viewer's private groups");
assert.doesNotMatch(route.match(/const safeGroupProjection = ([^;]+)/)?.[0] || "", /password_hash/, "public group projection must never expose access hashes");
assert.match(client, /Authorization: `Bearer \$\{token\}`/, "investment group requests must be authenticated");
assert.doesNotMatch(client, /localStorage/, "the server client must not create another browser-local authority");

console.log("Investment Group persistence contracts: PASS");
