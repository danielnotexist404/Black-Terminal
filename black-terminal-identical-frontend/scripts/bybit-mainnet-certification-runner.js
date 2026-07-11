import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  decryptCredentialPayload,
  getSupabaseAdmin
} from "../server/portfolio-api.js";
import {
  getBybitDiagnostics,
  getBybitInstrumentMetadata,
  getBybitOpenOrders,
  getBybitPositions
} from "../server/exchanges/bybit.js";
import { syncBybitSnapshotAndReconcile } from "../server/exchanges/bybit-reconciliation.js";
import {
  evaluateBybitCertification,
  statusLine
} from "../server/exchanges/bybit-certification.js";

const LIVE = "LIVE";
const INITIAL_LIVE_CONFIRMATION = "LIVE BYBIT MAINNET";
const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, "docs", "BYBIT_MAINNET_CERTIFICATION_REPORT.md");
const certificationRunId = `bybit-cert-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const config = {
  accountId: process.env.BYBIT_CERTIFY_ACCOUNT_ID || process.env.BYBIT_STREAM_ACCOUNT_ID || "",
  symbol: String(process.env.BYBIT_CERTIFY_SYMBOL || firstCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS) || "BTCUSDT").toUpperCase(),
  apiBaseUrl: trimTrailingSlash(process.env.BYBIT_CERTIFY_API_BASE_URL || ""),
  bearerToken: process.env.BYBIT_CERTIFY_USER_TOKEN || "",
  maxClockSkewMs: Number(process.env.BYBIT_CERTIFY_MAX_CLOCK_SKEW_MS || 3000),
  privateStreamFreshMs: Number(process.env.BYBIT_CERTIFY_PRIVATE_STREAM_FRESH_MS || 60_000),
  operatorPause: process.env.BYBIT_CERTIFY_OPERATOR_PAUSE !== "false",
  includeReverse: process.env.BYBIT_CERTIFY_INCLUDE_REVERSE === "true",
  confirmation: process.env.BYBIT_CERTIFY_CONFIRMATION || "",
  limitOffsetBps: Number(process.env.BYBIT_CERTIFY_LIMIT_OFFSET_BPS || 300),
  protectionOffsetBps: Number(process.env.BYBIT_CERTIFY_PROTECTION_OFFSET_BPS || 120)
};

const report = {
  certificationRunId,
  date: new Date().toISOString(),
  accountId: mask(config.accountId),
  symbol: config.symbol,
  adapterVersion: "phase-iii-chapter-xii-c",
  status: "blocked",
  decision: "BLOCKED_EXTERNAL_CONFIGURATION",
  environmentHealth: [],
  rows: [],
  evidence: [],
  limitations: [],
  defects: []
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
let activeContext = null;
let pendingEvidenceWrites = [];

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Certification failed: ${message}`);
  report.status = "blocked";
  report.defects.push(message);
  writeReport();
  process.exitCode = 1;
} finally {
  rl.close();
}

