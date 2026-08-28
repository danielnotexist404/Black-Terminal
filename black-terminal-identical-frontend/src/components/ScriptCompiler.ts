import type { Candle } from "../chart-engine/types";
import {
  defaultStrategyRuntimeConfig,
  simulateStrategy,
  type CompiledStrategyReport,
  type StrategyInstruction,
  type StrategyRuntimeConfig
} from "./ScriptStrategyEngine.ts";

export const BLACK_TERMINAL_PYTHON_RUNTIME_VERSION = "black-script-v3";

export type CompiledPlot = {
  name: string;
  values: (number | null)[];
  color: string;
  width: number;
  pane: "price" | "oscillator";
  visible: boolean;
};

export type CompiledMarker = {
  id: string;
  index: number;
  time: number;
  /** Exact finalized signal price. `value` remains the visual marker anchor. */
  signalPrice: number;
  value: number;
  label: string;
  direction: "long" | "short" | "neutral";
  kind: "shape" | "entry" | "exit";
  strategyRole?: "entry" | "takeProfit" | "stopLoss" | "close" | "reversal" | "exit";
  color: string;
};

export type CompiledAlertCondition = {
  id: string;
  title: string;
  message: string;
};

export type CompiledScriptEvent = {
  id: string;
  conditionId: string;
  index: number;
  time: number;
  price: number;
  title: string;
  message: string;
  type: "alert" | "entry" | "exit";
  direction: "long" | "short" | "neutral";
};

export type CompiledScriptActivation = {
  id: string;
  name: string;
  kind: "indicator" | "strategy";
  source: string;
  sourceHash: string;
  inputFeed: "SOURCE_OHLCV" | "CAUSAL_RENKO";
  inputValues?: Record<string, ScriptInputValue>;
  visible?: boolean;
};

export type ScriptInputValue = number | boolean | string;

export type CompiledScriptInput = {
  key: string;
  variable: string;
  label: string;
  type: "int" | "float" | "bool" | "string" | "color";
  defaultValue: ScriptInputValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ScriptInputValue[];
  group?: string;
  tooltip?: string;
};

export type CompileResult = {
  success: boolean;
  errors: { line: number; message: string }[];
  plots: CompiledPlot[];
  markers: CompiledMarker[];
  alertConditions: CompiledAlertCondition[];
  events: CompiledScriptEvent[];
  strategy: CompiledStrategyReport | null;
  runtimeVersion: typeof BLACK_TERMINAL_PYTHON_RUNTIME_VERSION;
  sourceHash: string;
};

type Scalar = number | boolean | string | null;
type SeriesScalar = number | boolean | null;
type RuntimeTuple = { kind: "tuple"; values: RuntimeValue[] };
type RuntimeValue = Scalar | SeriesScalar[] | RuntimeTuple;
type CallArguments = { positional: RuntimeValue[]; named: Record<string, RuntimeValue> };

type Token = {
  type: "number" | "string" | "identifier" | "operator" | "punctuation" | "eof";
  value: string;
};

const forbiddenStatement = /^(?:async\s+def|def|class|import|from|for|while|if|elif|else|try|except|finally|with|lambda|yield|raise|global|nonlocal|del|assert|match|case)\b/;
const allowedStandaloneCalls = new Set([
  "plot",
  "plotshape",
  "alertcondition",
  "alert",
  "strategy",
  "strategy.entry",
  "strategy.order",
  "strategy.exit",
  "strategy.close",
  "strategy.close_all",
  "strategy.cancel",
  "strategy.cancel_all"
]);

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isSeries(value: RuntimeValue): value is SeriesScalar[] {
  return Array.isArray(value);
}

function isTuple(value: RuntimeValue): value is RuntimeTuple {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "kind" in value && value.kind === "tuple");
}

function finiteNumber(value: RuntimeValue, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function positivePeriod(value: RuntimeValue, label = "period") {
  const period = Math.round(finiteNumber(value, label));
  if (period < 1 || period > 100_000) throw new Error(`${label} must be between 1 and 100000`);
  return period;
}

function textValue(value: RuntimeValue | undefined, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanValue(value: SeriesScalar | Scalar) {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  return Boolean(value);
}

function numberValue(value: SeriesScalar | Scalar): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

function broadcast(value: RuntimeValue, length: number): SeriesScalar[] {
  if (isSeries(value)) {
    if (value.length !== length) throw new Error(`Series length ${value.length} does not match candle length ${length}`);
    return value;
  }
  if (isTuple(value)) throw new Error("Tuple values must be destructured before numeric use");
  if (typeof value === "string") throw new Error("Text cannot be used as a numeric or boolean series");
  return Array.from({ length }, () => value);
}

function inferredTimeframeSeconds(candles: readonly Candle[]) {
  const differences: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const difference = candles[index].time - candles[index - 1].time;
    if (Number.isFinite(difference) && difference > 0) differences.push(difference);
  }
  if (differences.length === 0) return 0;
  differences.sort((left, right) => left - right);
  return differences[Math.floor(differences.length / 2)]!;
}

function mapUnary(value: RuntimeValue, length: number, operation: (entry: SeriesScalar) => SeriesScalar): RuntimeValue {
  if (isTuple(value)) throw new Error("Tuple values cannot be used with unary operators");
  if (!isSeries(value)) return operation(value as SeriesScalar);
  return broadcast(value, length).map(operation);
}

function mapBinary(
  left: RuntimeValue,
  right: RuntimeValue,
  length: number,
  operation: (a: SeriesScalar | string, b: SeriesScalar | string) => SeriesScalar
): RuntimeValue {
  if (isTuple(left) || isTuple(right)) throw new Error("Tuple values cannot be used with binary operators");
  if (!isSeries(left) && !isSeries(right)) return operation(left, right);
  const a = broadcast(left, length);
  const b = broadcast(right, length);
  return a.map((entry, index) => operation(entry, b[index]));
}

function stripInlineComment(line: string) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}

type LogicalStatement = { line: number; source: string };

/**
 * Black Script v3 accepts Python-style multiline calls and parenthesized
 * expressions. Statements are joined before tokenization while retaining the
 * first physical line for precise compiler diagnostics.
 */
function collectLogicalStatements(script: string): { statements: LogicalStatement[]; error?: { line: number; message: string } } {
  const physicalLines = script.replaceAll("\r\n", "\n").split("\n");
  const statements: LogicalStatement[] = [];
  let source = "";
  let startLine = 1;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < physicalLines.length; index += 1) {
    const physicalLine = stripInlineComment(physicalLines[index]);
    const trimmed = physicalLine.trim();
    if (!source && !trimmed) continue;
    if (!source) startLine = index + 1;
    const continued = trimmed.endsWith("\\");
    const fragment = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    source += `${source ? " " : ""}${fragment}`;

    for (let cursor = 0; cursor < fragment.length; cursor += 1) {
      const character = fragment[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && quote) {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") depth -= 1;
      if (depth < 0) return { statements, error: { line: index + 1, message: "Unexpected closing bracket" } };
    }

    if (depth === 0 && !continued && !quote) {
      if (source.trim()) statements.push({ line: startLine, source: source.trim() });
      source = "";
    }
  }

  if (quote) return { statements, error: { line: startLine, message: "Unterminated string literal" } };
  if (depth !== 0) return { statements, error: { line: startLine, message: "Unclosed parenthesized expression" } };
  if (source.trim()) statements.push({ line: startLine, source: source.trim() });
  return { statements };
}

