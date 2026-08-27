import type { Candle } from "../chart-engine/types";

export const BLACK_TERMINAL_PYTHON_RUNTIME_VERSION = "bt-python-vector-v2";

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
  type: "int" | "float" | "bool" | "string";
  defaultValue: ScriptInputValue;
};

export type CompileResult = {
  success: boolean;
  errors: { line: number; message: string }[];
  plots: CompiledPlot[];
  markers: CompiledMarker[];
  alertConditions: CompiledAlertCondition[];
  events: CompiledScriptEvent[];
  runtimeVersion: typeof BLACK_TERMINAL_PYTHON_RUNTIME_VERSION;
  sourceHash: string;
};

type Scalar = number | boolean | string | null;
type SeriesScalar = number | boolean | null;
type RuntimeValue = Scalar | SeriesScalar[];
type CallArguments = { positional: RuntimeValue[]; named: Record<string, RuntimeValue> };

type Token = {
  type: "number" | "string" | "identifier" | "operator" | "punctuation" | "eof";
  value: string;
};

const forbiddenStatement = /^(?:async\s+def|def|class|import|from|for|while|if|elif|else|try|except|finally|with|lambda|yield|raise|global|nonlocal|del|assert|match|case)\b/;
const allowedStandaloneCalls = new Set(["plot", "plotshape", "alertcondition", "alert", "strategy.entry", "strategy.exit"]);

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
  if (!isSeries(value)) return operation(value as SeriesScalar);
  return broadcast(value, length).map(operation);
}

function mapBinary(
  left: RuntimeValue,
  right: RuntimeValue,
  length: number,
  operation: (a: SeriesScalar | string, b: SeriesScalar | string) => SeriesScalar
): RuntimeValue {
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
        this.tokens.push({ type: ["and", "or", "not"].includes(value) ? "operator" : "identifier", value });
        continue;
      }
      const pair = source.slice(this.index, this.index + 2);
      if (["==", "!=", "<=", ">="].includes(pair)) {
        this.tokens.push({ type: "operator", value: pair });
        this.index += 2;
        continue;
      }
      if (["+", "-", "*", "/", "%", "<", ">", "="].includes(character)) {
        this.tokens.push({ type: "operator", value: character });
        this.index += 1;
        continue;
      }
      if (["(", ")", ","].includes(character)) {
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
    const value = this.parseOr();
    if (this.peek().type !== "eof") throw new Error(`Unexpected token '${this.peek().value}'`);
    return value;
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
    while (["*", "/", "%"].includes(this.peek().value)) {
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
      if (this.match("(")) {
        const positional: RuntimeValue[] = [];
        const named: Record<string, RuntimeValue> = {};
        if (!this.match(")")) {
          do {
            if (this.peek().type === "identifier" && this.peek(1).value === "=") {
              const name = this.consume().value;
              this.consume("=");
              named[name] = this.parseOr();
            } else positional.push(this.parseOr());
          } while (this.match(","));
          this.consume(")");
        }
        return this.runtime.call(token.value, { positional, named }, this.line);
      }
      return this.runtime.resolve(token.value);
    }
    if (token.value === "(") {
      const value = this.parseOr();
      this.consume(")");
      return value;
    }
    throw new Error(`Unexpected token '${token.value || "end of line"}'`);
  }
}

class ScriptRuntime {
  readonly plots: CompiledPlot[] = [];
  readonly markers: CompiledMarker[] = [];
  readonly alertConditions: CompiledAlertCondition[] = [];
  readonly events: CompiledScriptEvent[] = [];
  private readonly env = new Map<string, RuntimeValue>();
  private readonly candles: Candle[];
  private readonly sourceHash: string;
  private readonly inputValues: Readonly<Record<string, ScriptInputValue>>;

  constructor(candles: Candle[], sourceHash: string, inputValues: Readonly<Record<string, ScriptInputValue>>) {
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
  }

