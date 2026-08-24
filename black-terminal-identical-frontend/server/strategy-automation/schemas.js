import { z } from "zod";
import { strategyError } from "./domain.js";

const uuid = z.string().uuid();
const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const positive = finite.positive();
const capitalPolicy = z.object({
  strategyAllocationMode: z.enum(["PERCENT_ACCOUNT_EQUITY", "FIXED_USDT"]),
  strategyAllocationValue: nonNegative,
  tradeAmountMode: z.enum(["PERCENT_ACCOUNT_EQUITY", "PERCENT_STRATEGY_ALLOCATION", "RISK_PERCENT", "FIXED_USDT", "FIXED_QUANTITY", "VOLATILITY_TARGET"]),
  tradeAmountValue: nonNegative,
  requestedLeverage: positive.max(1000).optional(),
  maximumLeverage: positive.max(1000).optional(),
  maximumPositionPercent: nonNegative.max(100),
  maximumExposurePercent: nonNegative.max(100),
  maximumDailyLoss: nonNegative,
  maximumDrawdown: nonNegative.max(100),
  maximumPositions: z.number().int().positive().max(1000),
  slippageBps: nonNegative.max(10000),
  marginMode: z.enum(["CROSS", "ISOLATED"]).optional(),
  quoteAssetReservePercent: nonNegative.max(100).optional(),
  maximumBaseAssetExposurePercent: nonNegative.max(100).optional()
}).strict();

const definition = z.object({
  runtimeKind: z.enum(["builtin-ema-cross", "builtin-adaptive-swing", "python-script", "external-signals"]),
  symbol: z.string().trim().min(2).max(40),
  timeframe: z.string().trim().min(1).max(12),
  marketType: z.enum(["SPOT", "FUTURES"]),
  exchange: z.string().trim().min(1).max(40).optional(),
  settings: z.record(z.unknown()).optional(),
  execution: z.record(z.unknown()).optional(),
  indicator: z.record(z.unknown()).optional(),
  signals: z.record(z.unknown()).optional(),
  filters: z.record(z.unknown()).optional(),
  exits: z.record(z.unknown()).optional(),
  schedule: z.record(z.unknown()).optional(),
  paper: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional()
}).strict();

export const strategySchemas = Object.freeze({
  create: z.object({ name: z.string().trim().min(1).max(80), definition, globalCapitalPolicy: capitalPolicy.optional() }).strict(),
  save: z.object({ name: z.string().trim().min(1).max(80).optional(), definition: definition.optional() }).strict(),
  archive: z.object({ expectedName: z.string().trim().min(1).max(80), expectedRevision: z.number().int().nonnegative() }).strict(),
  draft: z.object({ name: z.string().trim().min(1).max(80), definition, expectedRevision: z.number().int().nonnegative().optional() }).strict(),
  publish: z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
  startVersion: z.object({ version: z.number().int().positive() }).strict(),
  addTarget: z.object({ slotIndex: z.number().int().min(1).max(10), targetType: z.enum(["BROKER_ACCOUNT", "INVESTMENT_GROUP"]), targetId: uuid, marketType: z.enum(["SPOT", "FUTURES"]), capitalPolicy: capitalPolicy.optional() }).strict(),
  reorderTargets: z.object({ assignments: z.array(z.object({ bindingId: uuid, slotIndex: z.number().int().min(1).max(10), expectedVersion: z.number().int().positive() }).strict()).min(1).max(10) }).strict().superRefine((value, context) => {
    if (new Set(value.assignments.map((item) => item.bindingId)).size !== value.assignments.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assignments"], message: "Binding identifiers must be unique." });
    if (new Set(value.assignments.map((item) => item.slotIndex)).size !== value.assignments.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assignments"], message: "Target slots must be unique." });
  }),
  targetPolicy: z.object({ expectedVersion: z.number().int().positive(), capitalPolicy }).strict(),
  disconnect: z.object({ expectedVersion: z.number().int().positive(), disconnectPolicy: z.enum(["DETACH_MANUAL", "CLOSE_STRATEGY_POSITIONS", "KEEP_PROTECTED", "DISCONNECT_WHEN_FLAT"]).default("DETACH_MANUAL") }).strict(),
  paperPolicy: z.object({ expectedVersion: z.number().int().positive(), capitalPolicy }).strict(),
  paperTopUp: z.object({ expectedVersion: z.number().int().positive(), amount: positive.max(1_000_000_000) }).strict(),
  paperReset: z.object({ expectedVersion: z.number().int().positive(), demoEquity: positive.max(1_000_000_000).optional() }).strict(),
  paperControl: z.object({ expectedVersion: z.number().int().positive() }).strict(),
  targetControl: z.object({ expectedVersion: z.number().int().positive() }).strict()
});

export function parseStrategyBody(schema, value) {
  const result = schema.safeParse(value || {});
  if (!result.success) throw strategyError(400, "STRATEGY_REQUEST_INVALID", "Strategy request failed strict schema validation.", { issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  return result.data;
}