function assignmentIndex(line: string) {
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "=" && depth === 0 && line[index - 1] !== "=" && line[index + 1] !== "=" && line[index - 1] !== "!" && line[index - 1] !== "<" && line[index - 1] !== ">") return index;
  }
  return -1;
}

class Tokenizer {
  private index = 0;
  private tokens: Token[] = [];

  constructor(source: string) {
    while (this.index < source.length) {
      const character = source[this.index];
      if (/\s/.test(character)) {
        this.index += 1;
        continue;
      }
      if (/\d/.test(character) || (character === "." && /\d/.test(source[this.index + 1] || ""))) {
        const start = this.index;
        this.index += 1;
        while (/[\d.eE_+-]/.test(source[this.index] || "")) {
          const candidate = source.slice(start, this.index + 1).replaceAll("_", "");
          if (!Number.isFinite(Number(candidate)) && !/[eE][+-]?$/.test(candidate)) break;
          this.index += 1;
        }
        this.tokens.push({ type: "number", value: source.slice(start, this.index).replaceAll("_", "") });
        continue;
      }
      if (character === '"' || character === "'") {
        const quote = character;
        this.index += 1;
        let value = "";
        let closed = false;
        while (this.index < source.length) {
          const next = source[this.index++];
          if (next === "\\") {
            const escaped = source[this.index++];
            value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          } else if (next === quote) {
            closed = true;
            break;
          } else value += next;
        }
        if (!closed) throw new Error("Unterminated string literal");
        this.tokens.push({ type: "string", value });
        continue;
      }
      if (/[A-Za-z_]/.test(character)) {
        const start = this.index;
        this.index += 1;
        while (/[A-Za-z0-9_.]/.test(source[this.index] || "")) this.index += 1;
        const value = source.slice(start, this.index);
        this.tokens.push({ type: ["and", "or", "not", "if", "else"].includes(value) ? "operator" : "identifier", value });
        continue;
      }
      const pair = source.slice(this.index, this.index + 2);
      if (["==", "!=", "<=", ">=", "**", "//"].includes(pair)) {
        this.tokens.push({ type: "operator", value: pair });
        this.index += 2;
        continue;
      }
      if (["+", "-", "*", "/", "%", "<", ">", "="].includes(character)) {
        this.tokens.push({ type: "operator", value: character });
        this.index += 1;
        continue;
      }
      if (["(", ")", "[", "]", ","].includes(character)) {
        this.tokens.push({ type: "punctuation", value: character });
        this.index += 1;
        continue;
      }
      throw new Error(`Unsupported character '${character}'`);
    }
    this.tokens.push({ type: "eof", value: "" });
  }

  all() {
    return this.tokens;
  }
}

class ExpressionParser {
  private cursor = 0;
  private readonly runtime: ScriptRuntime;
  private readonly tokens: Token[];
  private readonly line: number;

  constructor(runtime: ScriptRuntime, tokens: Token[], line: number) {
    this.runtime = runtime;
    this.tokens = tokens;
    this.line = line;
  }

  parse() {
    const value = this.parseConditional();
    if (this.peek().type !== "eof") throw new Error(`Unexpected token '${this.peek().value}'`);
    return value;
  }

  private parseConditional(): RuntimeValue {
    const whenTrue = this.parseOr();
    if (!this.match("if")) return whenTrue;
    const condition = this.parseOr();
    this.consume("else");
    const whenFalse = this.parseConditional();
    return this.runtime.call("select", { positional: [condition, whenTrue, whenFalse], named: {} }, this.line);
  }

  private peek(offset = 0) {
    return this.tokens[this.cursor + offset] ?? this.tokens.at(-1)!;
  }

  private consume(value?: string) {
    const token = this.peek();
    if (value !== undefined && token.value !== value) throw new Error(`Expected '${value}', received '${token.value || "end of line"}'`);
    this.cursor += 1;
    return token;
  }

  private match(value: string) {
    if (this.peek().value !== value) return false;
    this.cursor += 1;
    return true;
  }

  private parseOr(): RuntimeValue {
    let value = this.parseAnd();
    while (this.match("or")) value = this.runtime.binary("or", value, this.parseAnd());
    return value;
  }

  private parseAnd(): RuntimeValue {
    let value = this.parseComparison();
    while (this.match("and")) value = this.runtime.binary("and", value, this.parseComparison());
    return value;
  }

  private parseComparison(): RuntimeValue {
    let value = this.parseAdditive();
    while (["==", "!=", "<", "<=", ">", ">="].includes(this.peek().value)) {
      const operator = this.consume().value;
      value = this.runtime.binary(operator, value, this.parseAdditive());
    }
    return value;
  }

  private parseAdditive(): RuntimeValue {
    let value = this.parseMultiplicative();
    while (["+", "-"].includes(this.peek().value)) {
      const operator = this.consume().value;
      value = this.runtime.binary(operator, value, this.parseMultiplicative());
    }
    return value;
  }

  private parseMultiplicative(): RuntimeValue {
    let value = this.parseUnary();
    while (["*", "/", "//", "%", "**"].includes(this.peek().value)) {
      const operator = this.consume().value;
      value = this.runtime.binary(operator, value, this.parseUnary());
    }
    return value;
  }

  private parseUnary(): RuntimeValue {
    if (this.match("not")) return this.runtime.unary("not", this.parseUnary());
    if (this.match("-")) return this.runtime.unary("-", this.parseUnary());
    if (this.match("+")) return this.runtime.unary("+", this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): RuntimeValue {
    const token = this.consume();
    if (token.type === "number") {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new Error(`Invalid number '${token.value}'`);
      return value;
    }
    if (token.type === "string") return token.value;
    if (token.type === "identifier") {
      let value: RuntimeValue;
      if (this.match("(")) {
        const positional: RuntimeValue[] = [];
        const named: Record<string, RuntimeValue> = {};
        if (!this.match(")")) {
          while (true) {
            if (this.peek().type === "identifier" && this.peek(1).value === "=") {
              const name = this.consume().value;
              this.consume("=");
              named[name] = this.parseConditional();
            } else positional.push(this.parseConditional());
            if (!this.match(",") || this.peek().value === ")") break;
          }
          this.consume(")");
        }
        value = this.runtime.call(token.value, { positional, named }, this.line);
      } else value = this.runtime.resolve(token.value);
      while (this.match("[")) {
        const offset = this.parseConditional();
        this.consume("]");
        value = this.runtime.index(value, offset);
      }
      return value;
    }
    if (token.value === "(") {
      const value = this.parseConditional();
      this.consume(")");
      return value;
    }
    if (token.value === "[") {
      const values: RuntimeValue[] = [];
      if (!this.match("]")) {
        while (true) {
          values.push(this.parseConditional());
          if (!this.match(",") || this.peek().value === "]") break;
        }
        this.consume("]");
      }
      return { kind: "tuple", values };
    }
    throw new Error(`Unexpected token '${token.value || "end of line"}'`);
  }
}

class ScriptRuntime {
  readonly plots: CompiledPlot[] = [];
  readonly markers: CompiledMarker[] = [];
  readonly alertConditions: CompiledAlertCondition[] = [];
  readonly events: CompiledScriptEvent[] = [];
  readonly strategyInstructions: StrategyInstruction[] = [];
  strategyConfig: StrategyRuntimeConfig = { ...defaultStrategyRuntimeConfig };
  private readonly env = new Map<string, RuntimeValue>();
  private readonly candles: Candle[];
  private readonly sourceHash: string;
  private readonly inputValues: Readonly<Record<string, ScriptInputValue>>;