async function main() {
  console.log("Black Terminal Bybit mainnet certification runner");
  console.log("This command can submit real Bybit mainnet orders after preflight and operator confirmation.");
  console.log(`Certification run id: ${certificationRunId}`);

  const preflight = await runPreflight();
  if (!preflight.ok) {
    for (const reason of preflight.reasons) console.error(`BLOCKED: ${reason}`);
    const decision = evaluateBybitCertification({ rows: report.rows, blockers: preflight.reasons, defects: report.defects });
    report.status = "blocked";
    report.decision = decision.outcome;
    report.defects.push(...preflight.reasons);
    await flushEvidenceWrites();
    writeReport();
    process.exitCode = 1;
    return;
  }

  activeContext = preflight.context;
  const typed = config.confirmation || await rl.question(`Type ${INITIAL_LIVE_CONFIRMATION} to begin live Bybit validation: `);
  if (typed !== INITIAL_LIVE_CONFIRMATION) {
    mark("operator-confirmation", "blocked", "LIVE confirmation was not provided.");
    report.status = "blocked";
    report.decision = "BLOCKED_EXTERNAL_CONFIGURATION";
    await flushEvidenceWrites();
    writeReport();
    process.exitCode = 1;
    return;
  }

  const context = preflight.context;
  const plan = buildOrderPlan(context.metadata, context.ticker.lastPrice);
  mark("preflight", "passed", "All preflight checks passed.", { plan });

  await validateLimitCancel(context, plan);
  await validateModify(context, plan);
  await validateMarketAndPosition(context, plan);
  await validateProtection(context, plan);
  await validatePartialClose(context, plan);
  await validateClose(context, plan);
  if (config.includeReverse) await validateReverse(context, plan);
  else mark("reverse", "skipped", "Reverse validation skipped because BYBIT_CERTIFY_INCLUDE_REVERSE is not true.");
  await validateReconnect(context);

  mark("persisted-evidence", "passed", "Certification evidence writes were queued for Supabase persistence.", { certificationRunId });
  await flushEvidenceWrites();
  const decision = evaluateBybitCertification({ rows: report.rows, blockers: [], defects: report.defects });
  report.decision = decision.outcome;
  const incomplete = report.rows.filter((row) => !["passed", "skipped"].includes(row.status));
  report.status = decision.outcome === "CERTIFIED" && incomplete.length === 0 && config.includeReverse ? "certified" : "partial";
  if (!config.includeReverse) {
    report.limitations.push("Reverse validation was skipped. Keep Bybit certification partial until reverse is validated or explicitly waived.");
  }
  writeReport();
  process.exitCode = report.status === "certified" ? 0 : 2;
}

