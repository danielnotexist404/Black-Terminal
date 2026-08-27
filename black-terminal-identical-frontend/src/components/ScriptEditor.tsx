import { useState, useEffect, useRef } from "react";
import { Play, Save, TerminalSquare, Trash2, Plus, FileCode, CheckCircle, AlertTriangle, X } from "lucide-react";
import { compileAndRunScript, finalizedScriptResult } from "./ScriptCompiler";
import type { CompileResult, CompiledScriptActivation } from "./ScriptCompiler";
import type { Candle } from "../chart-engine/types";
import type { ChartDisplayType } from "../chart-engine/types";
import { dbGetCurrentUserScripts, dbSaveCurrentUserScripts, isSupabaseConfigured } from "../lib/supabase";
import { normalizeUserScripts, type UserScript } from "../scripts/userScriptLibrary";

type ScriptEditorProps = {
  symbol: string;
  exchange: string;
  chartType: ChartDisplayType;
  getCandles: () => Candle[];
  onRunScript: (activation: CompiledScriptActivation, result: CompileResult) => void;
  onUnloadScript: (scriptId: string) => void;
  loadedScriptIds: readonly string[];
  onClose: () => void;
  currentUser: { username: string; role: "admin" | "user" } | null;
};

const templates = {
  indicator: `# Black Terminal Python · deterministic vector runtime
# Uses the selected chart feed. Renko is append-only and closed-brick confirmed.

length = input.int(21, "EMA Length")
slow_length = length * 3

ema_fast = ta.ema(close, length)
ema_slow = ta.ema(close, slow_length)
long_signal = ta.crossover(ema_fast, ema_slow)
short_signal = ta.crossunder(ema_fast, ema_slow)

plot(ema_fast, title="Fast EMA", color="#f4f4f5", width=2)
plot(ema_slow, title="Slow EMA", color="#c40024", width=2)
alertcondition(long_signal, "EMA Long", "Fast EMA crossed above Slow EMA at {{price}}")
alertcondition(short_signal, "EMA Short", "Fast EMA crossed below Slow EMA at {{price}}")
`,
  strategy: `# Black Terminal Python strategy · deterministic vector runtime
# Entries render on the chart and arm closed-candle in-terminal alerts.

fast_length = input.int(5, "Fast EMA")
slow_length = input.int(13, "Slow EMA")
fast = ta.ema(close, fast_length)
slow = ta.ema(close, slow_length)
long_signal = ta.crossover(fast, slow)
short_signal = ta.crossunder(fast, slow)

plot(fast, title="Fast EMA", color="#f4f4f5", width=2)
plot(slow, title="Slow EMA", color="#c40024", width=2)
strategy.entry("Long Entry", strategy.long, when=long_signal)
strategy.entry("Short Entry", strategy.short, when=short_signal)
alertcondition(long_signal, "Long Alert", "Confirmed long signal at {{price}}")
alertcondition(short_signal, "Short Alert", "Confirmed short signal at {{price}}")
`
};

