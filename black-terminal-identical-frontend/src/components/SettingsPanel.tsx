import React, { useState, useEffect } from "react";
import { Shield, Lock, Eye, Mail, Key, Check, AlertTriangle, Database, Sliders, Clock, Layout } from "lucide-react";
import { dbUpdateUser, isSupabaseConfigured } from "../lib/supabase";
import "../styles/settings.css";

interface TerminalSettings {
  showDOM: boolean;
  enabledTimeframes: string[];
  theme?: string;
  priceLineColor?: string;
  priceLineIntensity?: number;
}

interface SettingsPanelProps {
  currentUser: {
    username: string;
    role: "admin" | "user";
    allowedIndicators: string[];
  };
  terminalSettings: TerminalSettings;
  onSettingsChange: (settings: TerminalSettings) => void;
  onClose: () => void;
}

const AVAILABLE_TIMEFRAMES = [
  { label: "10s", value: "10s" },
  { label: "30s", value: "30s" },
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "12H", value: "12h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "1M", value: "1M" },
  { label: "10t", value: "10t" },
  { label: "100t", value: "100t" }
];

export const THEMES = [
  { id: "black-terminal", label: "Black Terminal (Default)", accent: "#ff0000", bg: "#050607" },
  { id: "tradingview", label: "TradingView Blue", accent: "#2962ff", bg: "#131722" },
  { id: "monochrome", label: "Monochrome Minimal", accent: "#ffffff", bg: "#0a0a0a" },
  { id: "emerald", label: "Emerald Matrix", accent: "#00ff88", bg: "#050806" }
];

