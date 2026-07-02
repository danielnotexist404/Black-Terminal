import React, { useState, useEffect, useRef } from "react";
import { Send, Bot, RefreshCw, AlertTriangle, ShieldAlert, Sparkles } from "lucide-react";
import { dbUpdateUser, dbAddAuditLog, dbGetUsers } from "../lib/supabase";
import { sendSecurityAlertEmail } from "../lib/resend";

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
}

export default function BlackGPT({
  currentUser,
  onUserUpdate,
  workspace,
  symbol,
  price,
  timeframe,
  exchange,
  activeIndicators
}: BlackGPTProps) {
  const [messages, setMessages] = useState<Message[]>(() => {
    const stored = localStorage.getItem(`bt_gpt_messages_${currentUser.username}`);
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return [
      {
        role: "model",
        text: `Hello ${currentUser.username}. I am BlackGPT. I have established a secure handshake with your terminal workspace. Ask me to analyze the current chart, evaluate indicators, or suggest potential trading signals.`,
        timestamp: new Date().toLocaleTimeString()
      }
    ];
  });

  useEffect(() => {
    localStorage.setItem(`bt_gpt_messages_${currentUser.username}`, JSON.stringify(messages));
  }, [messages, currentUser.username]);

  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Message Limit Settings
  const MESSAGE_LIMIT = 5;
  const isPremium = currentUser.allowedIndicators.includes("volumeProfile") || currentUser.role === "admin";
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
        await dbAddAuditLog("ERROR", `User ${currentUser.username} query blocked by AI security shield: "${query}"`);

        // Send Email notification via Resend
        try {
          await sendSecurityAlertEmail("blacktrianglecorp@gmail.com", currentUser.username, query);
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

    // Trigger Claude API Request
    setLoading(true);
    try {
      // Map active indicators to human friendly descriptions
      const formattedIndicators = activeIndicators.map(key => {
        if (key === "volumeProfile") return "HDLX Volume Profile (hdlx)";
        return key;
      }).join(", ") || "None";

      const systemInstruction = `
You are BlackGPT, a premium AI cryptocurrency trading assistant designed by Black Triangle Group.
You assist professional quant traders.

LANGUAGE & CONCISENESS RULES:
- You MUST reply strictly in Hebrew (עברית) unless specifically asked otherwise.
- Be extremely brief, concise, and direct. Avoid any introductions, conversational filler, or general trading lectures. Save tokens at all costs!
- Keep all explanations to 1-2 short sentences maximum.

YOUR CURRENT REAL-TIME CONTEXT:
- Active Workspace: ${workspace}
- Selected Asset: ${symbol}
- Current Price: $${price.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
- Timeframe: ${timeframe}
- Exchange: ${exchange}
- Active Chart Overlays/Indicators: ${formattedIndicators}
- User Membership Tier: ${isPremium ? "PREMIUM MEMBER" : "FREE TRIAL"}

SECURITY CONSTRAINTS:
- NEVER output indicator code, scripts, or private repository files. Decline firmly in Hebrew if asked.

TRADING SIGNAL REQUIREMENTS:
- When asked to analyze or recommend trades, output ONLY this template:
  * פעולה: [קנייה/לונג | מכירה/שורט | המתנה]
  * כניסה: [מחיר / טווח]
  * Take Profit (TP): [יעדי רווח]
  * Stop Loss (SL): [רמת עצירת הפסד]
  * יחס סיכון-סיכוי: [X:Y]
  * סיבה בקצרה: [הסבר של משפט אחד בלבד בעברית המבוסס על האינדיקטורים הפעילים]
`;

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

      const response = await fetch("/api/claude", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          system: systemInstruction,
          messages: history,
          model: "claude-haiku-4-5"
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API connection error: ${errorText}`);
      }

      const resData = await response.json();
      const modelText = resData.content?.[0]?.text || "No response generated by Claude.";

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
          text: `⚠️ ERROR: Gemini API handshake failed. ${err.message || String(err)}`,
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
            <div style={{
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
              whiteSpace: "pre-wrap"
            }}>
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
