import React, { useState, useEffect } from "react";
import { Shield, Lock, Check, Database, Sliders, Clock, Download, Upload, KeyRound, Network } from "lucide-react";
import { dbUpdateUser, isSupabaseConfigured } from "../lib/supabase";
import { isLocalOnlyRuntime, readLocalRuntimeStatus, updateLocalRuntimeSettings, type LocalRuntimeStatus } from "../core/local-runtime/localRuntimeClient";
import { getLocalDocument, putLocalDocument } from "../core/local-runtime/localDocumentStore";
import { dialLocalP2pPeer, forgetTrustedLocalP2pPeer, listConfiguredLocalP2pRelays, listTrustedLocalP2pPeers, readLocalP2pStatus, saveConfiguredLocalP2pRelays, startLocalP2p, stopLocalP2p, type LocalP2pStatus } from "../core/local-runtime/localP2pClient";
import { localP2pOutboxSummary } from "../core/local-runtime/localP2pOutbox";
import { localAlertOutboxSummary } from "../core/local-runtime/localAlertDeliveryOutbox";
import { defaultLocalAiProvider, readLocalAiProviderSettings, saveLocalAiProviderSettings } from "../core/local-runtime/localAiClient";
import {
  createEncryptedProfileArchive,
  downloadEncryptedProfileArchive,
  importEncryptedProfileArchive,
} from "../core/local-runtime/profileMigration";
import "../styles/settings.css";