  constructor(
    candles: Candle[],
    sourceHash: string,
    inputValues: Readonly<Record<string, ScriptInputValue>>,
    strategyState?: Pick<CompiledStrategyReport, "positionSize" | "positionAveragePrice" | "equityCurve" | "openProfit" | "netProfit">
  ) {
    this.candles = candles;
    this.sourceHash = sourceHash;
    this.inputValues = inputValues;
    this.env.set("open", candles.map((candle) => candle.open));
    this.env.set("high", candles.map((candle) => candle.high));
    this.env.set("low", candles.map((candle) => candle.low));
    this.env.set("close", candles.map((candle) => candle.close));
    this.env.set("volume", candles.map((candle) => candle.volume));
    this.env.set("hl2", candles.map((candle) => (candle.high + candle.low) / 2));
    this.env.set("hlc3", candles.map((candle) => (candle.high + candle.low + candle.close) / 3));
    this.env.set("ohlc4", candles.map((candle) => (candle.open + candle.high + candle.low + candle.close) / 4));
    this.env.set("timeframe_seconds", inferredTimeframeSeconds(candles));
    this.env.set("strategy.position_size", strategyState?.positionSize ?? Array(candles.length).fill(0));
    this.env.set("strategy.position_avg_price", strategyState?.positionAveragePrice ?? Array(candles.length).fill(0));
    this.env.set("strategy.equity", strategyState?.equityCurve ?? Array(candles.length).fill(defaultStrategyRuntimeConfig.initialCapital));
    this.env.set("strategy.openprofit", strategyState?.openProfit ?? Array(candles.length).fill(0));
    this.env.set("strategy.netprofit", strategyState?.netProfit ?? Array(candles.length).fill(0));
  }

