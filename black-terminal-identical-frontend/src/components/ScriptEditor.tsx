import { useState } from "react";
import { Play, Save, TerminalSquare } from "lucide-react";

type ScriptEditorProps = {
  symbol: string;
  exchange: string;
};

type ScriptKind = "indicator" | "strategy";

const templates: Record<ScriptKind, string> = {
  indicator: `# Black-Terminal Python indicator
# Indicator scripts can plot values and trigger alerts.

length = input.int(21, "EMA Length")

ema_fast = ta.ema(close, length)
ema_slow = ta.ema(close, length * 3)

plot(ema_fast, color="silver", width=1)
plot(ema_slow, color="red", width=1)

if ta.crossover(ema_fast, ema_slow):
    alert("Bullish EMA cross")
`,
  strategy: `# Black-Terminal Python strategy
# Strategy scripts emit normalized signals for Strategy Lab.

risk = input.float(0.5, "Risk %")
ema_fast_len = input.int(21, "Fast EMA")
ema_slow_len = input.int(89, "Regime EMA")
atr_len = input.int(14, "ATR Length")
atr_mult = input.float(2.2, "ATR Stop")

ema_fast = ta.ema(close, ema_fast_len)
ema_slow = ta.ema(close, ema_slow_len)
atr = ta.atr(atr_len)

plot(ema_fast, color="silver", width=1)
plot(ema_slow, color="red", width=1)

if ta.crossover(close, ema_fast) and close > ema_slow:
    strategy.entry("long", reason="trend pullback reclaim", stop_loss=close - atr * atr_mult, take_profit=close + atr * atr_mult * 2)

if ta.crossunder(close, ema_fast) and close < ema_slow:
    strategy.entry("short", reason="trend pullback reject", stop_loss=close + atr * atr_mult, take_profit=close - atr * atr_mult * 2)

if ta.crossunder(close, ema_slow):
    strategy.exit("long", reason="regime break")

if ta.crossover(close, ema_slow):
    strategy.exit("short", reason="regime break")
`
};

export function ScriptEditor({ symbol, exchange }: ScriptEditorProps) {
  const [kind, setKind] = useState<ScriptKind>("indicator");
  const [source, setSource] = useState(templates.indicator);

  const changeKind = (nextKind: ScriptKind) => {
    setKind(nextKind);
    setSource(templates[nextKind]);
  };

  return (
    <div className="script-editor">
      <div className="script-toolbar">
        <div>
          <strong>Script Editor</strong>
          <span>{exchange} / {symbol} / {kind.toUpperCase()}</span>
        </div>
        <div className="script-kind-toggle" role="tablist" aria-label="Script type">
          <button type="button" className={kind === "indicator" ? "active" : ""} onClick={() => changeKind("indicator")}>
            Indicator
          </button>
          <button type="button" className={kind === "strategy" ? "active" : ""} onClick={() => changeKind("strategy")}>
            Strategy
          </button>
        </div>
        <button type="button">
          <Save size={14} />
          Save
        </button>
        <button type="button">
          <TerminalSquare size={14} />
          Compile
        </button>
        <button type="button" className="primary">
          <Play size={14} />
          Run
        </button>
      </div>
      <textarea spellCheck={false} value={source} onChange={(event) => setSource(event.target.value)} />
    </div>
  );
}
