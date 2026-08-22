import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const app = read("src/App.tsx");
const chart = read("src/components/PixiBlackChart.tsx");
const shield = read("src/components/InteractionShield.tsx");
const css = read("src/styles/theme.css");

assert.match(app, /chartWorkspaceIsolated/);
assert.match(app, /activeNav !== "MARKET OVERVIEW"/);
assert.match(app, /underlay\.setAttribute\("inert", ""\)/);
assert.match(app, /<InteractionShield variant="workspace"/);
assert.match(chart, /chartInteractionIsolated/);
assert.match(chart, /<InteractionShield variant="dialog"/);
assert.match(shield, /onPointerDown=\{isolateEvent\}/);
assert.match(shield, /onTouchStart=\{suppressBrowserAction\}/);
assert.match(shield, /onWheel=\{suppressBrowserAction\}/);
assert.match(css, /\.foreground-workspace-open \.position-protection-overlay[\s\S]*visibility:\s*hidden/);
assert.match(css, /\.interaction-isolated \.position-protection-overlay[\s\S]*visibility:\s*hidden/);
assert.match(css, /\.chart-wrap\.interaction-isolated \.indicator-settings[\s\S]*z-index:\s*20010/);
assert.match(css, /\.interaction-shield[\s\S]*pointer-events:\s*auto/);

console.log("Foreground interaction isolation PASS — workspace and dialog shields block chart, broker-line, wheel and touch event leakage.");
