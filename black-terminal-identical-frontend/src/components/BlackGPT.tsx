import React, { useState, useEffect, useRef } from "react";
import { Send, Bot, RefreshCw, AlertTriangle, ShieldAlert, Sparkles } from "lucide-react";
import { dbUpdateUser, dbAddAuditLog, supabase } from "../lib/supabase";
import { sendSecurityAlertEmail } from "../lib/resend";
import { getLocalDocument, putLocalDocument } from "../core/local-runtime/localDocumentStore";
import { isLocalOnlyRuntime } from "../core/local-runtime/localRuntimeClient";
import { requestLocalAiChat } from "../core/local-runtime/localAiClient";

interface Message {
  role: "user" | "model" | "system";
  text: string;
  timestamp: string;
}

interface BlackGPTProps {
  currentUser: {
    username: string;
    role: "admin" | "user";
    allowedIndicators: string[];
    aiMessagesCount?: number;
    aiLastMessageTimestamp?: string;
  };
  onUserUpdate: (updated: any) => void;
  // Context injections
  workspace: string;
  symbol: string;
  price: number;
  timeframe: string;
  exchange: string;
  activeIndicators: string[];
  recentCandles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}
const isHebrew = (text: string): boolean => {
  return /[\u0590-\u05FF]/.test(text);
};
export default function BlackGPT({
  currentUser,
  onUserUpdate,
  workspace,
  symbol,
  price,
  timeframe,
  exchange,
  activeIndicators,
  recentCandles = []
}: BlackGPTProps) {
  const localOnly = isLocalOnlyRuntime();
  const localChatHydrated = useRef(false);
  const localChatKey = currentUser.username.toLowerCase().replace(/[^a-z0-9@._-]/g, "-").slice(0, 120) || "owner";
  const [messages, setMessages] = useState<Message[]>(() => {
    if (localOnly) return [defaultWelcomeMessage(currentUser.username)];
    const stored = localStorage.getItem(`bt_gpt_messages_${currentUser.username}`);
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return [
      defaultWelcomeMessage(currentUser.username)
    ];
  });

  useEffect(() => {
    if (!localOnly) return;
    let active = true;
    void getLocalDocument<Message[]>("local-ai-chats", localChatKey).then((document) => {
      if (!active) return;
      if (document?.value.length) setMessages(document.value);
      localStorage.removeItem(`bt_gpt_messages_${currentUser.username}`);
      localChatHydrated.current = true;
    }).catch(() => { localChatHydrated.current = true; });
    return () => { active = false; };
  }, [currentUser.username, localChatKey, localOnly]);

  useEffect(() => {
    if (localOnly) {
      if (localChatHydrated.current) void putLocalDocument("local-ai-chats", localChatKey, messages).catch((error) => console.error("Encrypted local BlackGPT history could not be saved", error));
      return;
    }
    localStorage.setItem(`bt_gpt_messages_${currentUser.username}`, JSON.stringify(messages));
  }, [localChatKey, localOnly, messages, currentUser.username]);

  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Message Limit Settings
  const MESSAGE_LIMIT = 5;
  const isPremium = localOnly || currentUser.allowedIndicators.includes("volumeProfile") || currentUser.role === "admin";
  const messagesCount = currentUser.aiMessagesCount || 0;
  const lastTimestamp = currentUser.aiLastMessageTimestamp || "";

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Check and handle daily token resets
  const getRemainingTime = () => {
    if (!lastTimestamp) return "24 hours";
    const lastDate = new Date(lastTimestamp).getTime();
    const nextReset = lastDate + 24 * 60 * 60 * 1000;
    const diff = nextReset - Date.now();
    if (diff <= 0) return "0h 0m";
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = inputValue.trim();
    if (!query || loading) return;

    setErrorMsg("");
    setInputValue("");

    // Add user message to chat UI immediately
    const userMsg: Message = {
      role: "user",
      text: query,
      timestamp: new Date().toLocaleTimeString()
    };
    setMessages(prev => [...prev, userMsg]);

    // Check query limits for free users
    if (!isPremium) {
      let currentCount = messagesCount;
      let currentTimestamp = lastTimestamp;

      const now = Date.now();
      const lastTime = currentTimestamp ? new Date(currentTimestamp).getTime() : 0;
      const twentyFourHours = 24 * 60 * 60 * 1000;

      // If 24 hours have passed, reset counter
      if (now - lastTime >= twentyFourHours) {
        currentCount = 0;
        currentTimestamp = new Date().toISOString();
        await dbUpdateUser(currentUser.username, {
          aiMessagesCount: 0,
          aiLastMessageTimestamp: currentTimestamp
        });
        // Sync parent user state
        onUserUpdate({
          ...currentUser,
          aiMessagesCount: 0,
          aiLastMessageTimestamp: currentTimestamp
        });
      }

      if (currentCount >= MESSAGE_LIMIT) {
        const resetIn = getRemainingTime();
        setMessages(prev => [
          ...prev,
          {
            role: "system",
            text: `⚠️ DAILY ALLOWANCE EXCEEDED: You have used all ${MESSAGE_LIMIT} free queries. Please upgrade to a Premium plan to unlock unlimited AI computations, or wait ${resetIn} for reset.`,
            timestamp: new Date().toLocaleTimeString()
          }
        ]);
        return;
      }
    }

    // Security Check: Block Source Code Leaks
    const forbiddenKeywords = [
      "source code", "source-code", "קוד מקור", "code of", "script of", "indicator code", 
      "indicator script", "hdlx code", "volume profile code", "heatmap code", 
      "strategy lab code", "website code", "api endpoint", "supabase key"
    ];

    const containsForbidden = forbiddenKeywords.some(kw => query.toLowerCase().includes(kw));
    if (containsForbidden) {
      setLoading(true);
      setTimeout(async () => {
        setLoading(false);
        setMessages(prev => [
          ...prev,
          {
            role: "system",
            text: `🚫 SECURITY SHIELD TRIGGERED: Request denied. BlackGPT is not authorized to share internal proprietary source code, scripts, or application files.`,
            timestamp: new Date().toLocaleTimeString()
          }
        ]);

        // Audit Log
        if (localOnly) await appendLocalAiAudit(currentUser.username, "AI security shield blocked a prohibited request.");
        else await dbAddAuditLog("ERROR", `AI security shield blocked a prohibited request for user ${currentUser.username}.`);

        // Send Email notification via Resend
        try {
          if (localOnly) return;
          await sendSecurityAlertEmail(currentUser.username);
        } catch (e) {
          console.error("Failed to send security alert email:", e);
        }
      }, 800);
      return;
    }

    // Increment message counter in database
    if (!isPremium) {
      const nextCount = messagesCount + 1;
      const tstamp = lastTimestamp ? lastTimestamp : new Date().toISOString();
      await dbUpdateUser(currentUser.username, {
        aiMessagesCount: nextCount,
        aiLastMessageTimestamp: tstamp
      });
      onUserUpdate({
        ...currentUser,
        aiMessagesCount: nextCount,
        aiLastMessageTimestamp: tstamp
      });
    }

    // Trigger the selected local or hosted AI provider.
    setLoading(true);
    try {
      // Map active indicators to human friendly descriptions
      const formattedIndicators = activeIndicators.map(key => {
        if (key === "volumeProfile") return "HDLX Volume Profile (hdlx)";
        return key;
      }).join(", ") || "None";

      // Format last 10 candles as OHLC table for chart context
      const formatTime = (unix: number) => {
        const d = new Date(unix * 1000);
        return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      };
      const candleRows = recentCandles.slice(-10).map(c =>
        `  ${formatTime(c.time)} | O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)} V:${c.volume.toFixed(0)}`
      ).join("\n");
      const chartDataBlock = recentCandles.length > 0
        ? `\nLIVE CHART OHLCV DATA (last ${recentCandles.slice(-10).length} candles, timeframe ${timeframe}):\n${candleRows}\n`
        : `\nNote: Chart data is still loading (no candles received yet). Use real-world knowledge for the asset the user is asking about.\n`;

      const msgRoleMap = { model: "assistant" } as const;
      // Map chat history (excluding system logs) to Anthropic Messages schema
      const history = messages
        .filter(m => m.role === "user" || msgRoleMap[m.role as keyof typeof msgRoleMap])
        .map(m => ({
          role: m.role === "user" ? "user" as const : "assistant" as const,
          content: m.text
        }));

      // Append latest user query
      history.push({
        role: "user",
        content: query
      });

      let modelText: string;
      if (localOnly) {
        const localResponse = await requestLocalAiChat(history, [
          "You are BlackGPT, Black Terminal's local market-analysis assistant.",
          "Treat the supplied chart data as context, never as proof of future performance.",
          "Never claim certainty, guaranteed profit, or that a live order has executed unless an execution receipt is supplied.",
          `Workspace: ${workspace}; market: ${exchange} ${symbol}; price: ${price}; timeframe: ${timeframe}; active indicators: ${formattedIndicators}.`,
          chartDataBlock.slice(0, 12000)
        ].join("\n"));
        modelText = localResponse.content;
      } else {
        const { data: authData } = await supabase!.auth.getSession();
        const authToken = authData.session?.access_token;
        if (!authToken) throw new Error("Sign in again before using BlackGPT.");
        const response = await fetch("/api/claude", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({
            messages: history,
            context: {
              workspace,
              symbol,
              price,
              timeframe,
              exchange,
              indicators: formattedIndicators,
              chartSummary: chartDataBlock.slice(0, 12000)
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Hosted BlackGPT connection error: ${errorText}`);
        }

        const resData = await response.json();
        modelText = resData.content?.[0]?.text || "No response generated by the hosted BlackGPT provider.";
      }

      setLoading(false);
      setMessages(prev => [
        ...prev,
        {
          role: "model",
          text: modelText,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    } catch (err: any) {
      setLoading(false);
      setMessages(prev => [
        ...prev,
        {
          role: "system",
          text: `⚠️ ERROR: BlackGPT provider handshake failed. ${err.message || String(err)}`,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    }
  };

  const [errorMsg, setErrorMsg] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0c10", borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
      {/* Header telemetry info */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", background: "rgba(18, 22, 28, 0.95)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Sparkles style={{ color: "var(--red-hot)" }} size={16} />
          <span style={{ fontFamily: "IBM Plex Mono", fontSize: "12px", fontWeight: 700, letterSpacing: "1px", color: "#fff" }}>
            BLACKGPT <span style={{ color: "var(--red-hot)", fontSize: "9px", verticalAlign: "super" }}>v1.2</span>
          </span>
        </div>

        {/* Telemetry connection status */}
        <div style={{ display: "flex", alignItems: "center", gap: "15px", fontSize: "10px", fontFamily: "IBM Plex Mono" }}>
          <span style={{ color: "var(--dim)" }}>
            WORKSPACE: <strong style={{ color: "#fff" }}>{workspace.toUpperCase()}</strong>
          </span>
          <span style={{ color: "var(--dim)" }}>
            FEED: <strong style={{ color: "#00ff66" }}>{symbol} @ ${price.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong>
          </span>
          
          {/* Daily limit badge for non-premium */}
          {!isPremium ? (
            <span style={{
              background: messagesCount >= MESSAGE_LIMIT ? "rgba(255,0,0,0.15)" : "rgba(255,255,255,0.05)",
              border: messagesCount >= MESSAGE_LIMIT ? "1px solid var(--red-hot)" : "1px solid rgba(255,255,255,0.1)",
              borderRadius: "3px", padding: "2px 8px", color: messagesCount >= MESSAGE_LIMIT ? "var(--red-hot)" : "#fff", fontWeight: 700
            }}>
              QUERIES: {MESSAGE_LIMIT - messagesCount}/{MESSAGE_LIMIT}
            </span>
          ) : (
            <span style={{ background: "rgba(0,255,102,0.1)", border: "1px solid #00ff66", borderRadius: "3px", padding: "2px 8px", color: "#00ff66", fontWeight: 700 }}>
              PREMIUM UNLIMITED
            </span>
          )}
        </div>
      </div>

      {/* Messages viewport container */}
      <div style={{ flex: 1, padding: "20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "16px" }}>
        {messages.map((msg, i) => (
          <div 
            key={i} 
            style={{ 
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              display: "flex",
              flexDirection: "column",
              alignItems: msg.role === "user" ? "flex-end" : "flex-start"
            }}
          >
            <div 
              dir={isHebrew(msg.text) ? "rtl" : "ltr"}
              style={{
                background: msg.role === "user" 
                  ? "var(--red-hot)" 
                  : msg.role === "system" 
                    ? "rgba(255,0,68,0.05)" 
                    : "rgba(18,22,28,0.95)",
                border: msg.role === "user" 
                  ? "none" 
                  : msg.role === "system" 
                    ? "1px solid rgba(255,0,68,0.3)" 
                    : "1px solid rgba(255,255,255,0.06)",
                borderRadius: "6px",
                padding: "12px 16px",
                color: msg.role === "system" ? "var(--red-hot)" : "#fff",
                fontSize: "12px",
                lineHeight: "1.6",
                fontFamily: msg.role === "user" ? "sans-serif" : "inherit",
                whiteSpace: "pre-wrap",
                direction: isHebrew(msg.text) ? "rtl" : "ltr",
                textAlign: isHebrew(msg.text) ? "right" : "left"
              }}
            >
              {msg.role === "system" && <ShieldAlert size={14} style={{ display: "inline", marginRight: "6px", verticalAlign: "middle" }} />}
              {msg.text}
            </div>
            <span style={{ fontSize: "8px", color: "var(--dim)", marginTop: "4px", fontFamily: "IBM Plex Mono" }}>
              {msg.role.toUpperCase()} &bull; {msg.timestamp}
            </span>
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: "8px", background: "rgba(18,22,28,0.95)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px", padding: "12px 16px" }}>
            <RefreshCw size={12} className="spin" style={{ color: "var(--red-hot)" }} />
            <span style={{ fontFamily: "IBM Plex Mono", fontSize: "10px", color: "var(--dim)" }}>BlackGPT analyzing workspace context...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input controls form footer */}
      <form onSubmit={handleSendMessage} style={{ display: "flex", gap: "10px", padding: "16px 20px", background: "rgba(18, 22, 28, 0.95)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <input 
          type="text" 
          value={inputValue}
          placeholder={(!isPremium && messagesCount >= MESSAGE_LIMIT) ? "Daily limit reached. Upgrade to unlock." : "Ask BlackGPT... (e.g., 'Analyze the current layout for entry triggers')"}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={loading || (!isPremium && messagesCount >= MESSAGE_LIMIT)}
          style={{
            flex: 1,
            height: "40px",
            background: "rgba(3, 4, 5, 0.85)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "3px",
            padding: "0 15px",
            color: "#fff",
            fontFamily: "IBM Plex Mono",
            fontSize: "12px",
            outline: "none"
          }}
          className="login-input"
        />
        <button 
          type="submit" 
          disabled={loading || !inputValue.trim() || (!isPremium && messagesCount >= MESSAGE_LIMIT)}
          style={{
            width: "40px", height: "40px",
            background: "linear-gradient(180deg, #ff0000 0%, #aa0000 100%)",
            border: "1px solid #ff0000",
            borderRadius: "3px", color: "#fff",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
          }}
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}

function defaultWelcomeMessage(username: string): Message {
  return {
    role: "model",
    text: `Welcome ${username}. BlackGPT is ready to analyze the active workspace and the chart context supplied by Black Terminal. Verify every conclusion independently before risking capital.`,
    timestamp: new Date().toLocaleTimeString()
  };
}

async function appendLocalAiAudit(username: string, message: string) {
  const key = username.toLowerCase().replace(/[^a-z0-9@._-]/g, "-").slice(0, 120) || "owner";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getLocalDocument<Array<{ level: string; message: string; timestamp: string }>>("local-ai-audit", key);
    const value = [
      ...(current?.value ?? []),
      { level: "ERROR", message, timestamp: new Date().toISOString() }
    ].slice(-500);
    try {
      await putLocalDocument("local-ai-audit", key, value, current?.revision ?? 0);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