export function ScriptEditor({
  symbol,
  exchange,
  chartType,
  getCandles,
  onRunScript,
  onUnloadScript,
  loadedScriptIds,
  onClose,
  currentUser
}: ScriptEditorProps) {
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [name, setName] = useState("My Indicator");
  const [kind, setKind] = useState<"indicator" | "strategy">("indicator");
  const [source, setSource] = useState(templates.indicator);
  
  // Compiler state
  const [consoleLogs, setConsoleLogs] = useState<{ type: "success" | "error"; text: string; line?: number }[]>([]);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const localStorageKey = currentUser ? `bt_user_scripts:${currentUser.username}` : "bt_user_scripts:anonymous";

  // Load scripts
  useEffect(() => {
    const loadScripts = async () => {
      let stored: UserScript[] = [];
      if (currentUser && isSupabaseConfigured) {
        try {
          stored = normalizeUserScripts(await dbGetCurrentUserScripts());
        } catch (e) {
          setConsoleLogs([{ type: "error", text: `VPS script storage could not be loaded: ${e instanceof Error ? e.message : "Unknown storage error"}` }]);
          return;
        }
      } else {
        const local = localStorage.getItem(localStorageKey);
        if (local) {
          try { stored = normalizeUserScripts(JSON.parse(local)); } catch (e) {}
        }
      }

      setScripts(stored);
      if (stored.length > 0) {
        loadScriptIntoEditor(stored[0]);
      }
    };
    loadScripts();
  }, [currentUser, localStorageKey]);

  // Save scripts to local/Supabase
  const saveScriptsCollection = async (updated: UserScript[]) => {
    if (currentUser && isSupabaseConfigured) {
      await dbSaveCurrentUserScripts(updated);
    } else {
      localStorage.setItem(localStorageKey, JSON.stringify(updated));
    }
    setScripts(updated);
  };

  const loadScriptIntoEditor = (script: UserScript) => {
    setSelectedScriptId(script.id);
    setName(script.name);
    setKind(script.kind);
    setSource(script.source);
    setConsoleLogs([]);
    setHighlightedLine(null);
  };

  const createNewScript = () => {
    setSelectedScriptId(null);
    setName("");
    setKind("indicator");
    setSource(templates.indicator);
    setConsoleLogs([]);
    setHighlightedLine(null);
    window.requestAnimationFrame(() => nameInputRef.current?.focus());
  };

  const saveCurrentScript = async (quiet = false): Promise<UserScript | null> => {
    const scriptName = name.trim();
    if (!scriptName) {
      setConsoleLogs([{ type: "error", text: `Name this ${kind} before saving it.` }]);
      nameInputRef.current?.focus();
      return null;
    }
    const id = selectedScriptId || `script-${Date.now()}`;
    const previous = scripts.find((script) => script.id === id);
    const newScript: UserScript = {
      id,
      name: scriptName,
      kind,
      source,
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      inputValues: previous?.inputValues,
      publication: previous?.publication
    };

    let nextScripts: UserScript[];
    if (selectedScriptId) {
      nextScripts = scripts.map(s => s.id === id ? newScript : s);
    } else {
      nextScripts = [newScript, ...scripts];
    }
    setStorageBusy(true);
    try {
      await saveScriptsCollection(nextScripts);
      setSelectedScriptId(id);
      if (!quiet) {
        setConsoleLogs([{ type: "success", text: `Script "${newScript.name}" saved to ${isSupabaseConfigured ? "authenticated VPS storage" : "local development storage"}. It was not added to the chart.` }]);
      }
      return newScript;
    } catch (error) {
      setConsoleLogs([{ type: "error", text: `Save failed: ${error instanceof Error ? error.message : "Unknown storage error"}` }]);
      return null;
    } finally {
      setStorageBusy(false);
    }
  };

  const deleteScript = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const script = scripts.find(s => s.id === id);
    if (!script) return;

    const confirm = window.confirm(`Are you sure you want to delete the selected script "${script.name}"?`);
    if (!confirm) return;

    const updated = scripts.filter(s => s.id !== id);
    setStorageBusy(true);
    try {
      await saveScriptsCollection(updated);
      onUnloadScript(id);
    } catch (error) {
      setConsoleLogs([{ type: "error", text: `Delete failed: ${error instanceof Error ? error.message : "Unknown storage error"}` }]);
      setStorageBusy(false);
      return;
    }
    setStorageBusy(false);

    if (selectedScriptId === id) {
      if (updated.length > 0) {
        loadScriptIntoEditor(updated[0]);
      } else {
        createNewScript();
      }
    }
  };

  const compileScript = () => {
    setConsoleLogs([{ type: "success", text: "Compiling script..." }]);
    setHighlightedLine(null);

    const candles = getCandles().slice(-20_000);
    const inputFeed = chartType === "renko" ? "CAUSAL_RENKO" : "SOURCE_OHLCV";

    const selectedInputs = scripts.find((script) => script.id === selectedScriptId)?.inputValues;
    const compiled = compileAndRunScript(source, candles, selectedInputs);
    const latestConfirmedTime = candles.at(-2)?.time ?? Number.NEGATIVE_INFINITY;
    const result = finalizedScriptResult(compiled, latestConfirmedTime);
    if (result.success) {
      setConsoleLogs([
        { type: "success", text: `Compilation successful on ${candles.length.toLocaleString()} ${inputFeed === "CAUSAL_RENKO" ? "causal Renko bricks" : "authoritative OHLCV candles"}.` },
        { type: "success", text: `${result.plots.length} plot(s), ${result.markers.length} historical marker(s), ${result.alertConditions.length} alert condition(s).` }
      ]);
    } else {
      const logs = result.errors.map(err => ({
        type: "error" as const,
        text: `Syntax Error (Line ${err.line}): ${err.message}`,
        line: err.line
      }));
      setConsoleLogs(logs);
      if (result.errors.length > 0) {
        setHighlightedLine(result.errors[0].line);
      }
    }
    return result;
  };

  const runScript = async () => {
    const savedScript = await saveCurrentScript(true);
    if (!savedScript) return;
    const result = compileScript();
    if (result && result.success) {
      const activation: CompiledScriptActivation = {
        id: savedScript.id,
        name: savedScript.name,
        kind: savedScript.kind,
        source: savedScript.source,
        sourceHash: result.sourceHash,
        inputFeed: chartType === "renko" ? "CAUSAL_RENKO" : "SOURCE_OHLCV",
        inputValues: savedScript.inputValues,
        visible: true
      };
      onRunScript(activation, result);
      onClose();
    }
  };

  // Basic regex highlighters for the editor overlay
  const renderHighlightedCode = () => {
    const keywords = /\b(def|if|else|elif|and|or|not|in|for|while|return)\b/g;
    const builtins = /\b(plotshape|plot|alertcondition|alert|select|ta\.ema|ta\.sma|ta\.wma|ta\.rma|ta\.hma|ta\.cum|ta\.rsi|ta\.atr|ta\.stdev|ta\.highest|ta\.lowest|ta\.percentile_linear_interpolation|ta\.shift|ta\.change|ta\.crossover|ta\.crossunder|strategy\.entry|strategy\.exit|input\.int|input\.float|input\.bool|input\.string|math\.abs|math\.sqrt|math\.max|math\.min|nz)\b/g;
    const strings = /(["'])(?:(?=(\\?))\2.)*?\1/g;
    const comments = /(#.*)/g;
    const numbers = /\b(\d+(?:\.\d+)?)\b/g;

    return source.split("\n").map((line, idx) => {
      const lineNum = idx + 1;
      let html = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Apply highlights
      html = html.replace(comments, '<span style="color: #727b85; font-style: italic;">$1</span>');
      html = html.replace(strings, '<span style="color: #ffb86c;">$&</span>');
      html = html.replace(keywords, '<span style="color: #ff5555; font-weight: bold;">$1</span>');
      html = html.replace(builtins, '<span style="color: #50fa7b;">$1</span>');
      html = html.replace(numbers, '<span style="color: #bd93f9;">$1</span>');

      const isErrorLine = highlightedLine === lineNum;

      return (
        <div
          key={idx}
          style={{
            background: isErrorLine ? "rgba(255, 0, 0, 0.12)" : "transparent",
            borderLeft: isErrorLine ? "2px solid var(--red-hot)" : "2px solid transparent",
            paddingLeft: "6px",
            lineHeight: "1.6",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all"
          }}
          dangerouslySetInnerHTML={{ __html: html || " " }}
        />
      );
    });
  };

  return (
    <div className="script-editor-container" style={{
      display: "flex",
      height: "100%",
      background: "var(--bg-black)",
      borderTop: "1px solid var(--line)"
    }}>
      {/* Scripts Sidebar */}
      <div className="script-sidebar" style={{
        width: "210px",
        borderRight: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        background: "rgba(5, 6, 7, 0.95)"
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
          <span style={{ fontSize: "10px", fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", color: "var(--muted)", letterSpacing: "0.06em" }}>SAVED SCRIPTS</span>
          <button type="button" onClick={createNewScript} style={{
            background: "transparent",
            border: 0,
            color: "var(--strong)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center"
          }} title="New script">
            <Plus size={16} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {scripts.length === 0 ? (
            <div style={{ padding: "16px", fontSize: "10px", color: "var(--dim)", fontStyle: "italic", textAlign: "center" }}>
              No saved scripts
            </div>
          ) : (
            scripts.map(s => (
              <div
                key={s.id}
                onClick={() => loadScriptIntoEditor(s)}
                style={{
                  padding: "8px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                  background: selectedScriptId === s.id ? "rgba(255, 0, 0, 0.05)" : "transparent",
                  borderLeft: selectedScriptId === s.id ? "2px solid var(--red-hot)" : "2px solid transparent",
                  transition: "all 0.15s"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                  <FileCode size={12} style={{ color: s.kind === "strategy" ? "#ffaa00" : "#50fa7b", flexShrink: 0 }} />
                  <span style={{
                    fontSize: "11px",
                    fontFamily: "IBM Plex Mono, monospace",
                    color: selectedScriptId === s.id ? "var(--strong)" : "var(--text)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                  }}>{s.name}</span>
                  {loadedScriptIds.includes(s.id) && (
                    <span style={{
                      border: "1px solid rgba(80,250,123,0.45)",
                      borderRadius: "2px",
                      color: "#50fa7b",
                      fontFamily: "var(--font-mono)",
                      fontSize: "7px",
                      letterSpacing: "0.06em",
                      padding: "1px 3px"
                    }}>ON CHART</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => void deleteScript(s.id, e)}
                  disabled={storageBusy}
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "rgba(255,255,255,0.3)",
                    cursor: "pointer",
                    padding: "2px"
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.color = "var(--red-hot)")}
                  onMouseOut={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.3)")}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor & Console */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        height: "100%"
      }}>
        {/* Toolbar */}
        <div className="script-toolbar" style={{
          height: "48px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          background: "rgba(3, 4, 5, 0.98)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
            <label className="script-name-field" style={{
              display: "grid",
              gap: "3px",
              minWidth: "220px"
            }}>
              <span style={{
                color: "#d00024",
                fontFamily: "var(--font-mono)",
                fontSize: "7px",
                fontWeight: 800,
                letterSpacing: "0.11em"
              }}>
                {kind === "indicator" ? "INDICATOR NAME" : "STRATEGY NAME"}
              </span>
              <input
                ref={nameInputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "indicator" ? "Name this indicator" : "Name this strategy"}
                aria-label={kind === "indicator" ? "Indicator name" : "Strategy name"}
                maxLength={80}
                style={{
                  background: "rgba(0,0,0,0.72)",
                  border: "1px solid rgba(208,0,36,0.5)",
                  borderRadius: "3px",
                  color: "var(--strong)",
                  fontSize: "12px",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  width: "220px",
                  padding: "5px 7px",
                  outline: "none"
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--red-hot)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(208,0,36,0.5)")}
              />
            </label>
            <span style={{ fontSize: "9px", fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
              {exchange} / {symbol}
            </span>
            <span
              title={chartType === "renko"
                ? "Deterministic Python-style vector runtime on causal Renko. Historical bricks bootstrap from source-candle closes; new live bricks use canonical public trades and never rewrite after confirmation."
                : "Deterministic Python-style vector runtime on authoritative OHLCV. Imports, filesystem, network, loops and user-defined functions are intentionally unavailable."}
              style={{
                border: "1px solid rgba(196,0,36,0.55)",
                borderRadius: "3px",
                color: "#d8d8dc",
                fontFamily: "var(--font-mono)",
                fontSize: "8px",
                letterSpacing: "0.05em",
                padding: "3px 6px",
                whiteSpace: "nowrap"
              }}
            >
              {chartType === "renko" ? "CAUSAL RENKO · CLOSED-BRICK ALERTS" : "PYTHON VECTOR · CLOSED-BAR ALERTS"}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div className="script-kind-toggle" role="tablist" style={{ display: "flex", background: "rgba(0,0,0,0.3)", borderRadius: "3px", padding: "2px" }}>
              <button
                type="button"
                className={kind === "indicator" ? "active" : ""}
                onClick={() => setKind("indicator")}
                style={{
                  padding: "4px 8px",
                  fontSize: "9px",
                  fontFamily: "IBM Plex Mono, monospace",
                  fontWeight: 600,
                  border: 0,
                  background: kind === "indicator" ? "var(--red-hot)" : "transparent",
                  color: kind === "indicator" ? "#fff" : "var(--muted)",
                  borderRadius: "2px",
                  cursor: "pointer"
                }}
              >
                Indicator
              </button>
              <button
                type="button"
                className={kind === "strategy" ? "active" : ""}
                onClick={() => setKind("strategy")}
                style={{
                  padding: "4px 8px",
                  fontSize: "9px",
                  fontFamily: "IBM Plex Mono, monospace",
                  fontWeight: 600,
                  border: 0,
                  background: kind === "strategy" ? "var(--red-hot)" : "transparent",
                  color: kind === "strategy" ? "#fff" : "var(--muted)",
                  borderRadius: "2px",
                  cursor: "pointer"
                }}
              >
                Strategy
              </button>
            </div>

            <button type="button" onClick={() => void saveCurrentScript()} disabled={storageBusy} style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "var(--strong)",
              padding: "5px 10px",
              borderRadius: "3px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "10px",
              fontFamily: "IBM Plex Mono",
              cursor: storageBusy ? "wait" : "pointer",
              opacity: storageBusy ? 0.55 : 1
            }}>
              <Save size={12} /> Save
            </button>
            <button type="button" onClick={compileScript} style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "var(--strong)",
              padding: "5px 10px",
              borderRadius: "3px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "10px",
              fontFamily: "IBM Plex Mono",
              cursor: "pointer"
            }}>
              <TerminalSquare size={12} /> Compile
            </button>
            <button type="button" className="primary" onClick={() => void runScript()} disabled={storageBusy} style={{
              background: "var(--red-hot)",
              border: 0,
              color: "#fff",
              padding: "6px 12px",
              borderRadius: "3px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "10px",
              fontFamily: "IBM Plex Mono, monospace",
              fontWeight: 600,
              cursor: storageBusy ? "wait" : "pointer",
              opacity: storageBusy ? 0.55 : 1,
              boxShadow: "0 0 10px rgba(255,0,0,0.3)"
            }}>
              <Play size={12} /> Run / Add to chart
            </button>
            <button type="button" onClick={onClose} aria-label="Close Script Editor" title="Close Script Editor" style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "var(--muted)",
              width: "28px",
              height: "28px",
              borderRadius: "3px",
              display: "grid",
              placeItems: "center",
              cursor: "pointer"
            }}>
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Editor Area */}
        <div style={{
          flex: 1,
          position: "relative",
          background: "rgb(6, 7, 8)",
          overflow: "hidden"
        }}>
          {/* Highlight Overlay (below) */}
          <div style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            padding: "16px",
            color: "var(--text)",
            pointerEvents: "none",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all"
          }}>
            {renderHighlightedCode()}
          </div>

          {/* Transparent Textarea (above) */}
          <textarea
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{
              width: "100%",
              height: "100%",
              padding: "16px",
              background: "transparent",
              color: "transparent",
              caretColor: "var(--red-hot)",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              lineHeight: "1.6",
              border: 0,
              outline: "none",
              resize: "none",
              position: "absolute",
              top: 0,
              left: 0,
              zIndex: 1,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            }}
          />
        </div>

        {/* Compiler Console Output */}
        <div className="compiler-console" style={{
          height: "130px",
          background: "rgba(3, 4, 5, 0.98)",
          borderTop: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }}>
          <div style={{
            padding: "6px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
            fontSize: "9px",
            fontFamily: "IBM Plex Mono, monospace",
            fontWeight: 700,
            color: "var(--muted)",
            letterSpacing: "0.06em",
            display: "flex",
            alignItems: "center",
            gap: "6px"
          }}>
            CONSOLE OUTPUT
          </div>
          <div style={{
            flex: 1,
            padding: "12px 16px",
            overflowY: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            display: "flex",
            flexDirection: "column",
            gap: "6px"
          }}>
            {consoleLogs.length === 0 ? (
              <div style={{ color: "var(--dim)", fontStyle: "italic" }}>No compilation messages. Click "Compile" or "Run" to check your code.</div>
            ) : (
              consoleLogs.map((log, index) => (
                <div
                  key={index}
                  onClick={() => log.line && setHighlightedLine(log.line)}
                  style={{
                    color: log.type === "error" ? "var(--red-hot)" : "var(--green)",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: log.line ? "pointer" : "default"
                  }}
                >
                  {log.type === "error" ? <AlertTriangle size={12} /> : <CheckCircle size={12} />}
                  <span>{log.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