async function runPreflight() {
  const reasons = [];
  const checks = [];
  const requiredEnv = [
    "BYBIT_MAINNET_VALIDATION_ENABLED",
    "EXCHANGE_CREDENTIAL_MASTER_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "BYBIT_MAINNET_ALLOWED_CONNECTIONS",
    "BYBIT_MAINNET_ALLOWED_SYMBOLS",
    "BYBIT_MAINNET_MAX_NOTIONAL_USD",
    "BYBIT_CERTIFY_API_BASE_URL",
    "BYBIT_CERTIFY_USER_TOKEN"
  ];

  if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) {
    fail("env:SUPABASE_URL", "SUPABASE_URL or VITE_SUPABASE_URL is required.");
  } else {
    pass("env:SUPABASE_URL", "configured");
  }
  for (const key of requiredEnv) {
    if (!process.env[key]) fail(`env:${key}`, `${key} is required.`);
    else pass(`env:${key}`, key.includes("KEY") || key.includes("TOKEN") ? "configured secret" : "configured");
  }
  if (process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") {
    fail("env:BYBIT_MAINNET_VALIDATION_ENABLED", "BYBIT_MAINNET_VALIDATION_ENABLED must be true.");
  }
  if (!config.accountId) fail("account:operator-selection", "BYBIT_CERTIFY_ACCOUNT_ID or BYBIT_STREAM_ACCOUNT_ID is required.");
  else pass("account:operator-selection", mask(config.accountId));
  if (!config.apiBaseUrl) fail("env:BYBIT_CERTIFY_API_BASE_URL", "BYBIT_CERTIFY_API_BASE_URL is required.");
  if (!config.bearerToken) fail("env:BYBIT_CERTIFY_USER_TOKEN", "BYBIT_CERTIFY_USER_TOKEN is required.");
  if (!csv(process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS).includes(config.accountId)) {
    fail("allowlist:connection", "Certification account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  } else {
    pass("allowlist:connection", "account allowlisted");
  }
  if (!csv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase()).includes(config.symbol)) {
    fail("allowlist:symbol", "Certification symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS.");
  } else {
    pass("allowlist:symbol", `${config.symbol} allowlisted`);
  }
  const maxNotional = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0);
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) fail("risk:max-notional", "BYBIT_MAINNET_MAX_NOTIONAL_USD must be a positive number.");
  else pass("risk:max-notional", `${maxNotional} USDT`);

  if (reasons.length > 0) {
    printPreflightChecks(checks);
    report.environmentHealth = checks;
    return { ok: false, reasons };
  }

  const supabase = getSupabaseAdmin();
  const { data: account, error: accountError } = await supabase
    .from("exchange_accounts")
    .select("*")
    .eq("id", config.accountId)
    .single();
  if (accountError || !account) fail("supabase:exchange-account", accountError?.message || "Bybit account not found.");
  else pass("supabase:exchange-account", `found ${mask(account.id)}`);
  if (account && account.exchange !== "bybit") fail("supabase:exchange-account-venue", "Certification account is not a Bybit account.");
  else if (account) pass("supabase:exchange-account-venue", "bybit");

  const { data: credential, error: credentialError } = await supabase
    .from("exchange_credentials")
    .select("encrypted_payload")
    .eq("account_id", config.accountId)
    .single();
  if (credentialError || !credential) fail("supabase:exchange-credential", credentialError?.message || "Encrypted Bybit credential is missing.");
  else pass("supabase:exchange-credential", "encrypted credential found");

  if (reasons.length > 0) {
    printPreflightChecks(checks);
    report.environmentHealth = checks;
    return { ok: false, reasons };
  }

  let credentials;
  try {
    credentials = decryptCredentialPayload(credential.encrypted_payload);
    pass("credential-encryption", "credential payload decrypts");
  } catch (error) {
    fail("credential-encryption", error instanceof Error ? error.message : String(error));
  }
  if (reasons.length > 0) {
    printPreflightChecks(checks);
    report.environmentHealth = checks;
    return { ok: false, reasons };
  }

  const diagnostics = await getBybitDiagnostics(credentials, { symbol: config.symbol });
  const metadata = (await getBybitInstrumentMetadata({ category: "linear", symbol: config.symbol }))[0];
  const ticker = await getBybitTicker(config.symbol);
  const streamHealth = await getLatestPrivateStreamHealth(supabase, account.id);

  if (diagnostics.permissions.read) pass("permission:read", "read access present");
  else fail("permission:read", "Bybit API key does not advertise read permission.");
  if (diagnostics.permissions.withdrawal) fail("permission:withdrawal", "Bybit API key has withdrawal permission. Use a trading-only key.");
  else pass("permission:withdrawal", "withdrawal permission absent");
  if (!diagnostics.permissions.trading) fail("permission:trading", "Bybit API key does not advertise trading permission.");
  else pass("permission:trading", "trading permission present");
  if (Math.abs(diagnostics.time.clockSkewMs) > config.maxClockSkewMs) {
    fail("time:clock-skew", `Clock skew ${diagnostics.time.clockSkewMs}ms exceeds ${config.maxClockSkewMs}ms.`);
  } else {
    pass("time:clock-skew", `${diagnostics.time.clockSkewMs}ms`);
  }
  if (!metadata) fail("metadata:instrument", `Instrument metadata for ${config.symbol} is missing.`);
  else pass("metadata:instrument", `${config.symbol} metadata loaded`);
  if (metadata && !["Trading", "trading"].includes(String(metadata.tradingStatus))) {
    fail("metadata:trading-status", `${config.symbol} is not trading on Bybit (${metadata.tradingStatus}).`);
  } else if (metadata) {
    pass("metadata:trading-status", String(metadata.tradingStatus));
  }
  if (!streamHealth.ok) fail("private-stream", streamHealth.reason);
  else pass("private-stream", `authenticated, ${streamHealth.ageMs}ms old`);
  const allowExistingExposure = process.env.BYBIT_CERTIFY_ALLOW_EXISTING_EXPOSURE === "true";
  if (diagnostics.openOrders.length > 0 && !allowExistingExposure) {
    fail("orders:existing-open", `${diagnostics.openOrders.length} existing open orders detected. Cancel or explicitly allow with BYBIT_CERTIFY_ALLOW_EXISTING_EXPOSURE=true.`);
  } else if (diagnostics.openOrders.length > 0) {
    warn("orders:existing-open", `${diagnostics.openOrders.length} existing open orders detected. Operator override enabled.`);
  } else {
    pass("orders:existing-open", "none");
  }
  if (diagnostics.positions.length > 0 && !allowExistingExposure) {
    fail("positions:existing-exposure", `${diagnostics.positions.length} existing position(s) detected. Flatten or explicitly allow with BYBIT_CERTIFY_ALLOW_EXISTING_EXPOSURE=true.`);
  } else if (diagnostics.positions.length > 0) {
    warn("positions:existing-exposure", `${diagnostics.positions.length} existing position(s) detected. Operator override enabled.`);
  } else {
    pass("positions:existing-exposure", "none");
  }
  diagnostics.balances.length > 0 ? pass("balances:available", `${diagnostics.balances.length} balance rows`) : warn("balances:available", "no non-zero balances returned");
  pass("account-mode", "UNIFIED account assumed from Bybit wallet-balance endpoint");
  pass("margin-mode", "symbol margin mode will not be silently changed");
  const executionReady = process.env.BYBIT_MAINNET_VALIDATION_ENABLED === "true"
    && diagnostics.permissions.trading
    && !diagnostics.permissions.withdrawal
    && streamHealth.ok;
  executionReady
    ? pass("execution-readiness", "Bybit controlled mainnet validation runtime is ready.")
    : fail("execution-readiness", diagnostics.readinessReason || "Bybit controlled mainnet validation runtime is not ready.");

  const accountSync = await syncBybitSnapshotAndReconcile(supabase, account.user_id, account, credentials, { symbol: config.symbol });
  pass("snapshot-reconciliation", `external state changed: ${accountSync.externalStateChanged ? "yes" : "no"}`);
  printPreflightChecks(checks);
  report.environmentHealth = checks;
  mark("credential-validation", reasons.length ? "blocked" : "passed", "Bybit credential permissions and encryption boundary checked.", {
    read: diagnostics.permissions.read,
    trading: diagnostics.permissions.trading,
    withdrawal: diagnostics.permissions.withdrawal
  });
  mark("private-stream", streamHealth.ok ? "passed" : "blocked", streamHealth.ok ? "Private stream health is fresh and authenticated." : streamHealth.reason, streamHealth);
  mark("account-read", reasons.length ? "blocked" : "passed", "Credential, metadata, balances, positions, and open orders checked.", {
    clockSkewMs: diagnostics.time.clockSkewMs,
    balances: diagnostics.balances.length,
    positions: diagnostics.positions.length,
    openOrders: diagnostics.openOrders.length,
    streamHealth,
    accountSync
  });

  return {
    ok: reasons.length === 0,
    reasons,
    context: { supabase, account, credentials, diagnostics, metadata, ticker, streamHealth }
  };

  function pass(label, message) {
    checks.push({ status: "PASS", label, message });
  }

  function fail(label, message) {
    checks.push({ status: "FAIL", label, message });
    reasons.push(message);
  }

  function warn(label, message) {
    checks.push({ status: "WARNING", label, message });
  }
}

