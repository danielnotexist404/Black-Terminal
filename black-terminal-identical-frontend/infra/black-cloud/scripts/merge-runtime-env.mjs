#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { parseEnv } from "node:util";

const [sourcePath, targetPath, outputPath] = process.argv.slice(2);
const allowMissing = process.argv.includes("--allow-missing");
if (!sourcePath || !targetPath || !outputPath) {
  console.error("Usage: merge-runtime-env.mjs <vercel-env> <target-runtime-env> <output-env>");
  process.exit(2);
}

const source = parseEnv(fs.readFileSync(sourcePath, "utf8"));
const target = parseEnv(fs.readFileSync(targetPath, "utf8"));
const first = (...keys) => keys
  .map((key) => source[key])
  .find((value) => typeof value === "string" && value.length > 0 && !isProtectedPlaceholder(value)) || "";

const migrated = {
  CLAUDE_API_KEY: first("CLAUDE_API_KEY", "VITE_CLAUDE_API_KEY"),
  RESEND_API_KEY: first("RESEND_API_KEY", "VITE_RESEND_API_KEY"),
  RESEND_FROM: first("RESEND_FROM", "VITE_RESEND_FROM"),
  EXCHANGE_CREDENTIAL_MASTER_KEY: first("EXCHANGE_CREDENTIAL_MASTER_KEY"),
  BLACK_CLOUD_SECRET_MASTER_KEY_V1: first(
    "BLACK_CLOUD_SECRET_MASTER_KEY_V1",
    "BLACK_CLOUD_SECRET_MASTER_KEY",
    "EXCHANGE_CREDENTIAL_MASTER_KEY"
  ),
  BLACK_CLOUD_MASTER_KEY_VERSION: first("BLACK_CLOUD_MASTER_KEY_VERSION") || "1",
  BLACK_CLOUD_INTENT_SIGNING_KEY: first("BLACK_CLOUD_INTENT_SIGNING_KEY")
};

for (const [key, value] of Object.entries(migrated)) {
  if (value) target[key] = value;
  else if (isProtectedPlaceholder(target[key])) target[key] = "";
}

for (const key of [
  "CLOUD_EXECUTION_CONTROL_PLANE_ENABLED",
  "BLACK_CLOUD_EXECUTION_ENABLED",
  "INVESTMENT_GROUP_EXECUTION_ENABLED",
  "BYBIT_CLOUD_EXECUTION_ENABLED",
  "BLACK_CLOUD_STRATEGY_RUNTIME_ENABLED",
  "BLACK_CLOUD_MAINNET_ENABLED",
  "BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED",
  "EVENT_ALPHA_PAPER_EXECUTION_ENABLED",
  "EVENT_ALPHA_LIVE_EXECUTION_ENABLED",
  "IMM_ENABLED",
  "IMM_REQUIRED"
]) {
  target[key] = "false";
}
target.EVENT_ALPHA_STRATEGY_KILL_SWITCH = "true";
target.EVENT_ALPHA_GLOBAL_EXECUTION_KILL_SWITCH = "true";

const required = [
  "EXCHANGE_CREDENTIAL_MASTER_KEY",
  "BLACK_CLOUD_SECRET_MASTER_KEY_V1",
  "BLACK_CLOUD_INTENT_SIGNING_KEY"
];
const missing = required.filter((key) => !target[key]);
if (missing.length) {
  console.error(`Missing required migrated runtime keys: ${missing.join(", ")}`);
  if (!allowMissing) process.exit(2);
}

const rendered = Object.keys(target)
  .sort()
  .map((key) => `${key}=${encodeEnvValue(target[key])}`)
  .join("\n") + "\n";
fs.writeFileSync(outputPath, rendered, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);

console.log(`Migrated ${Object.values(migrated).filter(Boolean).length} server-side runtime values; execution remains disabled.`);

function encodeEnvValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(text)) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function isProtectedPlaceholder(value) {
  return /^\[(?:SENSITIVE|REDACTED|ENCRYPTED)\]$/i.test(String(value || "").trim());
}
