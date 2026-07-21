import { z } from "zod";
import { httpError } from "./securityMiddleware.js";

const id = z.string().trim().min(1).max(160);
const secret = z.string().min(8).max(4096);
const symbol = z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9:_/.-]+$/);
const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();
const boolean = z.boolean();
const shortText = z.string().trim().max(160);
const marketKind = z.enum(["spot", "margin", "perpetual", "futures", "options", "swap"]);
const side = z.enum(["buy", "sell"]);
const orderType = z.enum(["market", "limit", "stop-market", "stop-limit", "trailing-stop", "bracket", "chase-limit", "twap", "iceberg", "pov", "scaled", "post-only"]);
const timeInForce = z.enum(["gtc", "ioc", "fok"]);
const marginMode = z.enum(["cross", "isolated", "portfolio"]);
const triggerSource = z.enum(["last", "mark", "index"]);
const destination = z.enum(["personal-portfolio", "allocation-engine", "simulation", "replay", "paper-trading"]);
const executionSource = z.enum(["chart", "order-ticket", "hotkey", "strategy", "ai-assistant", "capital-allocation", "replay-engine", "future-api", "positions"]);

const strategyParameters = z.object({
  durationSeconds: positive.optional(),
  intervalSeconds: positive.optional(),
  randomize: boolean.optional(),
  triggerPrice: positive.optional(),
  maxChasePrice: positive.optional(),
  chaseDistance: nonNegative.optional(),
  chasePercent: nonNegative.optional(),
  subSize: positive.optional(),
  orderCount: z.number().int().positive().max(10000).optional(),
  icebergPreference: z.enum(["maker", "taker", "offset", "fixed"]).optional(),
  povMode: z.enum(["TradedVolume", "OppositeSideLiquidity", "SameSideLiquidity"]).optional(),
  participationRate: positive.max(100).optional(),
  referenceWindowSeconds: positive.optional(),
  depthReference: positive.optional()
}).strict();

const orderShape = {
  accountId: id,
  exchange: shortText,
  symbol,
  marketKind: marketKind.optional(),
  side,
  orderType,
  quantity: positive,
  quantityMode: shortText.optional(),
  sizingMethod: shortText.optional(),
  referencePrice: positive.optional(),
  limitPrice: positive.optional(),
  stopPrice: positive.optional(),
  takeProfit: positive.optional(),
  stopLoss: positive.optional(),
  leverage: positive.max(1000).optional(),
  marginMode: marginMode.optional(),
  source: executionSource.optional(),
  destinations: z.array(destination).max(8).optional(),
  postOnly: boolean.optional(),
  reduceOnly: boolean.optional(),
  timeInForce: timeInForce.optional(),
  triggerBy: triggerSource.optional(),
  tpTriggerBy: triggerSource.optional(),
  slTriggerBy: triggerSource.optional(),
  tpslMode: z.enum(["full", "partial"]).optional(),
  positionIdx: z.number().int().min(0).max(2).optional(),
  slippageTolerancePercent: nonNegative.max(100).optional(),
  strategyParameters: strategyParameters.optional(),
  trailingStopEnabled: boolean.optional(),
  trailingTrailBy: positive.optional(),
  trailingMode: z.enum(["percentage", "usd", "ticks", "atr"]).optional(),
  trailingActivation: z.enum(["immediate", "custom-price", "offset"]).optional(),
  trailingActivationPrice: positive.optional(),
  internalOrderId: id.optional(),
  clientOrderId: id.optional(),
  mainnetConfirmed: boolean.optional(),
  liveConfirmation: shortText.optional()
};

const executionSchemas = {
  order: z.object(orderShape).strict(),
  cancel: z.object({
    orderId: id,
    venueOrderId: id.optional(),
    accountId: id.optional(),
    symbol: symbol.optional(),
    category: shortText.optional(),
    marketKind: marketKind.optional(),
    clientOrderId: id.optional(),
    mainnetConfirmed: boolean.optional(),
    liveConfirmation: shortText.optional()
  }).strict(),
  modify: z.object({
    localOrderId: id.optional(), orderId: id.optional(), exchangeOrderId: id.optional(), accountId: id, symbol,
    category: shortText.optional(), marketKind: marketKind.optional(), clientOrderId: id.optional(), quantity: positive.optional(),
    limitPrice: positive.optional(), stopPrice: positive.optional(), takeProfit: positive.optional(), stopLoss: positive.optional(),
    mainnetConfirmed: boolean.optional(), liveConfirmation: shortText.optional()
  }).strict().refine((value) => Boolean(value.localOrderId || value.orderId || value.exchangeOrderId), "An order identifier is required"),
  "cancel-all": z.object({ accountId: id, symbol, marketKind: marketKind.optional(), mainnetConfirmed: boolean.optional(), liveConfirmation: shortText.optional() }).strict(),
  "position-action": z.object({
    accountId: id, symbol, action: z.enum(["close", "reverse"]), direction: z.enum(["long", "short"]).optional(),
    quantity: positive.optional(), marketKind: marketKind.optional(), clientOrderId: id.optional(), mainnetConfirmed: boolean.optional(), liveConfirmation: shortText.optional()
  }).strict(),
  protection: z.object({
    accountId: id, symbol, marketKind: marketKind.optional(), positionIdx: z.number().int().min(0).max(2).optional(),
    takeProfit: positive.optional(), stopLoss: positive.optional(), trailingStop: nonNegative.optional(), trailingActivationPrice: positive.optional(),
    cancelTakeProfit: boolean.optional(), cancelStopLoss: boolean.optional(), cancelTrailingStop: boolean.optional(),
    tpslMode: z.enum(["full", "partial"]).optional(), tpTriggerBy: triggerSource.optional(), slTriggerBy: triggerSource.optional(),
    mainnetConfirmed: boolean.optional(), liveConfirmation: shortText.optional()
  }).strict(),
  "account-mode": z.object({
    accountId: id, action: z.enum(["set-leverage", "switch-margin-mode", "switch-position-mode"]), symbol: symbol.optional(),
    settleCoin: shortText.optional(), category: z.enum(["linear", "inverse"]).optional(), leverage: positive.max(1000).optional(),
    buyLeverage: positive.max(1000).optional(), sellLeverage: positive.max(1000).optional(), marginMode: marginMode.optional(),
    positionMode: z.enum(["one-way", "hedge"]).optional(), mainnetConfirmed: boolean.optional(), liveConfirmation: shortText.optional()
  }).strict(),
  strategy: z.object({ accountId: id, strategyId: id, symbol, mainnetConfirmed: boolean.optional(), liveConfirmation: shortText.optional() }).strict()
};