async function validateLimitCancel(context, plan) {
  await pause("Submit tiny away-from-market limit order, then cancel it.");
  const startedAt = Date.now();
  const order = await submitOrder({
    accountId: context.account.id,
    exchange: "bybit",
    symbol: config.symbol,
    marketKind: "perpetual",
    side: "buy",
    orderType: "limit",
    quantity: plan.quantity,
    quantityMode: "quantity",
    sizingMethod: "quantity",
    referencePrice: plan.lastPrice,
    limitPrice: plan.limitBuyPrice,
    leverage: 1,
    marginMode: "isolated",
    timeInForce: "gtc"
  });
  const cancel = await apiPost("/api/execution/cancel", {
    orderId: order.order.id,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await reconcile(context);
  mark("limit-cancel", "passed", "Tiny limit order submitted and cancelled.", {
    latencyMs: Date.now() - startedAt,
    order: compactOrder(order.order),
    cancel
  });
}

async function validateModify(context, plan) {
  await pause("Submit tiny limit order, modify price, then cancel it.");
  const startedAt = Date.now();
  const order = await submitOrder({
    accountId: context.account.id,
    exchange: "bybit",
    symbol: config.symbol,
    marketKind: "perpetual",
    side: "buy",
    orderType: "limit",
    quantity: plan.quantity,
    quantityMode: "quantity",
    sizingMethod: "quantity",
    referencePrice: plan.lastPrice,
    limitPrice: plan.limitBuyPrice,
    leverage: 1,
    marginMode: "isolated",
    timeInForce: "gtc"
  });
  const modified = await apiPost("/api/execution/modify", {
    accountId: context.account.id,
    localOrderId: order.order.id,
    symbol: config.symbol,
    limitPrice: plan.modifiedLimitBuyPrice,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  const cancelled = await apiPost("/api/execution/cancel", {
    orderId: order.order.id,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await reconcile(context);
  mark("modify", "passed", "Tiny limit order modified and cancelled.", {
    latencyMs: Date.now() - startedAt,
    order: compactOrder(order.order),
    modified,
    cancelled
  });
}

async function validateMarketAndPosition(context, plan) {
  await pause("Submit smallest valid market order. This creates real exposure.");
  const startedAt = Date.now();
  const order = await submitOrder({
    accountId: context.account.id,
    exchange: "bybit",
    symbol: config.symbol,
    marketKind: "perpetual",
    side: "buy",
    orderType: "market",
    quantity: plan.quantity,
    quantityMode: "quantity",
    sizingMethod: "quantity",
    referencePrice: plan.lastPrice,
    leverage: 1,
    marginMode: "isolated",
    timeInForce: "gtc"
  });
  await wait(2500);
  const sync = await reconcile(context);
  const positions = await getBybitPositions(context.credentials);
  const position = positions.find((item) => item.symbol === config.symbol && item.direction === "long");
  if (!position || position.quantity <= 0) throw new Error("Market order did not create an expected long position.");
  mark("market-position", "passed", "Smallest valid market order filled and position synced.", {
    latencyMs: Date.now() - startedAt,
    order: compactOrder(order.order),
    position: compactPosition(position),
    sync
  });
}

async function validateProtection(context, plan) {
  await pause("Attach native TP/SL, modify both, cancel SL, then restore SL.");
  const startedAt = Date.now();
  const attach = await apiPost("/api/execution/protection", {
    accountId: context.account.id,
    symbol: config.symbol,
    takeProfit: plan.takeProfit,
    stopLoss: plan.stopLoss,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  const modify = await apiPost("/api/execution/protection", {
    accountId: context.account.id,
    symbol: config.symbol,
    takeProfit: plan.takeProfitModified,
    stopLoss: plan.stopLossModified,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  const cancelSl = await apiPost("/api/execution/protection", {
    accountId: context.account.id,
    symbol: config.symbol,
    cancelStopLoss: true,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  const restoreSl = await apiPost("/api/execution/protection", {
    accountId: context.account.id,
    symbol: config.symbol,
    stopLoss: plan.stopLossModified,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await reconcile(context);
  mark("tp-sl", "passed", "Native TP/SL attached, modified, cancelled, and restored.", {
    latencyMs: Date.now() - startedAt,
    attach,
    modify,
    cancelSl,
    restoreSl
  });
}

async function validatePartialClose(context, plan) {
  const positions = await getBybitPositions(context.credentials);
  const position = positions.find((item) => item.symbol === config.symbol && item.direction === "long");
  if (!position) throw new Error("Partial close requires an open long position.");
  const partial = roundToStep(position.quantity / 2, plan.quantityStep);
  if (partial < plan.minQuantity || position.quantity - partial < plan.minQuantity) {
    mark("partial-close", "skipped", "Position size is too small for a valid partial close without violating minimum quantity.", {
      position: compactPosition(position),
      minQuantity: plan.minQuantity
    });
    return;
  }
  await pause(`Partially close ${partial} ${config.symbol}.`);
  const startedAt = Date.now();
  const response = await apiPost("/api/execution/position-action", {
    accountId: context.account.id,
    symbol: config.symbol,
    action: "close",
    direction: "long",
    quantity: partial,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await reconcile(context);
  mark("partial-close", "passed", "Reduce-only partial close submitted and reconciled.", {
    latencyMs: Date.now() - startedAt,
    response
  });
}

async function validateClose(context) {
  await pause("Close remaining position.");
  const positions = await getBybitPositions(context.credentials);
  const position = positions.find((item) => item.symbol === config.symbol && item.direction === "long");
  if (!position) {
    mark("close", "passed", "Account already flat for the validation symbol.");
    return;
  }
  const startedAt = Date.now();
  const response = await apiPost("/api/execution/position-action", {
    accountId: context.account.id,
    symbol: config.symbol,
    action: "close",
    direction: "long",
    quantity: position.quantity,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await wait(2500);
  const sync = await reconcile(context);
  const remaining = (await getBybitPositions(context.credentials)).find((item) => item.symbol === config.symbol);
  if (remaining?.quantity > 0) throw new Error("Close validation left live exposure on Bybit.");
  mark("close", "passed", "Remaining position closed and account is flat for the symbol.", {
    latencyMs: Date.now() - startedAt,
    response,
    sync
  });
}

async function validateReverse(context, plan) {
  await pause("Reverse validation opens and closes real exposure.");
  const open = await submitOrder({
    accountId: context.account.id,
    exchange: "bybit",
    symbol: config.symbol,
    marketKind: "perpetual",
    side: "buy",
    orderType: "market",
    quantity: plan.quantity,
    quantityMode: "quantity",
    sizingMethod: "quantity",
    referencePrice: plan.lastPrice,
    leverage: 1,
    marginMode: "isolated",
    timeInForce: "gtc"
  });
  await wait(2500);
  const reverse = await apiPost("/api/execution/position-action", {
    accountId: context.account.id,
    symbol: config.symbol,
    action: "reverse",
    direction: "long",
    quantity: plan.quantity,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await wait(2500);
  const closeShort = await apiPost("/api/execution/position-action", {
    accountId: context.account.id,
    symbol: config.symbol,
    action: "close",
    direction: "short",
    quantity: plan.quantity,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  });
  await reconcile(context);
  mark("reverse", "passed", "Reverse close-and-open semantics validated, then short exposure closed.", {
    open: compactOrder(open.order),
    reverse,
    closeShort
  });
}

async function validateReconnect(context) {
  await pause("Restart the Bybit private-stream worker now, then press Enter after it reconnects.");
  const before = await getLatestPrivateStreamHealth(context.supabase, context.account.id);
  await wait(5000);
  const after = await getLatestPrivateStreamHealth(context.supabase, context.account.id);
  if (!after.ok) throw new Error(`Private stream reconnect validation failed: ${after.reason}`);
  const sync = await reconcile(context);
  mark("reconnect-reconcile", "passed", "Private stream health and snapshot reconciliation validated after operator restart.", {
    before,
    after,
    sync
  });
}

async function submitOrder(body) {
  const payload = {
    ...body,
    mainnetConfirmed: true,
    liveConfirmation: LIVE
  };
  const response = await apiPost("/api/execution/order", payload);
  if (!response.order) throw new Error("Execution order route did not return an order.");
  if (response.order.status === "rejected") {
    throw new Error(response.order.rejection_reason || "Bybit order was rejected.");
  }
  return response;
}

async function apiPost(route, body) {
  const response = await fetch(`${config.apiBaseUrl}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.bearerToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${route} failed with HTTP ${response.status}`);
  }
  return data;
}

async function reconcile(context) {
  const startedAt = Date.now();
  const sync = await syncBybitSnapshotAndReconcile(context.supabase, context.account.user_id, context.account, context.credentials, { symbol: config.symbol });
  return {
    ...sync,
    latencyMs: Date.now() - startedAt
  };
}

async function getLatestPrivateStreamHealth(supabase, accountId) {
  const { data, error } = await supabase
    .from("connection_health_snapshots")
    .select("*")
    .eq("account_id", accountId)
    .eq("venue_id", "bybit")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: "No Bybit private stream health snapshot exists. Start npm run bybit:private-stream first." };
  const capturedAt = new Date(data.captured_at).getTime();
  const ageMs = Date.now() - capturedAt;
  if (ageMs > config.privateStreamFreshMs) {
    return { ok: false, reason: `Latest private stream snapshot is stale (${ageMs}ms).`, ageMs, snapshot: data.health };
  }
  if (data.private_stream !== "connected" || data.authentication !== "authenticated") {
    return { ok: false, reason: `Private stream is ${data.private_stream}/${data.authentication}.`, ageMs, snapshot: data.health };
  }
  return { ok: true, ageMs, reconnectCount: data.reconnect_count, snapshot: data.health };
}

async function getBybitTicker(symbol) {
  const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.retCode !== 0) throw new Error(data?.retMsg || "Bybit ticker request failed.");
  const item = data.result?.list?.[0];
  if (!item) throw new Error(`Bybit ticker missing for ${symbol}.`);
  return {
    lastPrice: Number(item.lastPrice),
    bid1Price: Number(item.bid1Price || item.lastPrice),
    ask1Price: Number(item.ask1Price || item.lastPrice)
  };
}

function buildOrderPlan(metadata, lastPrice) {
  const maxNotional = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD);
  const minQuantity = Number(metadata.minQuantity || metadata.quantityStep || 0.001);
  const quantityStep = Number(metadata.quantityStep || minQuantity);
  const minNotional = Number(metadata.minNotional || 0);
  const tickSize = Number(metadata.tickSize || 0.1);
  const minQtyForNotional = minNotional > 0 ? ceilToStep(minNotional / lastPrice, quantityStep) : minQuantity;
  const quantity = Math.max(minQuantity, minQtyForNotional);
  const notional = quantity * lastPrice;

  if (notional > maxNotional) {
    throw new Error(`Smallest valid ${config.symbol} order requires ${notional.toFixed(4)} USDT, above BYBIT_MAINNET_MAX_NOTIONAL_USD=${maxNotional}.`);
  }

  const offset = config.limitOffsetBps / 10_000;
  const protectionOffset = config.protectionOffsetBps / 10_000;
  return {
    lastPrice,
    quantityStep,
    minQuantity,
    quantity: roundToStep(quantity, quantityStep),
    limitBuyPrice: floorToStep(lastPrice * (1 - offset), tickSize),
    modifiedLimitBuyPrice: floorToStep(lastPrice * (1 - offset * 1.3), tickSize),
    takeProfit: ceilToStep(lastPrice * (1 + protectionOffset), tickSize),
    takeProfitModified: ceilToStep(lastPrice * (1 + protectionOffset * 1.5), tickSize),
    stopLoss: floorToStep(lastPrice * (1 - protectionOffset), tickSize),
    stopLossModified: floorToStep(lastPrice * (1 - protectionOffset * 1.5), tickSize),
    notional
  };
}

async function pause(message) {
  console.log(`\nNEXT: ${message}`);
  if (!config.operatorPause) return;
  const exposureChanging = /market|close|reverse|protect|tp|sl|partially|submit|order/i.test(message);
  const prompt = exposureChanging
    ? `Type ${LIVE} to continue, or ABORT to stop: `
    : "Press Enter to continue, or type ABORT to stop: ";
  const answer = await rl.question(prompt);
  const normalized = answer.trim().toUpperCase();
  if (normalized === "ABORT" || normalized === "STOP") throw new Error("Operator stopped certification.");
  if (exposureChanging && normalized !== LIVE) throw new Error(`Exposure-changing certification step requires ${LIVE}.`);
}

function mark(operation, status, message, metadata = {}) {
  const row = {
    operation,
    status,
    message,
    timestamp: new Date().toISOString()
  };
  report.rows.push(row);
  report.evidence.push({ ...row, metadata: sanitize(metadata) });
  console.log(`${status.toUpperCase()} ${operation}: ${message}`);
  if (activeContext) {
    pendingEvidenceWrites.push(persistCertificationEvidence(activeContext, row, metadata));
  }
}

async function persistCertificationEvidence(context, row, metadata = {}) {
  const mappedStatus = row.status === "passed"
    ? "passed"
    : row.status === "failed"
      ? "failed"
      : row.status === "blocked"
        ? "blocked"
        : row.status === "skipped"
          ? "cancelled"
          : "started";
  const compactMetadata = sanitize({
    certificationRunId,
    adapterVersion: report.adapterVersion,
    operation: row.operation,
    message: row.message,
    skipped: row.status === "skipped",
    ...metadata
  });

  const { error } = await context.supabase.from("mainnet_validation_records").insert({
    user_id: context.account.user_id,
    account_id: context.account.id,
    venue_id: "bybit",
    network: "mainnet",
    symbol: config.symbol,
    max_notional_usd: Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0),
    requested_notional_usd: Number(metadata?.plan?.notional || metadata?.calculatedNotional || metadata?.order?.notional || 0) || null,
    validation_stage: row.operation,
    status: mappedStatus,
    live_confirmation: row.operation.includes("operator") ? INITIAL_LIVE_CONFIRMATION : LIVE,
    order_id: metadata?.order?.id || null,
    exchange_order_id: metadata?.order?.exchangeOrderId || metadata?.response?.orderId || null,
    risk_check_status: metadata?.risk?.status || null,
    failure_reason: ["failed", "blocked"].includes(row.status) ? row.message : null,
    metadata: compactMetadata,
    completed_at: ["passed", "failed", "blocked", "skipped"].includes(row.status) ? new Date().toISOString() : null
  });

  if (error) {
    report.defects.push(`Evidence persistence failed for ${row.operation}: ${error.message}`);
  }
}

async function flushEvidenceWrites() {
  const writes = pendingEvidenceWrites;
  pendingEvidenceWrites = [];
  if (writes.length === 0) return;
  await Promise.allSettled(writes);
}

function printPreflightChecks(checks) {
  console.log("\nPreflight checks");
  for (const check of checks) {
    console.log(statusLine(check.status, check.label, check.message));
  }
  console.log("");
}

function writeReport() {
  const decision = evaluateBybitCertification({ rows: report.rows, blockers: report.defects });
  report.decision = report.decision || decision.outcome;
  const table = report.rows.map((row) => `| ${row.operation} | ${row.status.toUpperCase()} | ${row.message.replace(/\|/g, "/")} | ${row.timestamp} |`).join("\n");
  const environment = report.environmentHealth.map((row) => `| ${row.label} | ${row.status} | ${String(row.message || "").replace(/\|/g, "/")} |`).join("\n");
  const evidence = report.evidence.map((item, index) => `- Evidence ${index + 1}: ${item.operation} / ${item.status} / ${item.timestamp}`).join("\n") || "- No evidence recorded.";
  const limitations = report.limitations.map((item) => `- ${item}`).join("\n") || "- None recorded.";
  const defects = report.defects.map((item) => `- ${item}`).join("\n") || "- None recorded.";
  const body = `# Bybit Mainnet Certification Report

Date: ${report.date}

Certification Run ID: ${report.certificationRunId}

Status: ${report.status.toUpperCase()}

Decision: ${report.decision}

Adapter Version: ${report.adapterVersion}

Account: ${report.accountId}

Symbol: ${report.symbol}

Products Validated: Perpetual derivatives, where all steps pass.

## Environment Health

| Check | Status | Result |
| --- | --- | --- |
${environment || "| none | BLOCKED | No runtime checks completed. |"}

## Test Sequence

| Step | Status | Result | Timestamp |
| --- | --- | --- | --- |
${table || "| none | BLOCKED | No validation steps completed. | " + new Date().toISOString() + " |"}

## Evidence References

${evidence}

Detailed evidence is persisted in \`mainnet_validation_records\` and \`execution_audit_logs\` when the runner reaches live steps.

## Known Limitations

${limitations}

## Unresolved Defects

${defects}

## Certification Status

${report.status === "certified"
  ? "Bybit may be promoted only after this report is reviewed against Supabase evidence."
  : "Bybit must remain PARTIAL / BLOCKED. Do not mark production-certified until every required step has passed with persisted evidence."}
`;
  fs.writeFileSync(REPORT_PATH, body);
  console.log(`Report written: ${REPORT_PATH}`);
}

function compactOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    exchangeOrderId: order.exchange_order_id,
    clientOrderId: order.client_order_id,
    quantity: order.quantity,
    limitPrice: order.limit_price
  };
}

function compactPosition(position) {
  return {
    symbol: position.symbol,
    direction: position.direction,
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    currentPrice: position.currentPrice,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl
  };
}

function sanitize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/secret|credential|token|key|authorization/i.test(key)) return "[redacted]";
    if (typeof item === "string" && item.length > 64) return `${item.slice(0, 12)}...${item.slice(-6)}`;
    return item;
  }));
}

function ceilToStep(value, step) {
  return Math.ceil(Number(value) / Number(step)) * Number(step);
}

function floorToStep(value, step) {
  return Math.floor(Number(value) / Number(step)) * Number(step);
}

function roundToStep(value, step) {
  const precision = String(step).includes(".") ? String(step).split(".")[1].replace(/0+$/, "").length : 0;
  return Number((Math.round(Number(value) / Number(step)) * Number(step)).toFixed(precision));
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function firstCsv(value) {
  return csv(value)[0];
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function mask(value) {
  const text = String(value || "");
  if (text.length <= 10) return text ? "***" : "not-configured";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
