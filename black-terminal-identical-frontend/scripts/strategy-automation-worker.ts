import crypto from "node:crypto";
import { getSupabaseAdmin } from "../server/portfolio-api.js";
import {
  calculateCapitalPreview,
  calculateEffectiveLeverage,
  normalizeCapitalPolicy,
} from "../server/strategy-automation/domain.js";
import { createStrategySignals } from "../src/modules/strategy-lab/adapters/signalAdapter.ts";
import type { Candle } from "../src/chart-engine/types.ts";

type JsonRow = Record<string, any>;

const supabase = getSupabaseAdmin();
const workerId = `strategy-paper-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const intervalMs = boundedInteger(
  process.env.STRATEGY_AUTOMATION_TICK_MS,
  15_000,
  5_000,
  300_000,
);
const maxPerTick = boundedInteger(
  process.env.STRATEGY_AUTOMATION_MAX_PER_TICK,
  100,
  1,
  1_000,
);
const concurrency = boundedInteger(
  process.env.STRATEGY_AUTOMATION_CONCURRENCY,
  4,
  1,
  16,
);
const leaseSeconds = Math.max(
  15,
  Math.min(300, Math.ceil(intervalMs / 1000) * 3),
);
const paperEnabled = process.env.STRATEGY_AUTOMATION_PAPER_ENABLED !== "false";
const liveExecutionEnabled =
  process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true";
let running = true;
let ticking = false;

if (liveExecutionEnabled) {
  throw new Error(
    "STRATEGY_AUTOMATION_LIVE_EXECUTION_UNCERTIFIED: this worker build is paper-only and refuses a live execution configuration.",
  );
}

console.log(
  JSON.stringify({
    level: "info",
    event: "strategy_automation_worker_started",
    workerId,
    paperEnabled,
    liveExecutionEnabled: false,
    intervalMs,
  }),
);

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    running = false;
  });

while (running) {
  const started = Date.now();
  await tick().catch((error) =>
    console.error(
      JSON.stringify({
        level: "error",
        event: "strategy_automation_tick_failed",
        code: safeCode(error),
      }),
    ),
  );
  const wait = Math.max(500, intervalMs - (Date.now() - started));
  await delay(wait);
}

console.log(
  JSON.stringify({
    level: "info",
    event: "strategy_automation_worker_stopped",
    workerId,
  }),
);

async function tick() {
  if (ticking || !paperEnabled) return;
  ticking = true;
  try {
    const { data: strategies, error } = await supabase
      .from("strategy_automation_strategies")
      .select("*")
      .in("status", ["PAPER_ACTIVE", "LIVE_READY", "LIVE_ACTIVE"])
      .is("archived_at", null)
      .order("updated_at")
      .limit(maxPerTick);
    if (error) throw error;
    await mapWithConcurrency(
      strategies || [],
      concurrency,
      async (strategy) => {
        if (!running) return;
        const { data: claimed, error: claimError } = await supabase.rpc(
          "black_core_claim_strategy_runtime",
          {
            p_strategy_id: strategy.id,
            p_owner_user_id: strategy.owner_user_id,
            p_worker_id: workerId,
            p_lease_seconds: leaseSeconds,
          },
        );
        if (claimError) throw claimError;
        if (claimed === true)
          await processStrategy(strategy).catch((error) =>
            markFailure(strategy, error),
          );
      },
    );
  } finally {
    ticking = false;
  }
}

async function processStrategy(strategy: JsonRow) {
  const { data: paper, error: paperError } = await supabase
    .from("strategy_paper_accounts")
    .select("*")
    .eq("strategy_id", strategy.id)
    .eq("strategy_version", strategy.current_version)
    .eq("owner_user_id", strategy.owner_user_id)
    .maybeSingle();
  if (paperError) throw paperError;
  if (!paper || paper.status !== "ACTIVE")
    return heartbeat(strategy, "PAUSED", null);
  if (
    !["builtin-ema-cross", "builtin-adaptive-swing"].includes(
      strategy.runtime_kind,
    )
  ) {
    return heartbeat(
      strategy,
      "DEGRADED",
      "RUNTIME_REQUIRES_CERTIFIED_ADAPTER",
    );
  }
  if (String(strategy.exchange).toLowerCase() !== "bybit")
    return heartbeat(strategy, "DEGRADED", "PROVIDER_ADAPTER_UNAVAILABLE");

  const candles = await fetchBybitClosedCandles(
    strategy.symbol,
    strategy.timeframe,
    strategy.market_type,
  );
  const candle = candles.at(-1);
  if (!candle)
    return heartbeat(strategy, "DEGRADED", "MARKET_DATA_UNAVAILABLE");
  const { data: runtime, error: runtimeError } = await supabase
    .from("strategy_automation_runtime_state")
    .select("*")
    .eq("strategy_id", strategy.id)
    .maybeSingle();
  if (runtimeError) throw runtimeError;
  const candleAt = new Date(
    candle.time * 1000 + timeframeMilliseconds(strategy.timeframe),
  ).toISOString();
  if (
    runtime?.last_closed_candle_at &&
    Date.parse(runtime.last_closed_candle_at) >= Date.parse(candleAt)
  ) {
    return heartbeat(strategy, "LIVE", null);
  }

  const { data: position, error: positionError } = await supabase
    .from("strategy_paper_positions")
    .select("*")
    .eq("paper_account_id", paper.id)
    .is("closed_at", null)
    .maybeSingle();
  if (positionError) throw positionError;
  let closedThisCandle = false;
  if (position)
    closedThisCandle = await managePaperPosition(
      strategy,
      paper,
      position,
      candle,
    );

  let signalKey: string | null = null;
  let signalAt: string | null = null;
  if (!position && !closedThisCandle) {
    const signals = createStrategySignals(
      strategy.runtime_kind,
      candles,
      strategy.symbol,
      strategy.definition?.settings || {},
    );
    const signal = [...signals]
      .reverse()
      .find((item) => item.entry && Number(item.timestamp) === candle.time);
    if (signal) {
      signalKey = `${strategy.id}:${strategy.current_version}:${strategy.symbol}:${strategy.timeframe}:${candle.time}:${signal.direction}`;
      signalAt = candleAt;
      await openPaperPosition(
        strategy,
        paper,
        candles,
        candle,
        signal,
        signalKey,
      );
    }
  }

  const { error: updateError } = await supabase
    .from("strategy_automation_runtime_state")
    .upsert(
      {
        strategy_id: strategy.id,
        owner_user_id: strategy.owner_user_id,
        runtime_state: "LIVE",
        state_version: Number(runtime?.state_version || 0) + 1,
        last_closed_candle_at: candleAt,
        last_signal_key: signalKey || runtime?.last_signal_key || null,
        last_signal_at: signalAt || runtime?.last_signal_at || null,
        last_heartbeat_at: new Date().toISOString(),
        worker_id: workerId,
        lease_owner: workerId,
        lease_expires_at: new Date(
          Date.now() + leaseSeconds * 1000,
        ).toISOString(),
        safe_error_code: null,
      },
      { onConflict: "strategy_id" },
    );
  if (updateError) throw updateError;
}

async function openPaperPosition(
  strategy: JsonRow,
  paper: JsonRow,
  candles: Candle[],
  candle: Candle,
  signal: JsonRow,
  signalKey: string,
) {
  const policy = normalizeCapitalPolicy(
    paper.capital_policy,
    paper.market_type,
    { allowZeroAllocation: false },
  );
  if (
    Number(paper.maximum_drawdown_percent || 0) >= policy.maximumDrawdown &&
    policy.maximumDrawdown > 0
  )
    return auditBlocked(strategy, signalKey, "MAXIMUM_DRAWDOWN");
  const startOfDay = new Date(candle.time * 1000);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { data: todayTrades, error: tradeError } = await supabase
    .from("strategy_automation_trades")
    .select("net_pnl")
    .eq("paper_account_id", paper.id)
    .eq("mode", "PAPER")
    .gte("closed_at", startOfDay.toISOString());
  if (tradeError) throw tradeError;
  const dailyPnl = (todayTrades || []).reduce(
    (sum, row) => sum + Number(row.net_pnl || 0),
    0,
  );
  if (policy.maximumDailyLoss > 0 && dailyPnl <= -policy.maximumDailyLoss)
    return auditBlocked(strategy, signalKey, "MAXIMUM_DAILY_LOSS");

  const leverage =
    paper.market_type === "SPOT"
      ? 1
      : calculateEffectiveLeverage({
          requested: policy.requestedLeverage,
          targetMaximum: policy.maximumLeverage,
        });
  const preview = calculateCapitalPreview({
    equity: Number(paper.demo_equity) + Number(paper.unrealized_pnl || 0),
    availableBalance: Number(paper.available_balance),
    policy,
    marketType: paper.market_type,
  });
  const slippage = Math.max(0, Number(policy.slippageBps || 0)) / 10_000;
  const entryPrice =
    candle.close * (signal.direction === "long" ? 1 + slippage : 1 - slippage);
  const feeRate = boundedNumber(
    strategy.definition?.execution?.feeRate,
    0.0006,
    0,
    0.02,
  );
  let quantity =
    policy.tradeAmountMode === "FIXED_QUANTITY"
      ? policy.tradeAmountValue
      : preview.estimatedNotional / Math.max(entryPrice, 1e-12);
  if (policy.tradeAmountMode === "RISK_PERCENT") {
    const stopDistance = signal.stopLoss
      ? Math.abs(entryPrice - Number(signal.stopLoss))
      : entryPrice * 0.01;
    const roundTripFrictionPerUnit = entryPrice * (feeRate * 2 + slippage * 2);
    quantity =
      stopDistance > 0
        ? preview.entryCapital / (stopDistance + roundTripFrictionPerUnit)
        : 0;
  }
  if (policy.tradeAmountMode === "VOLATILITY_TARGET") {
    const atr = averageTrueRange(candles, 14);
    const stopDistance = signal.stopLoss
      ? Math.abs(entryPrice - Number(signal.stopLoss))
      : 0;
    const unitRisk =
      Math.max(atr, stopDistance, entryPrice * 0.001) +
      entryPrice * (feeRate * 2 + slippage * 2);
    quantity = preview.entryCapital / unitRisk;
  }
  const maximumPositionNotional =
    ((preview.allocatedStrategyCapital * policy.maximumPositionPercent) / 100) *
    leverage;
  const maximumExposureNotional =
    ((preview.allocatedStrategyCapital * policy.maximumExposurePercent) / 100) *
    leverage;
  const maximumSpotNotional =
    paper.market_type === "SPOT"
      ? Number(preview.maximumBaseAssetExposure || 0)
      : Number.POSITIVE_INFINITY;
  quantity = Math.min(
    quantity,
    maximumPositionNotional / Math.max(entryPrice, 1e-12),
    maximumExposureNotional / Math.max(entryPrice, 1e-12),
    maximumSpotNotional / Math.max(entryPrice, 1e-12),
  );
  const notional = quantity * entryPrice;
  const margin = paper.market_type === "SPOT" ? notional : notional / leverage;
  const entryFee = notional * feeRate;
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    margin + entryFee > Number(paper.available_balance)
  )
    return auditBlocked(strategy, signalKey, "INSUFFICIENT_PAPER_CAPITAL");
  const maintenance = boundedNumber(
    strategy.definition?.execution?.maintenanceMarginRate,
    0.005,
    0,
    0.2,
  );
  const liquidationPrice =
    paper.market_type === "SPOT"
      ? null
      : signal.direction === "long"
        ? Math.max(0, entryPrice * (1 - 1 / leverage + maintenance))
        : entryPrice * (1 + 1 / leverage - maintenance);
  const { data, error } = await supabase.rpc("black_core_paper_open_position", {
    p_paper_account_id: paper.id,
    p_strategy_id: strategy.id,
    p_owner_user_id: strategy.owner_user_id,
    p_signal_key: signalKey,
    p_symbol: strategy.symbol,
    p_side: signal.direction === "long" ? "LONG" : "SHORT",
    p_quantity: quantity,
    p_entry_price: entryPrice,
    p_leverage: leverage,
    p_margin_used: margin,
    p_liquidation_price: liquidationPrice,
    p_stop_loss: signal.stopLoss || null,
    p_take_profit: signal.takeProfit || null,
    p_entry_fee: entryFee,
    p_opened_at: new Date(
      candle.time * 1000 + timeframeMilliseconds(strategy.timeframe),
    ).toISOString(),
  });
  if (error) throw error;
  return data === true;
}

async function managePaperPosition(
  strategy: JsonRow,
  paper: JsonRow,
  position: JsonRow,
  candle: Candle,
) {
  const candleClosedAt =
    candle.time * 1000 + timeframeMilliseconds(strategy.timeframe);
  if (candleClosedAt <= Date.parse(position.opened_at)) return false;
  const direction = position.side === "LONG" ? 1 : -1;
  const unrealized =
    (candle.close - Number(position.entry_price)) *
    Number(position.quantity) *
    direction;
  const { error: markError } = await supabase.rpc(
    "black_core_paper_mark_position",
    {
      p_position_id: position.id,
      p_owner_user_id: strategy.owner_user_id,
      p_mark_price: candle.close,
      p_unrealized_pnl: unrealized,
    },
  );
  if (markError) throw markError;
  let reason: string | null = null;
  let reference = candle.close;
  if (
    position.liquidation_price &&
    (position.side === "LONG"
      ? candle.low <= Number(position.liquidation_price)
      : candle.high >= Number(position.liquidation_price))
  ) {
    reason = "LIQUIDATION";
    reference = Number(position.liquidation_price);
  } else if (
    position.stop_loss &&
    (position.side === "LONG"
      ? candle.low <= Number(position.stop_loss)
      : candle.high >= Number(position.stop_loss))
  ) {
    reason = "STOP_LOSS";
    reference = Number(position.stop_loss);
  } else if (
    position.take_profit &&
    (position.side === "LONG"
      ? candle.high >= Number(position.take_profit)
      : candle.low <= Number(position.take_profit))
  ) {
    reason = "TAKE_PROFIT";
    reference = Number(position.take_profit);
  }
  if (!reason) return false;
  const policy = normalizeCapitalPolicy(
    paper.capital_policy,
    paper.market_type,
    { allowZeroAllocation: false },
  );
  const slippage = Math.max(0, Number(policy.slippageBps || 0)) / 10_000;
  const exitPrice =
    reference * (position.side === "LONG" ? 1 - slippage : 1 + slippage);
  const notional = Math.abs(exitPrice * Number(position.quantity));
  const exitFee =
    notional *
    boundedNumber(strategy.definition?.execution?.feeRate, 0.0006, 0, 0.02);
  const days =
    Math.max(0, candle.time * 1000 - Date.parse(position.opened_at)) /
    86_400_000;
  const funding =
    Math.abs(Number(position.entry_price) * Number(position.quantity)) *
    boundedNumber(
      strategy.definition?.execution?.fundingRatePerDay,
      0,
      -0.1,
      0.1,
    ) *
    days;
  const exitSignalKey = `${position.signal_key}:exit:${candle.time}:${reason}`;
  const { data, error } = await supabase.rpc(
    "black_core_paper_close_position",
    {
      p_position_id: position.id,
      p_owner_user_id: strategy.owner_user_id,
      p_exit_price: exitPrice,
      p_exit_fee: exitFee,
      p_funding: funding,
      p_exit_reason: reason,
      p_exit_signal_key: exitSignalKey,
      p_closed_at: new Date(candleClosedAt).toISOString(),
    },
  );
  if (error) throw error;
  return data === true;
}

async function auditBlocked(
  strategy: JsonRow,
  signalKey: string,
  reason: string,
) {
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    event_type: "PAPER_ENTRY_RISK_BLOCKED",
    severity: "WARNING",
    message: "A paper entry was blocked by its capital and risk policy.",
    safe_metadata: { signalKey, reason },
  });
  return false;
}

async function heartbeat(
  strategy: JsonRow,
  state: string,
  safeErrorCode: string | null,
) {
  const { data: current } = await supabase
    .from("strategy_automation_runtime_state")
    .select("state_version")
    .eq("strategy_id", strategy.id)
    .maybeSingle();
  const { error } = await supabase
    .from("strategy_automation_runtime_state")
    .upsert(
      {
        strategy_id: strategy.id,
        owner_user_id: strategy.owner_user_id,
        runtime_state: state,
        state_version: Number(current?.state_version || 0) + 1,
        last_heartbeat_at: new Date().toISOString(),
        worker_id: workerId,
        lease_owner: workerId,
        lease_expires_at: new Date(
          Date.now() + leaseSeconds * 1000,
        ).toISOString(),
        safe_error_code: safeErrorCode,
      },
      { onConflict: "strategy_id" },
    );
  if (error) throw error;
}

async function markFailure(strategy: JsonRow, error: unknown) {
  const code = safeCode(error);
  console.error(
    JSON.stringify({
      level: "error",
      event: "strategy_automation_strategy_failed",
      strategyId: strategy.id,
      code,
    }),
  );
  await heartbeat(strategy, "ERROR", code).catch(() => undefined);
}

async function fetchBybitClosedCandles(
  symbol: string,
  timeframe: string,
  marketType: string,
): Promise<Candle[]> {
  const interval = bybitInterval(timeframe);
  const category = marketType === "SPOT" ? "spot" : "linear";
  const url = new URL("https://api.bybit.com/v5/market/kline");
  url.searchParams.set("category", category);
  url.searchParams.set(
    "symbol",
    String(symbol)
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase(),
  );
  url.searchParams.set("interval", interval.value);
  url.searchParams.set("limit", "500");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw Object.assign(new Error("Bybit public candle request failed."), {
      code: `MARKET_DATA_HTTP_${response.status}`,
    });
  const payload = await response.json();
  if (Number(payload.retCode) !== 0 || !Array.isArray(payload.result?.list))
    throw Object.assign(
      new Error("Bybit public candle payload was rejected."),
      { code: "MARKET_DATA_PAYLOAD_INVALID" },
    );
  const now = Date.now();
  return payload.result.list
    .map((row: string[]) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .filter(
      (candle: Candle) =>
        Number.isFinite(candle.close) &&
        candle.time * 1000 + interval.milliseconds <= now,
    )
    .sort((a: Candle, b: Candle) => a.time - b.time);
}

function bybitInterval(timeframe: string) {
  const normalized = String(timeframe).trim();
  const direct: Record<string, [string, number]> = {
    "1m": ["1", 60_000],
    "3m": ["3", 180_000],
    "5m": ["5", 300_000],
    "15m": ["15", 900_000],
    "30m": ["30", 1_800_000],
    "1h": ["60", 3_600_000],
    "2h": ["120", 7_200_000],
    "4h": ["240", 14_400_000],
    "6h": ["360", 21_600_000],
    "12h": ["720", 43_200_000],
    "1d": ["D", 86_400_000],
    "1D": ["D", 86_400_000],
    "1w": ["W", 604_800_000],
    "1W": ["W", 604_800_000],
    "1M": ["M", 2_419_200_000],
  };
  const match = direct[normalized];
  if (!match)
    throw Object.assign(new Error("Unsupported paper runtime timeframe."), {
      code: "TIMEFRAME_UNSUPPORTED",
    });
  return { value: match[0], milliseconds: match[1] };
}

function timeframeMilliseconds(timeframe: string) {
  return bybitInterval(timeframe).milliseconds;
}

function averageTrueRange(candles: Candle[], length: number) {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - Math.max(2, length));
  let total = 0;
  let count = 0;
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    total += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    count += 1;
  }
  return count ? total / count : 0;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await task(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function safeCode(error: unknown) {
  const raw = String(
    (error as any)?.code || (error as any)?.name || "STRATEGY_RUNTIME_FAILURE",
  )
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_");
  return raw.slice(0, 100);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
