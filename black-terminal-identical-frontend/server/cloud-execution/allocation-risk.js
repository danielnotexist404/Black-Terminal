const CLOUD_HEALTHY = new Set(["CONNECTED_CLOUD", "CONNECTED_HYBRID"]);

export function calculateFollowerAllocation({ intent, mandate, account, instrument, referencePrice, currentExposure = 0 }) {
  const equity = finite(account.equityUsd ?? account.totalEquityUsd);
  const availableMargin = finite(account.availableMarginUsd ?? account.availableBalanceUsd);
  const allocationValue = positive(mandate.allocation_value ?? mandate.allocationValue);
  const leverage = Math.max(1, finite(intent.leverage, 1));
  const price = positive(referencePrice);

  let requestedNotional;
  const method = mandate.allocation_method ?? mandate.allocationMethod;
  if (method === "EQUITY_PERCENT") requestedNotional = equity * allocationValue / 100;
  else if (method === "AVAILABLE_MARGIN_PERCENT") requestedNotional = availableMargin * allocationValue / 100 * leverage;
  else if (method === "FIXED_NOTIONAL") requestedNotional = allocationValue;
  else throw new Error(`Unsupported allocation method: ${method}`);

  const intentModel = intent.quantity_model ?? intent.quantityModel;
  const intentValue = positive(intent.quantity_value ?? intent.quantityValue, 1);
  if (intentModel === "EQUITY_PERCENT") requestedNotional = equity * intentValue / 100;
  if (intentModel === "FIXED_NOTIONAL") requestedNotional = intentValue;

  const maxOrder = positive(mandate.max_order_notional ?? mandate.maxOrderNotional, Infinity);
  const maxExposure = positive(mandate.max_total_exposure ?? mandate.maxTotalExposure, Infinity);
  const exposureHeadroom = Math.max(0, maxExposure - Math.max(0, finite(currentExposure)));
  const marginCapacity = Math.max(0, availableMargin * leverage);
  const targetNotional = Math.max(0, Math.min(requestedNotional, maxOrder, exposureHeadroom, marginCapacity));

  const quantityStep = positive(instrument.quantityStep ?? instrument.qtyStep, 0.00000001);
  const minimumQuantity = positive(instrument.minimumQuantity ?? instrument.minQuantity ?? instrument.minOrderQty, 0);
  const minimumNotional = positive(instrument.minimumNotional ?? instrument.minNotional ?? instrument.minNotionalValue, 0);
  const rawQuantity = targetNotional / price;
  const roundedQuantity = floorToStep(rawQuantity, quantityStep);
  const roundedNotional = roundedQuantity * price;
  const estimatedMargin = roundedNotional / leverage;

  return {
    calculatedEquity: equity,
    calculatedAvailableMargin: availableMargin,
    allocationPercent: method.endsWith("PERCENT") ? allocationValue : null,
    requestedNotional,
    targetNotional: roundedNotional,
    roundedQuantity,
    estimatedMargin,
    leverage,
    price,
    minimumQuantity,
    minimumNotional,
    quantityStep,
    belowMinimumQuantity: roundedQuantity < minimumQuantity,
    belowMinimumNotional: roundedNotional < minimumNotional,
    constrained: roundedNotional + 1e-9 < requestedNotional
  };
}

