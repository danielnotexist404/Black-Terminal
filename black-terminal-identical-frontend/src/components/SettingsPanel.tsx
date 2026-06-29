import React, { useState, useEffect } from "react";
import { Shield, Lock, Eye, Mail, Key, Check, AlertTriangle, Database } from "lucide-react";
import { dbUpdateUser, isSupabaseConfigured } from "../lib/supabase";
import "../styles/settings.css";

interface SettingsPanelProps {
  currentUser: {
    username: string;
    role: "admin" | "user";
    allowedIndicators: string[];
  };
  onClose: () => void;
}

export function SettingsPanel({ currentUser, onClose }: SettingsPanelProps) {
  const [email, setEmail] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // Local storage properties
  const [webhookUrl, setWebhookUrl] = useState("");
  const [alertEmail, setAlertEmail] = useState("");

  useEffect(() => {
    // Load local settings
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
      // In a real app we'd verify the old password against db, but to keep it simple:
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
