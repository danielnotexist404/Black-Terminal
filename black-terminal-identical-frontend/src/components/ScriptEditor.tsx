import { useState, useEffect, useRef } from "react";
import { Play, Save, TerminalSquare, Trash2, Plus, FileCode, CheckCircle, AlertTriangle } from "lucide-react";
import { compileAndRunScript } from "./ScriptCompiler";
import type { CompiledPlot } from "./ScriptCompiler";
import { dbGetUsers, dbUpdateUser } from "../lib/supabase";

type ScriptEditorProps = {
  symbol: string;
  exchange: string;
  onCompiledPlots: (plots: CompiledPlot[]) => void;
  currentUser: { username: string; role: "admin" | "user" } | null;
};

type UserScript = {
  id: string;
  name: string;
  kind: "indicator" | "strategy";
  source: string;
  createdAt: number;
};

const templates = {
  indicator: `# Black-Terminal Python indicator
# Indicator scripts can plot values and trigger alerts.

length = input.int(21, "EMA Length")

ema_fast = ta.ema(close, length)
ema_slow = ta.ema(close, length * 3)

plot(ema_fast, color="#00ffcc", width=2)
plot(ema_slow, color="#ff0055", width=2)
`,
  strategy: `# Black-Terminal Python strategy
# Strategy scripts emit normalized signals for Strategy Lab.

length = input.int(14, "RSI Length")
rsi = ta.sma(close, length) # Simple RSI proxy

plot(rsi, color="#ffaa00", width=1)
`
};

export function ScriptEditor({ symbol, exchange, onCompiledPlots, currentUser }: ScriptEditorProps) {
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [name, setName] = useState("My Indicator");
  const [kind, setKind] = useState<"indicator" | "strategy">("indicator");
  const [source, setSource] = useState(templates.indicator);
  
  // Compiler state
  const [consoleLogs, setConsoleLogs] = useState<{ type: "success" | "error"; text: string; line?: number }[]>([]);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);

  // Load scripts
  useEffect(() => {
    const loadScripts = async () => {
      let stored: UserScript[] = [];
      if (currentUser) {
        try {
          const users = await dbGetUsers();
          const match = users.find(u => u.username === currentUser.username);
          if (match && match.scripts) {
            stored = match.scripts;
          }
        } catch (e) {
          console.error("Failed to load scripts from Supabase:", e);
        }
      }
      
      if (stored.length === 0) {
        const local = localStorage.getItem("bt_user_scripts");
        if (local) {
          try { stored = JSON.parse(local); } catch (e) {}
        }
      }

      setScripts(stored);
      if (stored.length > 0) {
        loadScriptIntoEditor(stored[0]);
      }
    };
    loadScripts();
  }, [currentUser]);

  // Save scripts to local/Supabase
  const saveScriptsCollection = async (updated: UserScript[]) => {
    setScripts(updated);
    localStorage.setItem("bt_user_scripts", JSON.stringify(updated));
    if (currentUser) {
      try {
        await dbUpdateUser(currentUser.username, { scripts: updated });
      } catch (e) {
        console.error("Failed to sync scripts to Supabase:", e);
      }
    }
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
    setName("Untitled Script");
    setKind("indicator");
    setSource(templates.indicator);
    setConsoleLogs([]);
    setHighlightedLine(null);
  };

  const saveCurrentScript = () => {
    const id = selectedScriptId || `script-${Date.now()}`;
    const newScript: UserScript = {
      id,
      name: name.trim() || "Untitled Script",
      kind,
      source,
      createdAt: Date.now()
    };

    let nextScripts: UserScript[];
    if (selectedScriptId) {
      nextScripts = scripts.map(s => s.id === id ? newScript : s);
    } else {
      nextScripts = [newScript, ...scripts];
      setSelectedScriptId(id);
    }
    saveScriptsCollection(nextScripts);
    setConsoleLogs([{ type: "success", text: `Script "${newScript.name}" saved successfully.` }]);
  };

  const deleteScript = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const script = scripts.find(s => s.id === id);
    if (!script) return;

    const confirm = window.confirm(`Are you sure you want to delete the selected script "${script.name}"?`);
    if (!confirm) return;

    const updated = scripts.filter(s => s.id !== id);
    saveScriptsCollection(updated);

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

    // Mock candle data fetch from local storage chart cache to run compilation against
    const cachedCandles = localStorage.getItem("bt_chart_candles_cache");
    const candles = cachedCandles ? JSON.parse(cachedCandles) : [];

    const result = compileAndRunScript(source, candles);
    if (result.success) {
      setConsoleLogs([
        { type: "success", text: "Compilation successful! Indicator ready to run." }
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

  const runScript = () => {
    const result = compileScript();
    if (result && result.success) {
      onCompiledPlots(result.plots);
      setConsoleLogs(prev => [...prev, { type: "success", text: "Successfully added custom indicator series to the active chart grid." }]);
    }
  };

  // Basic regex highlighters for the editor overlay
  const renderHighlightedCode = () => {
    const keywords = /\b(def|if|else|elif|and|or|not|in|for|while|return)\b/g;
    const builtins = /\b(plot|input|ta\.ema|ta\.sma|ta\.atr|ta\.crossover|ta\.crossunder|strategy\.entry|strategy\.exit|alert|input\.int|input\.float)\b/g;
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
                </div>
                <button
                  type="button"
                  onClick={(e) => deleteScript(s.id, e)}
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
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Script Name"
              style={{
                background: "transparent",
                border: 0,
                borderBottom: "1px solid transparent",
                color: "var(--strong)",
                fontSize: "13px",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                width: "150px",
                padding: "2px 0"
              }}
              onFocus={(e) => (e.currentTarget.style.borderBottomColor = "var(--red-hot)")}
              onBlur={(e) => (e.currentTarget.style.borderBottomColor = "transparent")}
            />
            <span style={{ fontSize: "9px", fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
              {exchange} / {symbol}
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

            <button type="button" onClick={saveCurrentScript} style={{
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
            <button type="button" className="primary" onClick={runScript} style={{
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
              cursor: "pointer",
              boxShadow: "0 0 10px rgba(255,0,0,0.3)"
            }}>
              <Play size={12} /> Run
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