const exchangeSchemas = {
  connect: z.object({ exchange: z.literal("bybit"), accountName: shortText.min(1), apiKey: secret, apiSecret: secret, passphrase: secret.optional(), network: z.enum(["mainnet", "testnet"]).optional() }).strict(),
  diagnostics: z.object({ accountId: id, symbol: symbol.optional() }).strict(),
  sync: z.object({ accountId: id, symbol: symbol.optional(), marketKind: marketKind.optional() }).strict(),
  "mainnet-validation": z.object({ accountId: id, action: z.enum(["enable", "disable"]), confirmation: shortText }).strict()
};

const hyperliquidSchemas = {
  connect: z.object({ masterWalletAddress: shortText.min(1), agentPrivateKey: secret, network: z.enum(["testnet", "mainnet"]), accountName: shortText.optional(), mainnetConfirmed: boolean.optional() }).strict(),
  order: z.object(orderShape).strict(),
  modify: z.object({ ...orderShape, orderId: id.optional() }).strict().refine((value) => Boolean(value.orderId || value.clientOrderId), "An order identifier is required"),
  cancel: z.object({ accountId: id, symbol, orderId: id.optional(), clientOrderId: id.optional(), mainnetConfirmed: boolean.optional() }).strict().refine((value) => Boolean(value.orderId || value.clientOrderId), "An order identifier is required"),
  "close-position": z.object({ accountId: id, symbol, quantity: positive.optional(), referencePrice: positive.optional(), orderType: orderType.optional(), timeInForce: timeInForce.optional(), mainnetConfirmed: boolean.optional() }).strict(),
  sync: z.object({ accountId: id }).strict()
};

const cloudSchemas = {
  connection: z.object({ accountId: id, confirmation: z.literal("ENABLE OFFLINE CLOUD EXECUTION") }).strict(),
  control: z.object({ connectionId: id, action: z.enum(["pause", "resume", "emergency-stop"]), reason: shortText.optional() }).strict(),
  intent: z.object({
    groupId: id, strategyId: id.optional(), clientIntentId: id, symbol, marketType: shortText.min(1), side, orderType: shortText.min(1),
    limitPrice: positive.optional(), stopPrice: positive.optional(), quantityModel: shortText.min(1), quantityValue: positive,
    leverage: positive.max(1000).optional(), marginMode: shortText.optional(), timeInForce: shortText.optional(), reduceOnly: boolean.optional(),
    takeProfit: positive.optional(), stopLoss: positive.optional(), trailingStop: z.union([nonNegative, z.record(z.unknown())]).optional(),
    validFrom: z.union([z.string().datetime({ offset: true }), z.number().int().nonnegative()]).optional(),
    expiresAt: z.string().datetime({ offset: true }), mandatePolicyVersion: z.number().int().positive().optional(), supersedesIntentId: id.optional()
  }).strict(),
  mandate: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"), groupId: id, connectionId: id, executionMode: z.enum(["CLOUD_DELEGATED", "HYBRID"]).optional(),
      allocationMethod: shortText.min(1), allocationValue: positive, maxOrderNotional: positive, maxTotalExposure: positive,
      maxDailyLoss: positive, maxDrawdown: positive, maxLeverage: positive.max(1000), allowedSymbols: z.array(symbol).min(1).max(500),
      allowedMarketTypes: z.array(shortText.min(1)).min(1).max(20), allowedOrderTypes: z.array(shortText.min(1)).min(1).max(40),
      allowOvernight: boolean.optional(), allowWeekend: boolean.optional(), allowReduceOnly: boolean.optional(), allowPositionReversal: boolean.optional(),
      allowOpenPositions: boolean.optional(), allowClosePositions: boolean.optional(), allowModifyProtection: boolean.optional(),
      protectiveOrdersRequired: boolean.optional(), slippageLimitBps: nonNegative.max(10000).optional(), expiresAt: z.string().datetime({ offset: true }).optional()
    }).strict(),
    z.object({ action: z.literal("accept"), mandateId: id, confirmation: z.literal("AUTHORIZE OFFLINE GROUP EXECUTION") }).strict(),
    z.object({ action: z.literal("pause"), mandateId: id }).strict(),
    z.object({ action: z.literal("revoke"), mandateId: id }).strict()
  ])
};

const schemaFamilies = { execution: executionSchemas, exchange: exchangeSchemas, hyperliquid: hyperliquidSchemas, cloud: cloudSchemas };

export function validateTradingRequest(req, family, action) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return;
  const schema = schemaFamilies[family]?.[action];
  if (!schema) throw httpError(400, "Unsupported trading command schema.", "INVALID_TRADING_COMMAND");
  const result = schema.safeParse(req.body);
  if (!result.success) throw httpError(400, "Trading command failed strict schema validation.", "INVALID_TRADING_COMMAND");
  req.body = result.data;
}

export const tradingSchemasForTests = schemaFamilies;