  assign(name: string, value: RuntimeValue) {
    const tupleMatch = name.match(/^\s*[\[(]\s*([^)\]]+)\s*[\])]\s*$/);
    if (tupleMatch) {
      if (!isTuple(value)) throw new Error("Tuple assignment requires a tuple-valued expression");
      const variables = tupleMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean);
      if (variables.length !== value.values.length) throw new Error(`Tuple assignment expected ${variables.length} values, received ${value.values.length}`);
      variables.forEach((variable, index) => this.assign(variable, value.values[index]));
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name '${name}'`);
    if (["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "timeframe_seconds"].includes(name)) throw new Error(`Built-in series '${name}' is read-only`);
    this.env.set(name, value);
  }

  resolve(name: string): RuntimeValue {
    if (name === "True" || name === "true") return true;
    if (name === "False" || name === "false") return false;
    if (name === "None" || name === "none") return null;
    if (name === "strategy.long") return "long";
    if (name === "strategy.short") return "short";
    if (name === "strategy.fixed") return "fixed";
    if (name === "strategy.cash") return "cash";
    if (name === "strategy.percent_of_equity") return "percent_of_equity";
    if (name === "strategy.commission.percent") return "percent";
    if (name === "strategy.commission.cash_per_order") return "cash_per_order";
    if (name === "strategy.commission.cash_per_contract") return "cash_per_contract";
    const value = this.env.get(name);
    if (value === undefined) throw new Error(`Undefined variable '${name}'`);
    return value;
  }

  unary(operator: string, value: RuntimeValue): RuntimeValue {
    if (operator === "not") return mapUnary(value, this.candles.length, (entry) => !booleanValue(entry));
    return mapUnary(value, this.candles.length, (entry) => {
      const numeric = numberValue(entry);
      return numeric === null ? null : operator === "-" ? -numeric : numeric;
    });
  }

  binary(operator: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
    return mapBinary(left, right, this.candles.length, (a, b) => {
      if (operator === "and") return booleanValue(a) && booleanValue(b);
      if (operator === "or") return booleanValue(a) || booleanValue(b);
      if (operator === "==") return a === b;
      if (operator === "!=") return a !== b;
      const leftNumber = numberValue(a);
      const rightNumber = numberValue(b);
      if (leftNumber === null || rightNumber === null) return operator === "<" || operator === "<=" || operator === ">" || operator === ">=" ? false : null;
      if (operator === "+") return leftNumber + rightNumber;
      if (operator === "-") return leftNumber - rightNumber;
      if (operator === "*") return leftNumber * rightNumber;
      if (operator === "/") return rightNumber === 0 ? null : leftNumber / rightNumber;
      if (operator === "//") return rightNumber === 0 ? null : Math.floor(leftNumber / rightNumber);
      if (operator === "%") return rightNumber === 0 ? null : leftNumber % rightNumber;
      if (operator === "**") {
        const output = Math.pow(leftNumber, rightNumber);
        return Number.isFinite(output) ? output : null;
      }
      if (operator === "<") return leftNumber < rightNumber;
      if (operator === "<=") return leftNumber <= rightNumber;
      if (operator === ">") return leftNumber > rightNumber;
      if (operator === ">=") return leftNumber >= rightNumber;
      throw new Error(`Unsupported operator '${operator}'`);
    });
  }

  index(value: RuntimeValue, offset: RuntimeValue): RuntimeValue {
    const index = Math.round(finiteNumber(offset, "history offset"));
    if (index < 0 || index > 100_000) throw new Error("History offset must be between 0 and 100000");
    if (isTuple(value)) {
      if (index >= value.values.length) throw new Error(`Tuple index ${index} is outside ${value.values.length} values`);
      return value.values[index];
    }
    if (!isSeries(value)) return value;
    return value.map((_entry, cursor) => cursor < index ? null : value[cursor - index]);
  }

  call(name: string, args: CallArguments, line: number): RuntimeValue {
    if (name === "input.int" || name === "input.float" || name === "input.bool" || name === "input.string" || name === "input.color") {
      return this.input(name.slice("input.".length) as CompiledScriptInput["type"], args);
    }
    if (name === "ta.sma") return this.rolling(args, "sma");
    if (name === "ta.ema") return this.ema(args);
    if (name === "ta.wma") return this.wma(args);
    if (name === "ta.rma") return this.rma(args);
    if (name === "ta.hma") return this.hma(args);
    if (name === "ta.cum") return this.cumulative(args);
    if (name === "ta.rsi") return this.rsi(args);
    if (name === "ta.macd") return this.macd(args);
    if (name === "ta.stoch") return this.stochastic(args);
    if (name === "ta.mfi") return this.moneyFlowIndex(args);
    if (name === "ta.cci") return this.commodityChannelIndex(args);
    if (name === "ta.vwma") return this.volumeWeightedMovingAverage(args);
    if (name === "ta.atr") return this.atr(args);
    if (name === "ta.stdev") return this.rolling(args, "stdev");
    if (name === "ta.highest") return this.rolling(args, "highest");
    if (name === "ta.lowest") return this.rolling(args, "lowest");
    if (name === "ta.percentile_linear_interpolation") return this.percentileLinearInterpolation(args);
    if (name === "ta.shift") return this.shift(args);
    if (name === "ta.change") return this.change(args);
    if (name === "ta.crossover") return this.cross(args, "over");
    if (name === "ta.crossunder") return this.cross(args, "under");
    if (name === "math.abs") return mapUnary(args.positional[0] ?? null, this.candles.length, (entry) => {
      const numeric = numberValue(entry);
      return numeric === null ? null : Math.abs(numeric);
    });
    if (name === "math.sqrt") return mapUnary(args.positional[0] ?? null, this.candles.length, (entry) => {
      const numeric = numberValue(entry);
      return numeric === null || numeric < 0 ? null : Math.sqrt(numeric);
    });
    if (["math.round", "math.floor", "math.ceil", "math.sign", "math.log", "math.exp"].includes(name)) {
      return mapUnary(args.positional[0] ?? null, this.candles.length, (entry) => {
        const numeric = numberValue(entry);
        if (numeric === null || (name === "math.log" && numeric <= 0)) return null;
        if (name === "math.round") return Math.round(numeric);
        if (name === "math.floor") return Math.floor(numeric);
        if (name === "math.ceil") return Math.ceil(numeric);
        if (name === "math.sign") return Math.sign(numeric);
        if (name === "math.log") return Math.log(numeric);
        return Math.exp(numeric);
      });
    }
    if (name === "math.pow") return mapBinary(args.positional[0] ?? null, args.positional[1] ?? null, this.candles.length, (left, right) => {
      const base = numberValue(left);
      const exponent = numberValue(right);
      if (base === null || exponent === null) return null;
      const output = Math.pow(base, exponent);
      return Number.isFinite(output) ? output : null;
    });
    if (name === "math.max" || name === "math.min") {
      if (args.positional.length < 2) throw new Error(`${name} requires at least two values`);
      return args.positional.slice(1).reduce<RuntimeValue>((result, value) => mapBinary(
        result,
        value,
        this.candles.length,
        (left, right) => {
          const leftNumber = numberValue(left);
          const rightNumber = numberValue(right);
          if (leftNumber === null || rightNumber === null) return null;
          return name === "math.max" ? Math.max(leftNumber, rightNumber) : Math.min(leftNumber, rightNumber);
        }
      ), args.positional[0]!);
    }
    if (name === "select") {
      const condition = args.positional[0] ?? false;
      const whenTrue = args.positional[1] ?? null;
      const whenFalse = args.positional[2] ?? null;
      if (isTuple(condition)) throw new Error("select condition cannot be a tuple");
      if (!isSeries(condition)) return booleanValue(condition) ? whenTrue : whenFalse;
      const conditions = broadcast(condition, this.candles.length);
      const truthy = broadcast(whenTrue, this.candles.length);
      const falsy = broadcast(whenFalse, this.candles.length);
      return conditions.map((entry, index) => booleanValue(entry) ? truthy[index] : falsy[index]);
    }
    if (name === "nz") return this.nz(args);
    if (name === "plot") return this.plot(args);
    if (name === "plotshape") return this.plotShape(args);
    if (name === "alertcondition") return this.alertCondition(args, line);
    if (name === "alert") return this.alert(args, line);
    if (name === "strategy") return this.configureStrategy(args);
    if (name === "strategy.entry") return this.strategyEntry(args, line);
    if (name === "strategy.order") return this.strategyEntry(args, line);
    if (name === "strategy.exit") return this.strategyExit(args, line);
    if (name === "strategy.close") return this.strategyClose(args, line, false);
    if (name === "strategy.close_all") return this.strategyClose(args, line, true);
    if (name === "strategy.cancel") return this.strategyCancel(args, line, false);
    if (name === "strategy.cancel_all") return this.strategyCancel(args, line, true);
    throw new Error(`Function '${name}' is not available in ${BLACK_TERMINAL_PYTHON_RUNTIME_VERSION}`);
  }

  private input(type: CompiledScriptInput["type"], args: CallArguments): RuntimeValue {
    const label = textValue(args.positional[1] ?? args.named.title, "");
    const configured = label ? this.inputValues[label] : undefined;
    const value = configured === undefined ? args.positional[0] : configured;
    const options = isTuple(args.named.options) ? args.named.options.values.filter((option): option is Scalar => !isSeries(option) && !isTuple(option)) : [];
    if (type === "string" || type === "color") {
      const selected = typeof value === "string" ? value : textValue(args.positional[0], "");
      return options.length && !options.includes(selected) ? textValue(args.positional[0], "") : selected;
    }
    if (type === "bool") return typeof value === "boolean" ? value : Boolean(value ?? false);
    const numeric = typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof args.positional[0] === "number" && Number.isFinite(args.positional[0])
        ? args.positional[0]
        : 0;
    const minimum = typeof args.named.minval === "number" ? args.named.minval : Number.NEGATIVE_INFINITY;
    const maximum = typeof args.named.maxval === "number" ? args.named.maxval : Number.POSITIVE_INFINITY;
    const clamped = Math.min(maximum, Math.max(minimum, numeric));
    const selected = type === "int" ? Math.round(clamped) : clamped;
    return options.length && !options.includes(selected) ? Number(args.positional[0] ?? 0) : selected;
  }

  private numericSeries(value: RuntimeValue, _label: string) {
    return broadcast(value, this.candles.length).map((entry) => numberValue(entry));
  }

  private conditionSeries(value: RuntimeValue) {
    return broadcast(value, this.candles.length).map(booleanValue);
  }

  private rolling(args: CallArguments, mode: "sma" | "stdev" | "highest" | "lowest"): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 14);
    return source.map((_entry, index) => {
      if (index < period - 1) return null;
      const window = source.slice(index - period + 1, index + 1);
      if (window.some((value) => value === null)) return null;
      const numeric = window as number[];
      if (mode === "highest") return Math.max(...numeric);
      if (mode === "lowest") return Math.min(...numeric);
      const mean = numeric.reduce((sum, value) => sum + value, 0) / period;
      if (mode === "sma") return mean;
      return Math.sqrt(numeric.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
    });
  }

  private ema(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 14);
    const alpha = 2 / (period + 1);
    let previous: number | null = null;
    return source.map((value) => {
      if (value === null) return null;
      previous = previous === null ? value : value * alpha + previous * (1 - alpha);
      return previous;
    });
  }

  private weightedMovingAverage(source: (number | null)[], period: number) {
    const denominator = period * (period + 1) / 2;
    return source.map((_value, index) => {
      if (index < period - 1) return null;
      let weighted = 0;
      for (let cursor = 0; cursor < period; cursor += 1) {
        const value = source[index - period + 1 + cursor];
        if (value === null) return null;
        weighted += value * (cursor + 1);
      }
      return weighted / denominator;
    });
  }

  private wma(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 14);
    return this.weightedMovingAverage(source, period);
  }

  private rma(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 14);
    const output: (number | null)[] = Array(source.length).fill(null);
    let seed = 0;
    let seedCount = 0;
    let previous: number | null = null;
    for (let index = 0; index < source.length; index += 1) {
      const value = source[index];
      if (value === null) {
        seed = 0;
        seedCount = 0;
        previous = null;
        continue;
      }
      if (previous === null) {
        seed += value;
        seedCount += 1;
        if (seedCount < period) continue;
        previous = seed / period;
      } else {
        previous = (previous * (period - 1) + value) / period;
      }
      output[index] = previous;
    }
    return output;
  }

  private hma(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 14);
    const half = Math.max(1, Math.round(period / 2));
    const root = Math.max(1, Math.round(Math.sqrt(period)));
    const halfWma = this.weightedMovingAverage(source, half);
    const fullWma = this.weightedMovingAverage(source, period);
    const difference = source.map((_value, index) => halfWma[index] === null || fullWma[index] === null
      ? null
      : 2 * halfWma[index]! - fullWma[index]!);
    return this.weightedMovingAverage(difference, root);
  }

  private cumulative(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    let total = 0;
    let started = false;
    return source.map((value) => {
      if (value === null) return started ? total : null;
      total += value;
      started = true;
      return total;
    });
  }

  private percentileLinearInterpolation(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 100);
    const percentile = Math.max(0, Math.min(100, finiteNumber(args.positional[2] ?? 50, "percentile")));
    const rank = percentile / 100 * (period - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    const fraction = rank - lowerIndex;
    return source.map((_value, index) => {
      if (index < period - 1) return null;
      const window = source.slice(index - period + 1, index + 1);
      if (window.some((value) => value === null)) return null;
      const sorted = (window as number[]).slice().sort((left, right) => left - right);
      return sorted[lowerIndex]! + (sorted[upperIndex]! - sorted[lowerIndex]!) * fraction;
    });
  }

  private shift(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const periods = positivePeriod(args.positional[1] ?? 1, "periods");
    return source.map((_value, index) => index < periods ? null : source[index - periods]);
  }

  private rsi(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 14);
    const output: (number | null)[] = Array(source.length).fill(null);
    let averageGain = 0;
    let averageLoss = 0;
    for (let index = 1; index < source.length; index += 1) {
      if (source[index] === null || source[index - 1] === null) continue;
      const delta = source[index]! - source[index - 1]!;
      const gain = Math.max(delta, 0);
      const loss = Math.max(-delta, 0);
      if (index <= period) {
        averageGain += gain / period;
        averageLoss += loss / period;
        if (index < period) continue;
      } else {
        averageGain = (averageGain * (period - 1) + gain) / period;
        averageLoss = (averageLoss * (period - 1) + loss) / period;
      }
      output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
    }
    return output;
  }

  private macd(args: CallArguments): RuntimeValue {
    const source = args.positional[0] ?? this.env.get("close") ?? null;
    const fastLength = positivePeriod(args.positional[1] ?? 12, "fast length");
    const slowLength = positivePeriod(args.positional[2] ?? 26, "slow length");
    const signalLength = positivePeriod(args.positional[3] ?? 9, "signal length");
    const fast = this.ema({ positional: [source, fastLength], named: {} });
    const slow = this.ema({ positional: [source, slowLength], named: {} });
    if (!isSeries(fast) || !isSeries(slow)) throw new Error("ta.macd requires a numeric source series");
    const line = mapBinary(fast, slow, this.candles.length, (left, right) => {
      const leftNumber = numberValue(left);
      const rightNumber = numberValue(right);
      return leftNumber === null || rightNumber === null ? null : leftNumber - rightNumber;
    });
    const signal = this.ema({ positional: [line, signalLength], named: {} });
    const histogram = mapBinary(line, signal, this.candles.length, (left, right) => {
      const leftNumber = numberValue(left);
      const rightNumber = numberValue(right);
      return leftNumber === null || rightNumber === null ? null : leftNumber - rightNumber;
    });
    return { kind: "tuple", values: [line, signal, histogram] };
  }

  private stochastic(args: CallArguments): RuntimeValue {
    const close = this.numericSeries(args.positional[0] ?? this.env.get("close") ?? null, "close");
    const high = this.numericSeries(args.positional[1] ?? this.env.get("high") ?? null, "high");
    const low = this.numericSeries(args.positional[2] ?? this.env.get("low") ?? null, "low");
    const period = positivePeriod(args.positional[3] ?? 14);
    return close.map((value, index) => {
      if (index < period - 1 || value === null) return null;
      const highs = high.slice(index - period + 1, index + 1);
      const lows = low.slice(index - period + 1, index + 1);
      if (highs.some((entry) => entry === null) || lows.some((entry) => entry === null)) return null;
      const highest = Math.max(...highs as number[]);
      const lowest = Math.min(...lows as number[]);
      return highest === lowest ? 50 : (value - lowest) / (highest - lowest) * 100;
    });
  }

  private moneyFlowIndex(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? this.env.get("hlc3") ?? null, "source");
    const volume = this.numericSeries(this.env.get("volume") ?? null, "volume");
    const period = positivePeriod(args.positional[1] ?? 14);
    return source.map((value, index) => {
      if (index < period || value === null) return null;
      let positive = 0;
      let negative = 0;
      for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
        const current = source[cursor];
        const previous = source[cursor - 1];
        const currentVolume = volume[cursor];
        if (current === null || previous === null || currentVolume === null) return null;
        const flow = current * currentVolume;
        if (current > previous) positive += flow;
        else if (current < previous) negative += flow;
      }
      if (negative === 0) return positive === 0 ? 50 : 100;
      return 100 - 100 / (1 + positive / negative);
    });
  }

  private commodityChannelIndex(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? this.env.get("hlc3") ?? null, "source");
    const period = positivePeriod(args.positional[1] ?? 20);
    return source.map((_value, index) => {
      if (index < period - 1) return null;
      const window = source.slice(index - period + 1, index + 1);
      if (window.some((value) => value === null)) return null;
      const numeric = window as number[];
      const mean = numeric.reduce((sum, value) => sum + value, 0) / period;
      const deviation = numeric.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period;
      return deviation === 0 ? 0 : (numeric.at(-1)! - mean) / (0.015 * deviation);
    });
  }

  private volumeWeightedMovingAverage(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? this.env.get("close") ?? null, "source");
    const volume = this.numericSeries(this.env.get("volume") ?? null, "volume");
    const period = positivePeriod(args.positional[1] ?? 14);
    return source.map((_value, index) => {
      if (index < period - 1) return null;
      let weighted = 0;
      let totalVolume = 0;
      for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
        if (source[cursor] === null || volume[cursor] === null) return null;
        weighted += source[cursor]! * volume[cursor]!;
        totalVolume += volume[cursor]!;
      }
      return totalVolume === 0 ? null : weighted / totalVolume;
    });
  }

  private atr(args: CallArguments): RuntimeValue {
    const period = positivePeriod(args.positional[0] ?? 14);
    const ranges = this.candles.map((candle, index) => index === 0
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low, Math.abs(candle.high - this.candles[index - 1].close), Math.abs(candle.low - this.candles[index - 1].close)));
    const output: (number | null)[] = Array(ranges.length).fill(null);
    let previous = 0;
    for (let index = 0; index < ranges.length; index += 1) {
      if (index < period) {
        previous += ranges[index] / period;
        if (index === period - 1) output[index] = previous;
      } else {
        previous = (previous * (period - 1) + ranges[index]) / period;
        output[index] = previous;
      }
    }
    return output;
  }

  private change(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "source");
    const length = positivePeriod(args.positional[1] ?? 1, "length");
    return source.map((value, index) => index < length || value === null || source[index - length] === null ? null : value - source[index - length]!);
  }

  private cross(args: CallArguments, mode: "over" | "under"): RuntimeValue {
    const left = this.numericSeries(args.positional[0] ?? null, "left series");
    const right = this.numericSeries(args.positional[1] ?? null, "right series");
    return left.map((value, index) => {
      if (index === 0 || value === null || right[index] === null || left[index - 1] === null || right[index - 1] === null) return false;
      return mode === "over"
        ? left[index - 1]! <= right[index - 1]! && value > right[index]!
        : left[index - 1]! >= right[index - 1]! && value < right[index]!;
    });
  }

  private nz(args: CallArguments): RuntimeValue {
    const fallback = args.positional[1] ?? 0;
    const source = args.positional[0] ?? null;
    if (!isSeries(source)) return source === null ? fallback : source;
    const replacement = broadcast(fallback, this.candles.length);
    return source.map((entry, index) => entry === null ? replacement[index] : entry);
  }

  private plot(args: CallArguments): RuntimeValue {
    const source = this.numericSeries(args.positional[0] ?? null, "plot source");
    const title = textValue(args.named.title ?? args.positional[1], `Series ${this.plots.length + 1}`);
    const color = textValue(args.named.color, "#f4f4f5");
    const width = Math.max(1, Math.min(8, Math.round(typeof args.named.width === "number" ? args.named.width : 1)));
    const pane = textValue(args.named.pane, "price").toLowerCase() === "oscillator" ? "oscillator" : "price";
    const visibleArgument = args.named.visible ?? true;
    const visible = isSeries(visibleArgument) || isTuple(visibleArgument) ? true : booleanValue(visibleArgument);
    this.plots.push({ name: title, values: source, color, width, pane, visible });
    return source;
  }

  private plotShape(args: CallArguments): RuntimeValue {
    const condition = this.conditionSeries(args.positional[0] ?? false);
    const title = textValue(args.named.title ?? args.positional[1], "Signal");
    const location = textValue(args.named.location, "belowbar").toLowerCase();
    const direction = /short|sell|bear/.test(title.toLowerCase()) || location === "abovebar" ? "short" : /long|buy|bull/.test(title.toLowerCase()) || location === "belowbar" ? "long" : "neutral";
    const color = textValue(args.named.color, direction === "short" ? "#c40024" : "#f4f4f5");
    condition.forEach((matched, index) => {
      if (!matched) return;
      const candle = this.candles[index];
      const value = direction === "short" ? candle.high : direction === "long" ? candle.low : candle.close;
      this.markers.push({
        id: `${this.sourceHash}:shape:${stableHash(title)}:${candle.time}`,
        index,
        time: candle.time,
        signalPrice: candle.close,
        value,
        label: title,
        direction,
        kind: "shape",
        color
      });
    });
    return condition;
  }

  private registerAlert(conditionValue: RuntimeValue, title: string, message: string, type: CompiledScriptEvent["type"], direction: CompiledScriptEvent["direction"]) {
    const condition = this.conditionSeries(conditionValue);
    const conditionId = `${this.sourceHash}:${type}:${stableHash(title)}`;
    if (!this.alertConditions.some((row) => row.id === conditionId)) this.alertConditions.push({ id: conditionId, title, message });
    condition.forEach((matched, index) => {
      if (!matched) return;
      const candle = this.candles[index];
      this.events.push({
        id: `${conditionId}:${candle.time}`,
        conditionId,
        index,
        time: candle.time,
        price: candle.close,
        title,
        message: message.replaceAll("{{price}}", candle.close.toFixed(2)),
        type,
        direction
      });
    });
    return condition;
  }

  private alertCondition(args: CallArguments, _line: number): RuntimeValue {
    const title = textValue(args.positional[1] ?? args.named.title, "Custom Alert");
    const message = textValue(args.positional[2] ?? args.named.message, title);
    const direction = /short|sell|bear/.test(title.toLowerCase()) ? "short" : /long|buy|bull/.test(title.toLowerCase()) ? "long" : "neutral";
    return this.registerAlert(args.positional[0] ?? false, title, message, "alert", direction);
  }

  private alert(args: CallArguments, _line: number): RuntimeValue {
    const message = textValue(args.positional[0], "Custom Script Alert");
    const title = textValue(args.named.title, message);
    return this.registerAlert(args.named.when ?? true, title, message, "alert", "neutral");
  }

  private scalarNumber(value: RuntimeValue | undefined, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return value;
  }

  private scalarBoolean(value: RuntimeValue | undefined, fallback: boolean) {
    return value === undefined || isSeries(value) || isTuple(value) ? fallback : booleanValue(value);
  }

  private optionalNumberSeries(value: RuntimeValue | undefined) {
    return value === undefined || value === null ? undefined : this.numericSeries(value, "strategy order value");
  }

  private configureStrategy(args: CallArguments): RuntimeValue {
    const quantityMode = textValue(args.named.default_qty_type, this.strategyConfig.defaultQuantityMode);
    const commissionMode = textValue(args.named.commission_type, this.strategyConfig.commissionMode);
    this.strategyConfig = {
      initialCapital: Math.max(0.01, this.scalarNumber(args.named.initial_capital, this.strategyConfig.initialCapital)),
      defaultQuantityMode: quantityMode === "fixed" || quantityMode === "cash" ? quantityMode : "percent_of_equity",
      defaultQuantityValue: Math.max(0, this.scalarNumber(args.named.default_qty_value, this.strategyConfig.defaultQuantityValue)),
      commissionMode: commissionMode === "cash_per_order" || commissionMode === "cash_per_contract" ? commissionMode : "percent",
      commissionValue: Math.max(0, this.scalarNumber(args.named.commission_value, this.strategyConfig.commissionValue)),
      slippageTicks: Math.max(0, this.scalarNumber(args.named.slippage, this.strategyConfig.slippageTicks)),
      tickSize: Math.max(1e-12, this.scalarNumber(args.named.tick_size, this.strategyConfig.tickSize)),
      pyramiding: Math.max(1, Math.round(this.scalarNumber(args.named.pyramiding, this.strategyConfig.pyramiding))),
      processOrdersOnClose: this.scalarBoolean(args.named.process_orders_on_close, this.strategyConfig.processOrdersOnClose)
    };
    return true;
  }

  private strategyEntry(args: CallArguments, line: number): RuntimeValue {
    const title = textValue(args.positional[0], "Strategy Entry");
    const side = textValue(args.positional[1], "long").toLowerCase() === "short" ? "short" : "long";
    const condition = this.conditionSeries(args.named.when ?? true);
    this.strategyInstructions.push({
      kind: "entry",
      id: title,
      side,
      when: condition,
      line,
      quantity: this.optionalNumberSeries(args.named.qty),
      quantityPercent: this.optionalNumberSeries(args.named.qty_percent),
      limit: this.optionalNumberSeries(args.named.limit),
      stop: this.optionalNumberSeries(args.named.stop)
    });
    return condition;
  }

  private strategyExit(args: CallArguments, line: number): RuntimeValue {
    const title = textValue(args.positional[0], "Strategy Exit");
    const condition = this.conditionSeries(args.named.when ?? true);
    const fromEntry = textValue(args.positional[1] ?? args.named.from_entry, "") || undefined;
    this.strategyInstructions.push({
      kind: "exit",
      id: title,
      fromEntry,
      when: condition,
      line,
      quantity: this.optionalNumberSeries(args.named.qty),
      quantityPercent: this.optionalNumberSeries(args.named.qty_percent),
      limit: this.optionalNumberSeries(args.named.limit),
      stop: this.optionalNumberSeries(args.named.stop),
      profitTicks: this.optionalNumberSeries(args.named.profit),
      lossTicks: this.optionalNumberSeries(args.named.loss)
    });
    return condition;
  }

  private strategyClose(args: CallArguments, line: number, closeAll: boolean): RuntimeValue {
    const fromEntry = closeAll ? undefined : textValue(args.positional[0] ?? args.named.id, "") || undefined;
    const title = closeAll ? "Close All" : fromEntry || "Strategy Close";
    const condition = this.conditionSeries(args.named.when ?? true);
    this.strategyInstructions.push({
      kind: "close",
      id: title,
      fromEntry,
      when: condition,
      line,
      quantity: this.optionalNumberSeries(args.named.qty),
      quantityPercent: this.optionalNumberSeries(args.named.qty_percent)
    });
    return condition;
  }

  private strategyCancel(args: CallArguments, line: number, cancelAll: boolean): RuntimeValue {
    const targetId = cancelAll ? undefined : textValue(args.positional[0] ?? args.named.id, "") || undefined;
    const condition = this.conditionSeries(args.named.when ?? true);
    this.strategyInstructions.push({
      kind: "cancel",
      id: cancelAll ? "Cancel All" : targetId || "Strategy Cancel",
      targetId,
      cancelAll,
      when: condition,
      line
    });
    return condition;
  }

  private addStrategyMarkers(condition: boolean[], title: string, direction: CompiledMarker["direction"], kind: "entry" | "exit") {
    condition.forEach((matched, index) => {
      if (!matched) return;
      const candle = this.candles[index];
      const value = direction === "short" ? candle.high : direction === "long" ? candle.low : candle.close;
      this.markers.push({
        id: `${this.sourceHash}:${kind}:${stableHash(title)}:${candle.time}`,
        index,
        time: candle.time,
        signalPrice: candle.close,
        value,
        label: title,
        direction,
        kind,
        color: direction === "short" ? "#c40024" : direction === "long" ? "#f4f4f5" : "#a9a3a8"
      });
    });
  }
}

function parseExpression(runtime: ScriptRuntime, expression: string, line: number) {
  return new ExpressionParser(runtime, new Tokenizer(expression).all(), line).parse();
}

function executeScriptPass(input: {
  script: string;
  candles: Candle[];
  sourceHash: string;
  inputValues: Readonly<Record<string, ScriptInputValue>>;
  strategyState?: CompiledStrategyReport;
}) {
  const runtime = new ScriptRuntime(input.candles, input.sourceHash, input.inputValues, input.strategyState);
  const errors: { line: number; message: string }[] = [];
  const collected = collectLogicalStatements(input.script);
  if (collected.error) errors.push(collected.error);

  for (const statement of collected.statements) {
    const lineNumber = statement.line;
    const line = statement.source;
    try {
      if (forbiddenStatement.test(line)) throw new Error("Deterministic vector execution does not permit imports, unbounded loops, classes or user-defined code blocks");
      const assignAt = assignmentIndex(line);
      if (assignAt >= 0) {
        const name = line.slice(0, assignAt).trim();
        const expression = line.slice(assignAt + 1).trim();
        if (!expression) throw new Error("Assignment requires an expression");
        runtime.assign(name, parseExpression(runtime, expression, lineNumber));
        continue;
      }
      const callName = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/)?.[1];
      if (!callName || !allowedStandaloneCalls.has(callName)) throw new Error(`Unsupported statement '${line}'`);
      parseExpression(runtime, line, lineNumber);
    } catch (error) {
      errors.push({ line: lineNumber, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { runtime, errors };
}

function strategyStateMatches(left: CompiledStrategyReport, right: CompiledStrategyReport) {
  if (left.positionSize.length !== right.positionSize.length) return false;
  for (let index = 0; index < left.positionSize.length; index += 1) {
    if (Math.abs((left.positionSize[index] ?? 0) - (right.positionSize[index] ?? 0)) > 1e-10) return false;
    if (Math.abs((left.positionAveragePrice[index] ?? 0) - (right.positionAveragePrice[index] ?? 0)) > 1e-8) return false;
  }
  return true;
}

function registerStrategyFills(runtime: ScriptRuntime, report: CompiledStrategyReport, sourceHash: string, candles: readonly Candle[]) {
  let signedPosition = 0;
  let takeProfitSequence = 0;

  for (const fill of report.fills) {
    const candle = candles[fill.index];
    if (!candle) continue;
    const signedQuantity = fill.quantity * (fill.side === "long" ? 1 : -1);
    let markerLabel: string;
    let strategyRole: NonNullable<CompiledMarker["strategyRole"]>;

    if (fill.action === "entry") {
      if (Math.abs(signedPosition) <= 1e-12 || Math.sign(signedPosition) !== Math.sign(signedQuantity)) {
        takeProfitSequence = 0;
      }
      signedPosition += signedQuantity;
      markerLabel = fill.side === "long" ? "Long" : "Short";
      strategyRole = "entry";
    } else {
      const reason = fill.reason.toUpperCase();
      if (reason.endsWith(":STOP")) {
        markerLabel = "SL";
        strategyRole = "stopLoss";
      } else if (reason.endsWith(":LIMIT") && fill.realizedPnl > 0) {
        takeProfitSequence += 1;
        markerLabel = `TP${takeProfitSequence}`;
        strategyRole = "takeProfit";
      } else if (reason.startsWith("REVERSE:")) {
        markerLabel = "REV";
        strategyRole = "reversal";
      } else if (reason.startsWith("CLOSE:")) {
        markerLabel = "CLOSE";
        strategyRole = "close";
      } else {
        markerLabel = "EXIT";
        strategyRole = "exit";
      }
      signedPosition -= signedQuantity;
      if (Math.abs(signedPosition) <= 1e-12) signedPosition = 0;
    }

    const title = fill.action === "entry" ? `${fill.instructionId} Filled` : `${fill.instructionId} Exit Filled`;
    const conditionId = `${sourceHash}:strategy-fill:${stableHash(fill.instructionId)}:${fill.action}`;
    if (!runtime.alertConditions.some((condition) => condition.id === conditionId)) {
      runtime.alertConditions.push({ id: conditionId, title, message: `${title} at {{price}}` });
    }
    runtime.events.push({
      id: `${conditionId}:${candle.time}:${fill.id}`,
      conditionId,
      index: fill.index,
      time: fill.time,
      price: fill.price,
      title,
      message: `${title} at ${fill.price.toFixed(2)} · qty ${fill.quantity.toFixed(8)}`,
      type: fill.action === "entry" ? "entry" : "exit",
      direction: fill.action === "entry" ? fill.side : "neutral"
    });
    runtime.markers.push({
      id: `${sourceHash}:${fill.action}:${stableHash(fill.instructionId)}:${candle.time}:${fill.id}`,
      index: fill.index,
      time: fill.time,
      signalPrice: fill.price,
      value: fill.action === "entry" ? (fill.side === "short" ? candle.high : candle.low) : fill.price,
      label: markerLabel,
      direction: fill.side,
      kind: fill.action === "entry" ? "entry" : "exit",
      strategyRole,
      color: strategyRole === "stopLoss"
        ? "#c40024"
        : strategyRole === "takeProfit"
          ? "#f4f4f5"
          : fill.action === "exit"
            ? "#a9a3a8"
            : fill.side === "short" ? "#c40024" : "#f4f4f5"
    });
  }
}

export function compileAndRunScript(
  script: string,
  candles: Candle[],
  inputValues: Readonly<Record<string, ScriptInputValue>> = {}
): CompileResult {
  const sourceHash = stableHash(script);
  const result: CompileResult = {
    success: false,
    errors: [],
    plots: [],
    markers: [],
    alertConditions: [],
    events: [],
    strategy: null,
    runtimeVersion: BLACK_TERMINAL_PYTHON_RUNTIME_VERSION,
    sourceHash
  };
  if (!Array.isArray(candles) || candles.length < 2) {
    result.errors.push({ line: 1, message: "At least two authoritative chart candles are required" });
    return result;
  }
  if (script.length > 100_000) {
    result.errors.push({ line: 1, message: "Script exceeds the 100000 character runtime limit" });
    return result;
  }

  let pass = executeScriptPass({ script, candles, sourceHash, inputValues });
  if (pass.errors.length) {
    result.errors.push(...pass.errors);
    return result;
  }

  let runtime = pass.runtime;
  let strategy: CompiledStrategyReport | null = null;
  if (runtime.strategyInstructions.length > 0) {
    strategy = simulateStrategy({ candles, instructions: runtime.strategyInstructions, config: runtime.strategyConfig });
    const requiresStateResolution = /\bstrategy\.(?:position_size|position_avg_price|equity|openprofit|netprofit)\b/.test(script);
    for (let iteration = 0; requiresStateResolution && iteration < 4; iteration += 1) {
      pass = executeScriptPass({ script, candles, sourceHash, inputValues, strategyState: strategy });
      if (pass.errors.length) {
        result.errors.push(...pass.errors);
        return result;
      }
      const nextStrategy = simulateStrategy({ candles, instructions: pass.runtime.strategyInstructions, config: pass.runtime.strategyConfig });
      runtime = pass.runtime;
      const converged = strategyStateMatches(strategy, nextStrategy);
      strategy = nextStrategy;
      if (converged) break;
    }
    registerStrategyFills(runtime, strategy, sourceHash, candles);
  }

  return {
    success: true,
    errors: [],
    plots: runtime.plots,
    markers: runtime.markers,
    alertConditions: runtime.alertConditions,
    events: runtime.events,
    strategy,
    runtimeVersion: BLACK_TERMINAL_PYTHON_RUNTIME_VERSION,
    sourceHash
  };
}

/**
 * Extract the deterministic input declarations that can be safely exposed in
 * a native-style custom-script settings panel. Only literal defaults are
 * accepted by the vector runtime, so this parser never evaluates source text.
 */
export function extractScriptInputs(script: string): CompiledScriptInput[] {
  const inputs: CompiledScriptInput[] = [];
  const seen = new Set<string>();
  const declaration = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*input\.(int|float|bool|string|color)\s*\((.*)\)\s*(?:#.*)?$/;

  for (const line of script.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(declaration);
    if (!match) continue;
    const [, variable, typeValue, rawArguments] = match;
    const argumentsList = splitLiteralInputArguments(rawArguments);
    const rawDefault = argumentsList[0]?.trim();
    if (!rawDefault) continue;
    const type = typeValue as CompiledScriptInput["type"];
    const titleArgument = argumentsList.find((argument, index) => index > 0 && /^title\s*=/.test(argument.trim()));
    const rawLabel = titleArgument?.replace(/^\s*title\s*=\s*/, "") ?? argumentsList[1];
    const explicitLabel = rawLabel && /^(["']).*\1$/.test(rawLabel.trim()) ? rawLabel.trim().slice(1, -1) : "";
    const label = explicitLabel.replace(/\\([\\"'])/g, "$1").trim() || variable;
    if (seen.has(label)) continue;
    let defaultValue: ScriptInputValue;
    if (type === "bool") {
      if (!/^(?:true|false)$/i.test(rawDefault)) continue;
      defaultValue = rawDefault.toLowerCase() === "true";
    } else if (type === "string" || type === "color") {
      if (!/^(["']).*\1$/.test(rawDefault)) continue;
      defaultValue = rawDefault.slice(1, -1).replace(/\\([\\"'])/g, "$1");
    }
    else {
      const numeric = Number(rawDefault);
      if (!Number.isFinite(numeric)) continue;
      defaultValue = type === "int" ? Math.round(numeric) : numeric;
    }
    seen.add(label);
    const named = Object.fromEntries(argumentsList.slice(1).flatMap((argument) => {
      const equals = argument.indexOf("=");
      return equals > 0 ? [[argument.slice(0, equals).trim(), argument.slice(equals + 1).trim()]] : [];
    }));
    const parsedOptions = named.options && /^\[.*\]$/.test(named.options)
      ? splitLiteralInputArguments(named.options.slice(1, -1)).map(parseInputLiteral).filter((value): value is ScriptInputValue => value !== undefined)
      : undefined;
    const min = parseInputLiteral(named.minval);
    const max = parseInputLiteral(named.maxval);
    const step = parseInputLiteral(named.step);
    const group = parseInputLiteral(named.group);
    const tooltip = parseInputLiteral(named.tooltip);
    inputs.push({
      key: label,
      variable,
      label,
      type,
      defaultValue,
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
      ...(typeof step === "number" ? { step } : {}),
      ...(parsedOptions?.length ? { options: parsedOptions } : {}),
      ...(typeof group === "string" ? { group } : {}),
      ...(typeof tooltip === "string" ? { tooltip } : {})
    });
  }
  return inputs;
}

function splitLiteralInputArguments(source: string): string[] {
  const values: string[] = [];
  let quote = "";
  let escaped = false;
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = quote === character ? "" : quote || character;
      continue;
    }
    if (!quote && (character === "(" || character === "[")) depth += 1;
    else if (!quote && (character === ")" || character === "]")) depth = Math.max(0, depth - 1);
    if (character === "," && !quote && depth === 0) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(source.slice(start).trim());
  return values;
}

function parseInputLiteral(source: string | undefined): ScriptInputValue | undefined {
  if (!source) return undefined;
  const value = source.trim();
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function newlyConfirmedScriptEvents(input: {
  events: CompiledScriptEvent[];
  armedAfter: number;
  latestConfirmedTime: number;
  deliveredIds?: ReadonlySet<string>;
}) {
  return input.events
    .filter((event) => event.time > input.armedAfter && event.time <= input.latestConfirmedTime && !input.deliveredIds?.has(event.id))
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
}

export function finalizedScriptResult(result: CompileResult, latestConfirmedTime: number): CompileResult {
  const strategy = result.strategy ? finalizedStrategyReport(result.strategy, latestConfirmedTime) : null;
  return {
    ...result,
    markers: result.markers.filter((marker) => marker.time <= latestConfirmedTime),
    events: result.events.filter((event) => event.time <= latestConfirmedTime),
    strategy
  };
}

function finalizedStrategyReport(report: CompiledStrategyReport, latestConfirmedTime: number): CompiledStrategyReport {
  const fills = report.fills.filter((fill) => fill.time <= latestConfirmedTime);
  const trades = report.trades.filter((trade) => trade.exitTime <= latestConfirmedTime);
  let lastIndex = 0;
  for (let index = report.times.length - 1; index >= 0; index -= 1) {
    if (report.times[index] > latestConfirmedTime) continue;
    lastIndex = index;
    break;
  }
  const equityValues = report.equityCurve.slice(0, lastIndex + 1).filter((value): value is number => value !== null);
  let peak = report.initialCapital;
  let maxDrawdown = 0;
  for (const equity of equityValues) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }
  const position = report.positionSize[lastIndex] ?? 0;
  const averagePrice = report.positionAveragePrice[lastIndex] ?? 0;
  const openProfit = report.openProfit[lastIndex] ?? 0;
  const totalCommission = fills.reduce((sum, fill) => sum + fill.commission, 0);
  const realizedPnl = fills.reduce((sum, fill) => sum + fill.realizedPnl, 0);
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const losses = trades.filter((trade) => trade.netPnl < 0).length;
  return {
    ...report,
    fills,
    trades,
    endingEquity: equityValues.at(-1) ?? report.initialCapital,
    realizedNetProfit: realizedPnl - totalCommission,
    totalCommission,
    totalTrades: trades.length,
    winningTrades: wins,
    losingTrades: losses,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    maxDrawdown,
    openPosition: Math.abs(position) > 1e-12 ? {
      side: position > 0 ? "long" : "short",
      quantity: Math.abs(position),
      averagePrice,
      unrealizedPnl: openProfit
    } : null
  };
}
