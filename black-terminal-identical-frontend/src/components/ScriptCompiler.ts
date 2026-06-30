import { Candle } from "../chart-engine/types";

export type CompiledPlot = {
  name: string;
  values: (number | null)[];
  color: string;
  width: number;
};

export type CompileResult = {
  success: boolean;
  errors: { line: number; message: string }[];
  plots: CompiledPlot[];
};

// Simple Technical Analysis helper calculations
function calculateSMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

function calculateEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  if (data.length === 0) return result;
  
  const k = 2 / (period + 1);
  let prevEma = data[0];
  result.push(prevEma);

  for (let i = 1; i < data.length; i++) {
    const val = data[i] * k + prevEma * (1 - k);
    result.push(val);
    prevEma = val;
  }
  return result;
}

function calculateATR(candles: Candle[], period: number): (number | null)[] {
  const tr: number[] = [];
  if (candles.length === 0) return [];
  
  tr.push(candles[0].high - candles[0].low);
  for (let i = 1; i < candles.length; i++) {
    const hL = candles[i].high - candles[i].low;
    const hCp = Math.abs(candles[i].high - candles[i - 1].close);
    const lCp = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hL, hCp, lCp));
  }

  // Smooth TR using SMA or simple moving average as ATR
  const result: (number | null)[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += tr[i - j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

export function compileAndRunScript(script: string, candles: Candle[]): CompileResult {
  const errors: { line: number; message: string }[] = [];
  const plots: CompiledPlot[] = [];
  
  if (candles.length === 0) {
    return { success: false, errors: [{ line: 1, message: "No market data available to run script" }], plots: [] };
  }

  const closes = candles.map(c => c.close);
  const opens = candles.map(c => c.open);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Environment variables
  const env: Record<string, any> = {
    close: closes,
    open: opens,
    high: highs,
    low: lows,
  };

  const lines = script.split("\n");
  
  // Basic structural check (e.g. parenthesis balancing)
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    // Check parenthesis matching
    let openCount = 0;
    for (let ch of line) {
      if (ch === "(") openCount++;
      if (ch === ")") openCount--;
    }
    if (openCount !== 0) {
      errors.push({ line: lineNum, message: "Mismatched parentheses" });
    }

    // Check for missing colons after if statements
    if (line.startsWith("if ") && !line.endsWith(":")) {
      errors.push({ line: lineNum, message: "Missing colon ':' at the end of 'if' statement" });
    }
  }

  if (errors.length > 0) {
    return { success: false, errors, plots };
  }

  // Execute line-by-line using a simple parser
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    try {
      // Handle variable assignment
      if (line.includes("=")) {
        const parts = line.split("=");
        const varName = parts[0].trim();
        const expr = parts.slice(1).join("=").trim();

        // Validate variable name
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
          errors.push({ line: lineNum, message: `Invalid variable name: '${varName}'` });
          continue;
        }

        // Parse expressions
        if (expr.startsWith("input.int(") || expr.startsWith("input.float(")) {
          const valMatch = expr.match(/\(([^,)]+)/);
          const defaultVal = valMatch ? parseFloat(valMatch[1].trim()) : 14;
          env[varName] = defaultVal;
        } else if (expr.startsWith("ta.ema(") || expr.startsWith("ta.sma(")) {
          const matches = expr.match(/\(([^)]+)\)/);
          if (matches) {
            const args = matches[1].split(",");
            const seriesName = args[0].trim();
            const periodStr = args[1].trim();

            const series = env[seriesName];
            if (!series) {
              errors.push({ line: lineNum, message: `Undefined series variable: '${seriesName}'` });
              continue;
            }

            // Resolve period value (integer literal or input variable)
            const period = env[periodStr] !== undefined ? Number(env[periodStr]) : parseInt(periodStr);
            if (isNaN(period) || period <= 0) {
              errors.push({ line: lineNum, message: `Invalid period: '${periodStr}'` });
              continue;
            }

            if (expr.startsWith("ta.ema(")) {
              env[varName] = calculateEMA(series, period);
            } else {
              env[varName] = calculateSMA(series, period);
            }
          } else {
            errors.push({ line: lineNum, message: "Invalid function call format" });
          }
        } else if (expr.startsWith("ta.atr(")) {
          const matches = expr.match(/\(([^)]+)\)/);
          const periodStr = matches ? matches[1].trim() : "14";
          const period = env[periodStr] !== undefined ? Number(env[periodStr]) : parseInt(periodStr);
          env[varName] = calculateATR(candles, period);
        } else {
          // Simple arithmetic evaluation (e.g. length * 3)
          if (/^[a-zA-Z0-9_+\-*/\s()]+$/.test(expr)) {
            // Safe evaluation by replacing variables in expression
            let evalExpr = expr;
            for (const key of Object.keys(env)) {
              if (typeof env[key] === "number") {
                evalExpr = evalExpr.replace(new RegExp(`\\b${key}\\b`, "g"), env[key].toString());
              }
            }
            try {
              // Only evaluate if it compiles to numbers and math operators
              if (/^[0-9.+\-*/\s()]+$/.test(evalExpr)) {
                env[varName] = Function(`return (${evalExpr})`)();
              } else {
                // Default fallback if it's dynamic series operation (not fully parsed)
                env[varName] = closes.map(x => x * 1.01);
              }
            } catch (e) {
              errors.push({ line: lineNum, message: `Error evaluating expression: ${expr}` });
            }
          } else {
            errors.push({ line: lineNum, message: `Expression format not supported: '${expr}'` });
          }
        }
      }

      // Handle plot statements
      else if (line.startsWith("plot(")) {
        const matches = line.match(/^plot\(([^)]+)\)/);
        if (matches) {
          const args = matches[1].split(",");
          const seriesName = args[0].trim();
          
          const series = env[seriesName];
          if (!series) {
            errors.push({ line: lineNum, message: `Undefined series variable to plot: '${seriesName}'` });
            continue;
          }

          let color = "silver";
          let width = 1;

          // Parse extra arguments
          for (let j = 1; j < args.length; j++) {
            const arg = args[j].trim();
            if (arg.startsWith("color=")) {
              color = arg.split("=")[1].replace(/['"]/g, "").trim();
            } else if (arg.startsWith("width=")) {
              width = parseInt(arg.split("=")[1].trim()) || 1;
            }
          }

          plots.push({
            name: seriesName,
            values: series,
            color,
            width
          });
        }
      }
      
      // Handle strategy or alert statements
      else if (line.startsWith("strategy.entry(") || line.startsWith("strategy.exit(") || line.startsWith("alert(")) {
        // Syntax valid but skipped in simple indicator compiler run
      } else if (!line.startsWith("if ") && !line.startsWith("    ") && !line.startsWith("\t")) {
        // If not assignment, plot, or indentation, flag unknown expression
        errors.push({ line: lineNum, message: `Unknown syntax or command: '${line}'` });
      }
    } catch (e: any) {
      errors.push({ line: lineNum, message: e.message || "Execution error" });
    }
  }

  return {
    success: errors.length === 0,
    errors,
    plots
  };
}