export function SettingsPanel({ currentUser, terminalSettings, onSettingsChange, onClose }: SettingsPanelProps) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // Local alert configs
  const [webhookUrl, setWebhookUrl] = useState("");
  const [alertEmail, setAlertEmail] = useState("");

  useEffect(() => {
    setWebhookUrl(localStorage.getItem("bt_webhook_url") || "");
    setAlertEmail(localStorage.getItem("bt_alert_email") || "");
  }, []);

  const handleSaveLocalSettings = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem("bt_webhook_url", webhookUrl.trim());
    localStorage.setItem("bt_alert_email", alertEmail.trim());
    setSuccessMsg("System configuration saved!");
    setTimeout(() => setSuccessMsg(""), 3000);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    if (!oldPassword || !newPassword || !confirmPassword) {
      setErrorMsg("Please fill all password fields");
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMsg("New passwords do not match");
      return;
    }

    if (newPassword.length < 6) {
      setErrorMsg("New password must be at least 6 characters");
      return;
    }

    setLoading(true);

    try {
      await dbUpdateUser(currentUser.username, { password: newPassword });
      setSuccessMsg("Security credentials updated successfully!");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to update security keys");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTimeframe = (tfValue: string) => {
    let nextTfs = [...terminalSettings.enabledTimeframes];
    if (nextTfs.includes(tfValue)) {
      if (nextTfs.length <= 1) {
        return; // Prevent turning off all timeframes
      }
      nextTfs = nextTfs.filter((t) => t !== tfValue);
    } else {
      nextTfs.push(tfValue);
    }
    onSettingsChange({
      ...terminalSettings,
      enabledTimeframes: nextTfs
    });
  };

  return (
    <div className="settings-panel-container">
      <div className="settings-header">
        <div className="settings-title-group">
          <span className="settings-title-badge">TERMINAL CORE</span>
          <h1 className="settings-title">WORKSPACE CONFIGURATION</h1>
        </div>
        <button className="settings-close-btn" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      <div className="settings-content">
        {/* Left Side: System & Database Status */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div className="settings-section card">
            <h2 className="settings-sec-title">
              <Database size={16} /> SYSTEM TELEMETRY
            </h2>
            
            <div className="telemetry-status-box">
              <div className="telemetry-row">
                <span className="telemetry-lbl">Identity Name</span>
                <span className="telemetry-val highlight">{currentUser.username}</span>
              </div>
              <div className="telemetry-row">
                <span className="telemetry-lbl">Access Privileges</span>
                <span className="telemetry-val highlight" style={{ color: currentUser.role === "admin" ? "var(--red-hot)" : "var(--green)" }}>
                  {currentUser.role.toUpperCase()}
                </span>
              </div>
              <div className="telemetry-row">
                <span className="telemetry-lbl">Database Hook</span>
                <span className="telemetry-val" style={{ color: isSupabaseConfigured ? "var(--green)" : "var(--dim)" }}>
                  {isSupabaseConfigured ? "CONNECTED (SUPABASE)" : "LOCAL STORAGE FALLBACK"}
                </span>
              </div>
            </div>

            <h3 className="settings-subsection-title">Authorized Indicators</h3>
            <div className="allowed-indicators-grid">
              {currentUser.allowedIndicators.map((ind) => (
                <span key={ind} className="indicator-badge">
                  <Check size={10} /> {ind}
                </span>
              ))}
            </div>
          </div>

          {/* New Panel: Advanced Interface Customization (TradingView Style) */}
          <div className="settings-section card">
            <h2 className="settings-sec-title">
              <Sliders size={16} /> INTERFACE & LAYOUT
            </h2>

            {/* Theme Selector */}
            <div className="settings-field" style={{ marginBottom: "18px" }}>
              <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Theme & Accent Color</label>
              <span className="settings-hint" style={{ marginBottom: "8px" }}>Change primary accent color and terminal grid background style</span>
              <select
                value={terminalSettings.theme || "black-terminal"}
                onChange={(e) => {
                  const newTheme = e.target.value;
                  onSettingsChange({
                    ...terminalSettings,
                    theme: newTheme
                  });
                  const t = THEMES.find(item => item.id === newTheme) || THEMES[0];
                  document.documentElement.style.setProperty("--red-hot", t.accent);
                  document.documentElement.style.setProperty("--red", t.accent === "#ffffff" ? "#888888" : t.accent === "#2962ff" ? "#1d4ed8" : t.accent);
                  document.documentElement.style.setProperty("--bg", t.bg);
                  if (newTheme === "emerald") {
                    document.documentElement.style.setProperty("--green", "#00ff88");
                  } else {
                    document.documentElement.style.setProperty("--green", "#46b866");
                  }
                }}
                className="settings-input"
                style={{ background: "rgba(0,0,0,0.3)", color: "var(--strong)", border: "1px solid rgba(255,255,255,0.08)", height: "34px", padding: "0 10px" }}
              >
                {THEMES.map(theme => (
                  <option key={theme.id} value={theme.id}>{theme.label}</option>
                ))}
              </select>
            </div>

            <div className="settings-field" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "20px" }}>
              <div>
                <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Order Book panel (DOM)</label>
                <span className="settings-hint">Toggle visibility of the right-hand depth book & market stats panel</span>
              </div>
              <input
                type="checkbox"
                checked={terminalSettings.showDOM}
                onChange={(e) => onSettingsChange({ ...terminalSettings, showDOM: e.target.checked })}
                style={{ width: "20px", height: "20px", cursor: "pointer", accentColor: "var(--red-hot)" }}
              />
            </div>

            <div className="settings-field" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "20px" }}>
              <div>
                <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Price Line Color</label>
                <span className="settings-hint">Color of the horizontal line showing the current price</span>
              </div>
              <select
                value={terminalSettings.priceLineColor ?? ""}
                onChange={(e) => onSettingsChange({ ...terminalSettings, priceLineColor: e.target.value })}
                style={{
                  width: "140px",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  background: "#0c0f12",
                  border: "1px solid #20262e",
                  color: "#fff",
                  fontSize: "11px",
                  cursor: "pointer"
                }}
              >
                <option value="">Dynamic (Green/Red)</option>
                <option value="#ffffff">White</option>
                <option value="#888888">Gray</option>
                <option value="#00ff66">Green</option>
                <option value="#ff101b">Red</option>
                <option value="#2962ff">Blue</option>
                <option value="#f59f18">Yellow</option>
                <option value="#ff00aa">Pink</option>
              </select>
            </div>

            <div className="settings-field" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label className="settings-label" style={{ fontSize: "11px" }}>Price Line Opacity</label>
                <span style={{ fontSize: "10px", color: "var(--dim)" }}>{terminalSettings.priceLineIntensity ?? 75}%</span>
              </div>
              <span className="settings-hint">Brightness and opacity of the current price level line</span>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={terminalSettings.priceLineIntensity ?? 75}
                onChange={(e) => onSettingsChange({ ...terminalSettings, priceLineIntensity: Number(e.target.value) })}
                style={{
                  width: "100%",
                  cursor: "pointer",
                  accentColor: "var(--red-hot)",
                  background: "#20262e",
                  height: "4px",
                  borderRadius: "2px",
                  appearance: "none"
                }}
              />
            </div>

            {/* Timeframe Visibility Selection */}
            <div className="settings-field">
              <label className="settings-label" style={{ fontSize: "11px" }}>
                <Clock size={12} style={{ display: "inline", marginRight: "6px" }} /> Visible Top-Bar Timeframes
              </label>
              <span className="settings-hint" style={{ marginBottom: "10px" }}>Select which intervals appear directly on your topbar panel</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {AVAILABLE_TIMEFRAMES.map((tf) => {
                  const isChecked = terminalSettings.enabledTimeframes.includes(tf.value);
                  return (
                    <button
                      key={tf.value}
                      type="button"
                      onClick={() => handleToggleTimeframe(tf.value)}
                      style={{
                        padding: "6px 12px",
                        fontSize: "11px",
                        fontFamily: "IBM Plex Mono, monospace",
                        background: isChecked ? "rgba(255, 0, 0, 0.15)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${isChecked ? "var(--red-hot)" : "rgba(255,255,255,0.08)"}`,
                        color: isChecked ? "var(--strong)" : "var(--muted)",
                        borderRadius: "3px",
                        cursor: "pointer",
                        transition: "all 0.2s"
                      }}
                    >
                      {tf.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Configuration Forms */}
        <div className="settings-forms-col">
          {/* Form 1: Core System Webhooks */}
          <form className="settings-section card" onSubmit={handleSaveLocalSettings}>
            <h2 className="settings-sec-title">
              <Shield size={16} /> ALERTS & WEBHOOKS
            </h2>
            {successMsg && <div className="settings-success-msg">{successMsg}</div>}
            
            <div className="settings-field">
              <label className="settings-label">Security Alert Webhook URL</label>
              <input
                className="settings-input"
                type="text"
                value={webhookUrl}
                placeholder="https://discord.com/api/webhooks/..."
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <span className="settings-hint">Trigger Discord/Slack message on liquidity deltas</span>
            </div>

            <div className="settings-field">
              <label className="settings-label">Fallback Email Node</label>
              <input
                className="settings-input"
                type="email"
                value={alertEmail}
                placeholder="alerts@domain.com"
                onChange={(e) => setAlertEmail(e.target.value)}
              />
              <span className="settings-hint">Receive notifications for order book block updates</span>
            </div>

            <button className="settings-submit-btn" type="submit">
              Save Webhook Configuration
            </button>
          </form>

          {/* Form 2: Password Update */}
          <form className="settings-section card" onSubmit={handleChangePassword}>
            <h2 className="settings-sec-title">
              <Lock size={16} /> CHANGE ACCESS CODE
            </h2>
            {errorMsg && <div className="settings-error-msg">{errorMsg}</div>}
            
            <div className="settings-field">
              <label className="settings-label">Current Access Code</label>
              <input
                className="settings-input"
                type="password"
                value={oldPassword}
                placeholder="CURRENT PASSWORD"
                onChange={(e) => setOldPassword(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label">New Access Code</label>
              <input
                className="settings-input"
                type="password"
                value={newPassword}
                placeholder="NEW PASSWORD"
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label">Confirm New Access Code</label>
              <input
                className="settings-input"
                type="password"
                value={confirmPassword}
                placeholder="CONFIRM NEW PASSWORD"
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
              />
            </div>

            <button className="settings-submit-btn" type="submit" disabled={loading}>
              {loading ? "Re-encrypting..." : "Update Credentials"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