  assign(name: string, value: RuntimeValue) {
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
      if (operator === "%") return rightNumber === 0 ? null : leftNumber % rightNumber;
      if (operator === "<") return leftNumber < rightNumber;
      if (operator === "<=") return leftNumber <= rightNumber;
      if (operator === ">") return leftNumber > rightNumber;
      if (operator === ">=") return leftNumber >= rightNumber;
      throw new Error(`Unsupported operator '${operator}'`);
    });
  }

  call(name: string, args: CallArguments, line: number): RuntimeValue {
    if (name === "input.int" || name === "input.float" || name === "input.bool" || name === "input.string") {
      return this.input(name.slice("input.".length) as CompiledScriptInput["type"], args);
    }
    if (name === "ta.sma") return this.rolling(args, "sma");
    if (name === "ta.ema") return this.ema(args);
    if (name === "ta.wma") return this.wma(args);
    if (name === "ta.rma") return this.rma(args);
    if (name === "ta.hma") return this.hma(args);
    if (name === "ta.cum") return this.cumulative(args);
    if (name === "ta.rsi") return this.rsi(args);
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
    if (name === "strategy.entry") return this.strategyEntry(args, line);
    if (name === "strategy.exit") return this.strategyExit(args, line);
    throw new Error(`Function '${name}' is not available in ${BLACK_TERMINAL_PYTHON_RUNTIME_VERSION}`);
  }

  private input(type: CompiledScriptInput["type"], args: CallArguments): RuntimeValue {
    const label = textValue(args.positional[1] ?? args.named.title, "");
    const configured = label ? this.inputValues[label] : undefined;
    const value = configured === undefined ? args.positional[0] : configured;
    if (type === "string") return typeof value === "string" ? value : textValue(args.positional[0], "");
    if (type === "bool") return typeof value === "boolean" ? value : Boolean(value ?? false);
    const numeric = typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof args.positional[0] === "number" && Number.isFinite(args.positional[0])
        ? args.positional[0]
        : 0;
    return type === "int" ? Math.round(numeric) : numeric;
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
    const visible = isSeries(visibleArgument) ? true : booleanValue(visibleArgument);
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

  private strategyEntry(args: CallArguments, _line: number): RuntimeValue {
    const title = textValue(args.positional[0], "Strategy Entry");
    const side = textValue(args.positional[1], "long").toLowerCase() === "short" ? "short" : "long";
    const condition = this.registerAlert(args.named.when ?? true, title, `${title} at {{price}}`, "entry", side) as boolean[];
    this.addStrategyMarkers(condition, title, side, "entry");
    return condition;
  }

  private strategyExit(args: CallArguments, _line: number): RuntimeValue {
    const title = textValue(args.positional[0], "Strategy Exit");
    const condition = this.registerAlert(args.named.when ?? true, title, `${title} at {{price}}`, "exit", "neutral") as boolean[];
    this.addStrategyMarkers(condition, title, "neutral", "exit");
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

  const runtime = new ScriptRuntime(candles, sourceHash, inputValues);
  const lines = script.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripInlineComment(lines[index]).trim();
    if (!line) continue;
    try {
      if (forbiddenStatement.test(line)) throw new Error("Only deterministic vector statements are allowed; blocks, loops, imports and user functions are disabled");
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
      result.errors.push({ line: lineNumber, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    success: result.errors.length === 0,
    errors: result.errors,
    plots: runtime.plots,
    markers: runtime.markers,
    alertConditions: runtime.alertConditions,
    events: runtime.events,
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
  const declaration = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*input\.(int|float|bool|string)\s*\((.*)\)\s*(?:#.*)?$/;

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
    } else if (type === "string") {
      if (!/^(["']).*\1$/.test(rawDefault)) continue;
      defaultValue = rawDefault.slice(1, -1).replace(/\\([\\"'])/g, "$1");
    }
    else {
      const numeric = Number(rawDefault);
      if (!Number.isFinite(numeric)) continue;
      defaultValue = type === "int" ? Math.round(numeric) : numeric;
    }
    seen.add(label);
    inputs.push({ key: label, variable, label, type, defaultValue });
  }
  return inputs;
}

function splitLiteralInputArguments(source: string): string[] {
  const values: string[] = [];
  let quote = "";
  let escaped = false;
  let start = 0;
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
    if (character === "," && !quote) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(source.slice(start).trim());
  return values;
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
  return {
    ...result,
    markers: result.markers.filter((marker) => marker.time <= latestConfirmedTime),
    events: result.events.filter((event) => event.time <= latestConfirmedTime)
  };
}