export function evaluateFollowerRisk({ intent, mandate, connection, capabilities, allocation, currentExposure = 0, dailyPnl = 0, drawdown = 0, now = new Date() }) {
  const reasons = [];
  const codes = [];
  const reject = (code, reason) => {
    codes.push(code);
    reasons.push(reason);
  };
  const status = mandate.status;
  if (status !== "ACTIVE") reject(status === "PAUSED" ? "MANDATE_PAUSED" : "MANDATE_INACTIVE", `Mandate status is ${status}.`);
  if (mandate.expires_at && Date.parse(mandate.expires_at) <= now.getTime()) reject("MANDATE_EXPIRED", "The execution mandate has expired.");
  if ((connection.connection_mode ?? connection.connectionMode) !== "CLOUD_DELEGATED" && (connection.connection_mode ?? connection.connectionMode) !== "HYBRID") {
    reject("CONNECTION_NOT_CLOUD", "The selected connection is not eligible for unattended execution.");
  }
  if (!CLOUD_HEALTHY.has(connection.health_status ?? connection.healthStatus)) reject("CONNECTION_UNHEALTHY", "The broker connection is not cloud-healthy.");
  if ((connection.control_state ?? connection.controlState ?? "ACTIVE") !== "ACTIVE") reject("EXECUTION_CONTROL_STOPPED", "New execution is paused by the connection owner.");
  if (!capabilities.can_execute_while_offline || !capabilities.can_receive_group_orders) reject("CAPABILITY_MISSING", "Offline group execution capability is unavailable.");
  if (capabilities.can_withdraw) reject("WITHDRAWAL_PERMISSION_FORBIDDEN", "Withdrawal-capable connections cannot receive group orders.");
  if (capabilities.can_transfer) reject("TRANSFER_PERMISSION_FORBIDDEN", "Transfer-capable connections cannot receive group orders.");
  if (intent.reduce_only && mandate.allow_close_positions === false) reject("CLOSE_PERMISSION_DENIED", "The mandate does not permit closing positions.");
  if (!intent.reduce_only && mandate.allow_open_positions === false) reject("OPEN_PERMISSION_DENIED", "The mandate does not permit opening positions.");
  if (mandate.protective_orders_required && !intent.stop_loss) reject("PROTECTION_REQUIRED", "The mandate requires a protective stop loss.");

  const symbol = String(intent.symbol || "").toUpperCase();
  if (!allows(mandate.allowed_symbols, symbol)) reject("SYMBOL_NOT_ALLOWED", `${symbol} is outside the mandate.`);
  if (!allows(mandate.allowed_market_types, intent.market_type)) reject("MARKET_NOT_ALLOWED", `${intent.market_type} is outside the mandate.`);
  if (!allows(mandate.allowed_order_types, intent.order_type)) reject("ORDER_TYPE_NOT_ALLOWED", `${intent.order_type} is outside the mandate.`);
  if (!allows(capabilities.supported_order_types, intent.order_type)) reject("ORDER_TYPE_UNSUPPORTED", `${intent.order_type} is not supported by this cloud adapter.`);
  if (finite(intent.leverage, 1) > finite(mandate.max_leverage, 1)) reject("LEVERAGE_LIMIT", "Requested leverage exceeds the mandate limit.");
  if (intent.reduce_only && !mandate.allow_reduce_only) reject("REDUCE_ONLY_NOT_ALLOWED", "Reduce-only actions are not permitted by this mandate.");
  if (allocation.belowMinimumQuantity) reject("MINIMUM_QUANTITY", "Calculated quantity is below the venue minimum.");
  if (allocation.belowMinimumNotional) reject("MINIMUM_NOTIONAL", "Calculated notional is below the venue minimum.");
  if (allocation.roundedQuantity <= 0) reject("ZERO_QUANTITY", "No executable quantity remains after allocation and precision rules.");
  if (allocation.estimatedMargin > allocation.calculatedAvailableMargin && !intent.reduce_only) reject("INSUFFICIENT_MARGIN", "Available margin is insufficient.");
  if (Math.max(0, currentExposure) + allocation.targetNotional > finite(mandate.max_total_exposure, Infinity) + 1e-9) reject("EXPOSURE_LIMIT", "The order would exceed maximum total exposure.");
  if (dailyPnl <= -Math.abs(finite(mandate.max_daily_loss, Infinity))) reject("DAILY_LOSS_LIMIT", "Maximum daily loss has been reached.");
  if (drawdown >= Math.abs(finite(mandate.max_drawdown, Infinity))) reject("DRAWDOWN_LIMIT", "Maximum drawdown has been reached.");
  if (Date.parse(intent.expires_at) <= now.getTime()) reject("INTENT_EXPIRED", "The group intent has expired.");
  if (Date.parse(intent.valid_from) > now.getTime()) reject("INTENT_NOT_ACTIVE", "The group intent is not active yet.");

  return { status: reasons.length ? "REJECTED" : "PASSED", codes, reasons };
}

export function floorToStep(value, step) {
  const precision = Math.min(12, Math.max(0, decimalPlaces(step)));
  return Number((Math.floor((value + Number.EPSILON) / step) * step).toFixed(precision));
}

function allows(raw, value) {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = list.map((entry) => String(entry).toUpperCase());
  return normalized.includes("*") || normalized.includes(String(value || "").toUpperCase());
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function decimalPlaces(value) {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1].length : 0;
}