interface TerminalSettings {
  showDOM: boolean;
  enabledTimeframes: string[];
  theme?: string;
  priceLineColor?: string;
  priceLineIntensity?: number;
  uiDensity?: "dense" | "compact" | "comfortable";
  chartResolutionMode?: "AUTO" | "LOW_DPI" | "HIGH_DPI" | "ULTRA";
  chartPaneCount?: number;
  chartAntialias?: boolean;
  chartBackgroundColor?: string;
  chartGridColor?: string;
  bullishCandleColor?: string;
  bearishCandleColor?: string;
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
  { label: "1s", value: "1s" },
  { label: "10s", value: "10s" },
  { label: "30s", value: "30s" },
  { label: "1m", value: "1m" },
  { label: "3m", value: "3m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1H", value: "1h" },
  { label: "2H", value: "2h" },
  { label: "3H", value: "3h" },
  { label: "4H", value: "4h" },
  { label: "6H", value: "6h" },
  { label: "12H", value: "12h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "1M", value: "1M" },
  { label: "1t", value: "1t" },
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
  const localOnly = isLocalOnlyRuntime();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [migrationPassphrase, setMigrationPassphrase] = useState("");
  const [migrationFile, setMigrationFile] = useState<File | null>(null);
  const [migrationStatus, setMigrationStatus] = useState("");
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [p2pStatus, setP2pStatus] = useState<LocalP2pStatus | null>(null);
  const [p2pAddress, setP2pAddress] = useState("");
  const [p2pRelayAddresses, setP2pRelayAddresses] = useState("");
  const [trustedPeerAddresses, setTrustedPeerAddresses] = useState<string[]>([]);
  const [p2pMessage, setP2pMessage] = useState("");
  const [localRuntimeStatus, setLocalRuntimeStatus] = useState<LocalRuntimeStatus | null>(null);
  const [outboxSummary, setOutboxSummary] = useState<{ pending: number; retrying: number; oldestCreatedAt: number | null; lastSafeError: string | null } | null>(null);
  const [alertOutboxSummary, setAlertOutboxSummary] = useState<{ pending: number; retrying: number; lastSafeError: string | null } | null>(null);
  const [runtimeConfigBusy, setRuntimeConfigBusy] = useState(false);
  const [localAiEndpoint, setLocalAiEndpoint] = useState(defaultLocalAiProvider.endpoint);
  const [localAiModel, setLocalAiModel] = useState(defaultLocalAiProvider.model);
  const [localAiMessage, setLocalAiMessage] = useState("");
  const [localAiBusy, setLocalAiBusy] = useState(false);

  // Local alert configs
  const [webhookUrl, setWebhookUrl] = useState("");
  const [alertEmail, setAlertEmail] = useState("");

  useEffect(() => {
    if (!localOnly) {
      setWebhookUrl(localStorage.getItem("bt_webhook_url") || "");
      setAlertEmail(localStorage.getItem("bt_alert_email") || "");
      return;
    }
    void Promise.all([
      getLocalDocument<{ webhookUrl: string; alertEmail: string }>("settings", "alert-delivery"),
      readLocalAiProviderSettings(),
    ]).then(([document, provider]) => {
        setWebhookUrl(document?.value.webhookUrl || "");
        setAlertEmail(document?.value.alertEmail || "");
        setLocalAiEndpoint(provider.endpoint);
        setLocalAiModel(provider.model);
      })
      .catch((error) => setErrorMsg(error instanceof Error ? error.message : String(error)));
  }, [localOnly]);

  useEffect(() => {
    if (!localOnly) return;
    let active = true;
    void listConfiguredLocalP2pRelays()
      .then((addresses) => { if (active) setP2pRelayAddresses(addresses.join("\n")); })
      .catch((error) => { if (active) setP2pMessage(error instanceof Error ? error.message : String(error)); });
    const refresh = () => Promise.all([readLocalP2pStatus(), readLocalRuntimeStatus(), localP2pOutboxSummary(), localAlertOutboxSummary(), listTrustedLocalP2pPeers()])
      .then(([nextP2p, nextRuntime, nextOutbox, nextAlerts, nextPeers]) => { if (active) { setP2pStatus(nextP2p); setLocalRuntimeStatus(nextRuntime); setOutboxSummary(nextOutbox); setAlertOutboxSummary(nextAlerts); setTrustedPeerAddresses(nextPeers); } })
      .catch((error) => { if (active) setP2pMessage(error instanceof Error ? error.message : String(error)); });
    void readLocalRuntimeStatus().then((nextRuntime) => {
      if (!active || !nextRuntime) return;
      setLocalRuntimeStatus(nextRuntime);
      if (nextRuntime.config?.p2pEnabled) return startLocalP2p().then((nextP2p) => { if (active) setP2pStatus(nextP2p); });
      return readLocalP2pStatus().then((nextP2p) => { if (active) setP2pStatus(nextP2p); });
    }).catch((error) => { if (active) setP2pMessage(error instanceof Error ? error.message : String(error)); });
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [localOnly]);

  const handleSaveLocalSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (localOnly) {
      await putLocalDocument("settings", "alert-delivery", { webhookUrl: webhookUrl.trim(), alertEmail: alertEmail.trim() });
      localStorage.removeItem("bt_webhook_url");
      localStorage.removeItem("bt_alert_email");
    } else {
      localStorage.setItem("bt_webhook_url", webhookUrl.trim());
      localStorage.setItem("bt_alert_email", alertEmail.trim());
    }
    setSuccessMsg(localOnly ? "Encrypted local delivery settings saved." : "System configuration saved!");
    setTimeout(() => setSuccessMsg(""), 3000);
  };

  const handleDialPeer = async () => {
    setP2pMessage("");
    try {
      await dialLocalP2pPeer(p2pAddress.trim());
      setTrustedPeerAddresses(await listTrustedLocalP2pPeers());
      setP2pAddress("");
      setP2pMessage("Peer dial requested. The connection list will update after the encrypted Noise handshake.");
      window.setTimeout(() => void readLocalP2pStatus().then(setP2pStatus), 750);
    } catch (error) {
      setP2pMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleForgetPeer = async (address: string) => {
    try {
      await forgetTrustedLocalP2pPeer(address);
      setTrustedPeerAddresses(await listTrustedLocalP2pPeers());
      setP2pMessage("Trusted peer address removed. Any currently open transport connection is left to close naturally.");
    } catch (error) {
      setP2pMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSaveRelays = async () => {
    if (runtimeConfigBusy) return;
    setRuntimeConfigBusy(true);
    setP2pMessage("");
    try {
      const addresses = await saveConfiguredLocalP2pRelays(p2pRelayAddresses.split(/\r?\n/));
      setP2pRelayAddresses(addresses.join("\n"));
      if (localRuntimeStatus?.config?.p2pEnabled) {
        await stopLocalP2p();
        setP2pStatus(await startLocalP2p());
      }
      setP2pMessage(addresses.length
        ? "Public relay configuration saved. Reservation status will become active only after an authenticated relay accepts this device."
        : "Public relay configuration cleared. Direct, LAN, Kademlia, and UPnP paths remain available.");
    } catch (error) {
      setP2pMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeConfigBusy(false);
    }
  };

  const handleRuntimeSetting = async (key: "backgroundExecution" | "p2pEnabled", checked: boolean) => {
    const config = localRuntimeStatus?.config;
    if (!config || runtimeConfigBusy) return;
    setRuntimeConfigBusy(true);
    setP2pMessage("");
    try {
      const next = await updateLocalRuntimeSettings({
        backgroundExecution: key === "backgroundExecution" ? checked : config.backgroundExecution,
        p2pEnabled: key === "p2pEnabled" ? checked : config.p2pEnabled,
      });
      setLocalRuntimeStatus(next);
      if (key === "p2pEnabled") setP2pStatus(checked ? await startLocalP2p() : await stopLocalP2p());
      setP2pMessage(`${key === "p2pEnabled" ? "P2P networking" : "Background execution"} ${checked ? "enabled" : "disabled"}.`);
    } catch (error) {
      setP2pMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeConfigBusy(false);
    }
  };

  const handleSaveLocalAi = async (event: React.FormEvent) => {
    event.preventDefault();
    if (localAiBusy) return;
    setLocalAiBusy(true);
    setLocalAiMessage("");
    try {
      const saved = await saveLocalAiProviderSettings({ endpoint: localAiEndpoint, model: localAiModel });
      setLocalAiEndpoint(saved.endpoint);
      setLocalAiModel(saved.model);
      setLocalAiMessage("Encrypted local AI provider settings saved. BlackGPT will use this loopback endpoint.");
    } catch (error) {
      setLocalAiMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalAiBusy(false);
    }
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

  const handleExportProfile = async () => {
    setMigrationBusy(true);
    setMigrationStatus("");
    try {
      const archive = await createEncryptedProfileArchive(currentUser.username, migrationPassphrase);
      downloadEncryptedProfileArchive(archive, currentUser.username);
      setMigrationStatus("Encrypted profile exported. Broker credentials and webhook secrets were not included.");
    } catch (cause) {
      setMigrationStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMigrationBusy(false);
    }
  };

  const handleImportProfile = async () => {
    if (!migrationFile) {
      setMigrationStatus("Select a .btprofile archive first.");
      return;
    }
    setMigrationBusy(true);
    setMigrationStatus("");
    try {
      const result = await importEncryptedProfileArchive(
        await migrationFile.text(),
        currentUser.username,
        migrationPassphrase,
      );
      setMigrationStatus(`Imported ${result.importedEntries} encrypted profile records. Restarting the workspace…`);
      window.setTimeout(() => window.location.reload(), 650);
    } catch (cause) {
      setMigrationStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMigrationBusy(false);
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
                  {localOnly ? "ENCRYPTED LOCAL SQLITE" : isSupabaseConfigured ? "CONNECTED (SUPABASE)" : "LOCAL STORAGE FALLBACK"}
                </span>
              </div>
            </div>

            <div className="settings-field" style={{ marginBottom: "18px" }}>
              <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Interface Density</label>
              <span className="settings-hint" style={{ marginBottom: "8px" }}>Compact uses smaller controls and icons while preserving the chart canvas area.</span>
              <select
                value={terminalSettings.uiDensity || "compact"}
                onChange={(event) => onSettingsChange({ ...terminalSettings, uiDensity: event.target.value as TerminalSettings["uiDensity"] })}
                className="settings-input"
              >
                <option value="dense">Dense · maximum workspace</option>
                <option value="compact">Compact · recommended</option>
                <option value="comfortable">Comfortable · larger controls</option>
              </select>
            </div>

            <div className="settings-field" style={{ marginBottom: "18px" }}>
              <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Chart Resolution / DPI</label>
              <span className="settings-hint" style={{ marginBottom: "8px" }}>Controls the real Pixi render-buffer resolution. Ultra is capped at 3× to bound GPU memory.</span>
              <select
                value={terminalSettings.chartResolutionMode || "AUTO"}
                onChange={(event) => onSettingsChange({ ...terminalSettings, chartResolutionMode: event.target.value as TerminalSettings["chartResolutionMode"] })}
                className="settings-input"
              >
                <option value="AUTO">Automatic · native display DPI</option>
                <option value="LOW_DPI">Low DPI · performance</option>
                <option value="HIGH_DPI">High DPI · crisp</option>
                <option value="ULTRA">Ultra · maximum 3×</option>
              </select>
            </div>

            <div className="settings-field" style={{ marginBottom: "18px" }}>
              <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Independent Chart Screens</label>
              <span className="settings-hint" style={{ marginBottom: "8px" }}>Split the chart into as many as seven panes. Every pane persists its own symbol, timeframe, chart type, and indicator configuration.</span>
              <select
                value={Math.max(1, Math.min(7, Math.trunc(Number(terminalSettings.chartPaneCount ?? 1))))}
                onChange={(event) => onSettingsChange({ ...terminalSettings, chartPaneCount: Number(event.target.value) })}
                className="settings-input"
              >
                {Array.from({ length: 7 }, (_, index) => index + 1).map((count) => <option value={count} key={count}>{count} {count === 1 ? "chart" : "independent charts"}</option>)}
              </select>
            </div>

            <div className="settings-field" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "20px" }}>
              <div>
                <label className="settings-label" style={{ fontSize: "11px", display: "block" }}>Chart antialiasing</label>
                <span className="settings-hint">Smooth diagonal geometry and candle edges; disable on constrained GPUs.</span>
              </div>
              <input type="checkbox" checked={terminalSettings.chartAntialias !== false} onChange={(event) => onSettingsChange({ ...terminalSettings, chartAntialias: event.target.checked })} />
            </div>

            <div className="settings-chart-colors">
              {([
                ["chartBackgroundColor", "Chart background", "#000000"],
                ["chartGridColor", "Grid and dividers", "#ff344a"],
                ["bullishCandleColor", "Bullish candles", "#a9a3a8"],
                ["bearishCandleColor", "Bearish candles", "#e3132d"],
              ] as const).map(([key, label, fallback]) => <label key={key}><span>{label}</span><input type="color" value={terminalSettings[key] || fallback} onChange={(event) => onSettingsChange({ ...terminalSettings, [key]: event.target.value })} /></label>)}
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
          {localOnly && <section className="settings-section card">
            <h2 className="settings-sec-title"><Network size={16} /> ENCRYPTED P2P NODE</h2>
            <div className="settings-runtime-toggles">
              <label><span><strong>Background execution</strong><em>Closing the window keeps the local strategy host and native queue in the tray. Quit stops them.</em></span><input type="checkbox" checked={localRuntimeStatus?.config?.backgroundExecution === true} disabled={runtimeConfigBusy || localRuntimeStatus?.persistentBackgroundSupported === false} onChange={(event) => void handleRuntimeSetting("backgroundExecution", event.target.checked)} /></label>
              <label><span><strong>Encrypted P2P networking</strong><em>Starts discovery, trusted-peer dialing, direct messages, social sync, and group-mandate delivery.</em></span><input type="checkbox" checked={localRuntimeStatus?.config?.p2pEnabled === true} disabled={runtimeConfigBusy} onChange={(event) => void handleRuntimeSetting("p2pEnabled", event.target.checked)} /></label>
            </div>
            <div className="telemetry-row"><span className="telemetry-lbl">Background strategy host</span><span className="telemetry-val highlight">{localRuntimeStatus?.backgroundHealth || "STARTING"}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Native execution worker</span><span className="telemetry-val">{localRuntimeStatus?.executionWorkerHeartbeatAt ? "HEALTHY" : "STARTING"}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Peer ID</span><span className="telemetry-val highlight">{p2pStatus?.peerId || "STARTING"}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Connected peers</span><span className="telemetry-val">{p2pStatus?.connectedPeers.length ?? 0}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Public relay reservation</span><span className="telemetry-val highlight">{p2pStatus?.globalRelayConfigured ? "ACTIVE" : p2pStatus?.configuredRelayAddresses.length ? "CONNECTING" : "NOT CONFIGURED"}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Global peer rendezvous</span><span className="telemetry-val highlight">{p2pStatus?.rendezvousRegistered ? `${p2pStatus.rendezvousDiscoveredPeers} PEERS DISCOVERED` : p2pStatus?.configuredRelayAddresses.length ? "REGISTERING" : "NOT CONFIGURED"}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">DCUtR direct upgrades</span><span className="telemetry-val">{p2pStatus?.holePunchSuccesses ?? 0} OK · {p2pStatus?.holePunchFailures ?? 0} FAILED</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Queued direct deliveries</span><span className="telemetry-val">{outboxSummary?.pending ?? 0}</span></div>
            <div className="telemetry-row"><span className="telemetry-lbl">Retrying deliveries</span><span className="telemetry-val">{outboxSummary?.retrying ?? 0}</span></div>
            <div className="settings-field">
              <label className="settings-label">This device's direct addresses</label>
              <textarea className="settings-input" readOnly value={[...(p2pStatus?.activeRelayAddresses || []), ...(p2pStatus?.externalAddresses || []), ...(p2pStatus?.listenAddresses || [])].filter((value, index, values) => values.indexOf(value) === index).join("\n")} placeholder="Waiting for a local listen address…" />
              <span className="settings-hint">Share one reachable multiaddress with a trusted peer. Link transport uses authenticated Noise encryption; private messages use recipient-addressed request streams, never the public feed topic.</span>
            </div>
            <div className="settings-field">
              <label className="settings-label">Operator-controlled public relays</label>
              <textarea className="settings-input" value={p2pRelayAddresses} placeholder="/dns4/relay.example.com/tcp/4001/p2p/12D3KooW…" onChange={(event) => setP2pRelayAddresses(event.target.value)} />
              <span className="settings-hint">One relay base multiaddress per line, maximum four. Each must end with the relay peer ID. Black Terminal requests encrypted Circuit Relay v2 reservations, registers for bounded Rendezvous v1 discovery, and uses DCUtR to attempt a direct connection upgrade.</span>
            </div>
            <button className="settings-submit-btn secondary" type="button" disabled={runtimeConfigBusy} onClick={() => void handleSaveRelays()}>SAVE RELAYS AND RESTART P2P</button>
            <div className="settings-field">
              <label className="settings-label">Dial peer multiaddress</label>
              <input className="settings-input" value={p2pAddress} placeholder="/ip4/192.168.1.20/tcp/4001/p2p/12D3KooW…" onChange={(event) => setP2pAddress(event.target.value)} />
            </div>
            <button className="settings-submit-btn secondary" type="button" disabled={!p2pAddress.trim()} onClick={() => void handleDialPeer()}>Connect and remember peer</button>
            {trustedPeerAddresses.length ? <div className="settings-field"><label className="settings-label">Remembered trusted peers</label><div className="settings-trusted-peer-list">{trustedPeerAddresses.map((address) => <div key={address}><code>{address}</code><button type="button" onClick={() => void handleForgetPeer(address)}>FORGET</button></div>)}</div><span className="settings-hint">Remembered peers are encrypted locally and dialed automatically when Black Terminal starts.</span></div> : null}
            {p2pMessage && <div className="settings-success-msg" role="status">{p2pMessage}</div>}
            {outboxSummary?.lastSafeError && <div className="settings-error-msg" role="status">Last delivery: {outboxSummary.lastSafeError}</div>}
            {p2pStatus?.limitation && <span className="settings-hint">{p2pStatus.limitation}</span>}
          </section>}

          {localOnly && <form className="settings-section card" onSubmit={handleSaveLocalAi}>
            <h2 className="settings-sec-title"><Database size={16} /> LOCAL BLACKGPT PROVIDER</h2>
            <p className="settings-hint">BlackGPT can use an Ollama-compatible model running only on this device. The native bridge accepts only explicit numeric loopback addresses and rejects remote hosts, redirects, embedded credentials, and non-/api/chat paths.</p>
            <div className="settings-field"><label className="settings-label">Loopback endpoint</label><input className="settings-input" value={localAiEndpoint} onChange={(event) => setLocalAiEndpoint(event.target.value)} placeholder="http://127.0.0.1:11434/api/chat" /></div>
            <div className="settings-field"><label className="settings-label">Installed model</label><input className="settings-input" value={localAiModel} onChange={(event) => setLocalAiModel(event.target.value)} placeholder="llama3.2" /></div>
            <button className="settings-submit-btn secondary" type="submit" disabled={localAiBusy}>{localAiBusy ? "SAVING…" : "SAVE LOCAL AI PROVIDER"}</button>
            {localAiMessage && <div className={localAiMessage.includes("saved") ? "settings-success-msg" : "settings-error-msg"} role="status">{localAiMessage}</div>}
          </form>}

          <section className="settings-section card">
            <h2 className="settings-sec-title">
              <KeyRound size={16} /> ENCRYPTED PROFILE MIGRATION
            </h2>
            <p className="settings-hint">Move this owner's workspaces, chart preferences, indicator settings, scripts, watchlist, and alert definitions in an AES-256-GCM encrypted archive.</p>
            <div className="settings-field">
              <label className="settings-label">Archive passphrase</label>
              <input
                className="settings-input"
                type="password"
                value={migrationPassphrase}
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                placeholder="12+ CHARACTERS"
                onChange={(event) => setMigrationPassphrase(event.target.value)}
                disabled={migrationBusy}
              />
              <span className="settings-hint">This passphrase is never stored. Losing it makes the archive unrecoverable.</span>
            </div>
            {localOnly && <div className="settings-field">
              <label className="settings-label">Migration archive</label>
              <input
                className="settings-input"
                type="file"
                accept=".btprofile,application/json,application/vnd.black-terminal.profile+json"
                onChange={(event) => setMigrationFile(event.target.files?.[0] || null)}
                disabled={migrationBusy}
              />
            </div>}
            {migrationStatus && <div className="settings-success-msg" role="status">{migrationStatus}</div>}
            <div className="settings-migration-actions">
              <button className="settings-submit-btn" type="button" disabled={migrationBusy} onClick={() => void handleExportProfile()}>
                <Download size={14} /> Export encrypted profile
              </button>
              {localOnly && <button className="settings-submit-btn secondary" type="button" disabled={migrationBusy || !migrationFile} onClick={() => void handleImportProfile()}>
                <Upload size={14} /> Import into this device
              </button>}
            </div>
            <span className="settings-hint">Not exported: broker/API credentials, login sessions, private keys, passwords, or webhook secrets.</span>
          </section>

          {/* Form 1: Core System Webhooks */}
          <form className="settings-section card" onSubmit={handleSaveLocalSettings}>
            <h2 className="settings-sec-title">
              <Shield size={16} /> ALERTS & WEBHOOKS
            </h2>
            {successMsg && <div className="settings-success-msg">{successMsg}</div>}
            {localOnly && <>
              <div className="telemetry-row"><span className="telemetry-lbl">Queued webhooks</span><span className="telemetry-val">{alertOutboxSummary?.pending ?? 0}</span></div>
              <div className="telemetry-row"><span className="telemetry-lbl">Retrying webhooks</span><span className="telemetry-val">{alertOutboxSummary?.retrying ?? 0}</span></div>
              {alertOutboxSummary?.lastSafeError && <div className="settings-error-msg" role="status">Last webhook: {alertOutboxSummary.lastSafeError}</div>}
            </>}
            
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
          {!localOnly ? <form className="settings-section card" onSubmit={handleChangePassword}>
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
          </form> : <section className="settings-section card">
            <h2 className="settings-sec-title"><Lock size={16} /> LOCAL CREDENTIAL SECURITY</h2>
            <p className="settings-hint">This standalone profile has no Black Cloud access password. Broker secrets and the permanent P2P identity are protected by your operating system's credential vault. Use your Windows, macOS, or Linux account controls to protect access to this device.</p>
          </section>}
        </div>
      </div>
    </div>
  );
}
