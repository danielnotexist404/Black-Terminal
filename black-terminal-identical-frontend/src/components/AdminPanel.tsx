import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import "../styles/admin.css";
import { dbGetUsers, dbRegisterUser, dbUpdateUser, dbDeleteUser, dbGetAuditLogs, dbAddAuditLog } from "../lib/supabase";

interface User {
  username: string;
  role: "admin" | "user";
  status: "online" | "offline" | "suspended";
  createdAt: string;
  lastLogin: string;
  allowedIndicators: string[];
  activeIndicators: string[];
  email?: string;
  ip?: string;
  countryCode?: string;
  countryName?: string;
}

interface AuditLog {
  timestamp: string;
  tag: "LOGIN" | "LOGOUT" | "CREATE" | "SUSPEND" | "REACTIVATE" | "DELETE" | "ERROR";
  message: string;
}

const ALL_INDICATORS_METADATA = [
  { key: "volumeProfile", name: "HDLX Profile (hdlx)", desc: "Fixed locked/visible volume profile" },
  { key: "orderBookHeatmap", name: "Order Book Heatmap", desc: "Live L2 depth blocks" },
  { key: "liquidationHeatmap", name: "Liquidation Heatmap", desc: "Modeled leverage clusters" },
  { key: "volatilityHeatmap", name: "Volatility Heatmap", desc: "Pine projection buy/sell zones" },
  { key: "adaptiveSwingStrategy", name: "Adaptive Swing Reversal", desc: "Native strategy overlay" },
  { key: "vwap", name: "VWAP", desc: "Volume weighted average price" },
  { key: "ema20", name: "EMA 20", desc: "Fast exponential moving average" },
  { key: "ema50", name: "EMA 50", desc: "Medium exponential moving average" },
  { key: "ema200", name: "EMA 200", desc: "Slow macro exponential average" },
  { key: "sma20", name: "SMA 20", desc: "Fast simple moving average" },
  { key: "sma50", name: "SMA 50", desc: "Medium simple moving average" },
  { key: "bollinger", name: "Bollinger Bands", desc: "Volatility deviation channels" },
  { key: "openInterestOscillator", name: "Open Interest Oscillator", desc: "OI derivative pressure" },
  { key: "zScoreOscillator", name: "Z-Score Oscillator", desc: "Standard deviation distance" },
  { key: "waveTrendOscillator", name: "WaveTrend Oscillator", desc: "Momentum oscillator" },
  { key: "volume", name: "Volume Panel", desc: "Exchange traded volume bar charts" }
];

const DEFAULT_ALLOWED = [
  "orderBookHeatmap",
  "liquidationHeatmap",
  "volatilityHeatmap",
  "adaptiveSwingStrategy",
  "vwap",
  "ema20",
  "ema50",
  "ema200",
  "sma20",
  "sma50",
  "bollinger",
  "openInterestOscillator",
  "zScoreOscillator",
  "waveTrendOscillator",
  "volume"
];

const ADMIN_ALLOWED = [...DEFAULT_ALLOWED, "volumeProfile"];

export default function AdminPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [formError, setFormError] = useState("");

  // Poll database to get real-time active indicators and state changes
  useEffect(() => {
    const fetchDB = async () => {
      try {
        const parsed = await dbGetUsers();
        // Normalize fields in case older records exist
        const normalized = parsed.map((u: any) => ({
          ...u,
          allowedIndicators: u.allowedIndicators || (u.role === "admin" ? ADMIN_ALLOWED : DEFAULT_ALLOWED),
          activeIndicators: u.activeIndicators || []
        }));
        setUsers(normalized);

        // Update selected user's reference
        setSelectedUser((current) => {
          if (!current) return null;
          const matched = normalized.find((u: any) => u.username === current.username);
          return matched || null;
        });
      } catch (err) {
        console.error("AdminPanel fetchDB error:", err);
      }
    };

    fetchDB();
    const interval = setInterval(fetchDB, 1500); // Poll every 1.5s for real-time tracking
    return () => clearInterval(interval);
  }, []);

  // Load logs
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const storedLogs = await dbGetAuditLogs();
        setLogs(storedLogs as any);
      } catch (e) {
        console.error("AdminPanel fetchLogs error:", e);
      }
    };
    fetchLogs();
  }, [users]); // Refresh logs list on users update

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    const cleanUser = newUsername.trim();
    const cleanPass = newPassword.trim();

    if (!cleanUser || !cleanPass) {
      setFormError("Fill username & password");
      return;
    }

    const newUser = {
      username: cleanUser,
      email: `${cleanUser}@blackterminal.com`,
      role: "user" as const,
      status: "offline" as const,
      createdAt: new Date().toISOString(),
      lastLogin: "Never",
      allowedIndicators: [...DEFAULT_ALLOWED],
      activeIndicators: []
    };

    const regResult = await dbRegisterUser(newUser, cleanPass);
    if (!regResult.success) {
      setFormError(regResult.error || "User already exists");
      return;
    }

    await dbAddAuditLog("CREATE", `New user ${cleanUser} created by Admin.`);
    
    // Refresh lists manually
    const updatedUsers = await dbGetUsers();
    setUsers(updatedUsers);

    setNewUsername("");
    setNewPassword("");
  };

  const toggleSuspend = async (username: string) => {
    if (username === "black_terminal_admin") return;

    const matchedUser = users.find(u => u.username === username);
    if (!matchedUser) return;

    const nextStatus = matchedUser.status === "suspended" ? "offline" : "suspended";
    await dbUpdateUser(username, { status: nextStatus as any });

    const tag = nextStatus === "suspended" ? "SUSPEND" : "REACTIVATE";
    await dbAddAuditLog(tag as any, `User ${username} status changed to ${nextStatus}.`);

    const updatedUsers = await dbGetUsers();
    setUsers(updatedUsers);
  };

  const handleDeleteUser = async (username: string) => {
    if (username === "black_terminal_admin") return;

    await dbDeleteUser(username);
    await dbAddAuditLog("DELETE", `User ${username} deleted from database.`);

    const updatedUsers = await dbGetUsers();
    setUsers(updatedUsers);

    if (selectedUser?.username === username) {
      setSelectedUser(null);
    }
  };

  const handleToggleIndicatorPermission = async (indicatorKey: string) => {
    if (!selectedUser) return;
    const isAllowed = selectedUser.allowedIndicators.includes(indicatorKey);
    let nextAllowed = [];

    const tag = isAllowed ? "SUSPEND" : "REACTIVATE";
    const msg = isAllowed 
      ? `Revoked access to [${indicatorKey}] for user ${selectedUser.username}.`
      : `Granted access to [${indicatorKey}] for user ${selectedUser.username}.`;

    if (isAllowed) {
      nextAllowed = selectedUser.allowedIndicators.filter((k) => k !== indicatorKey);
    } else {
      nextAllowed = [...selectedUser.allowedIndicators, indicatorKey];
    }

    await dbUpdateUser(selectedUser.username, { allowedIndicators: nextAllowed });
    await dbAddAuditLog(tag as any, msg);

    const updatedUsers = await dbGetUsers();
    setUsers(updatedUsers);

    const updatedSelected = updatedUsers.find(u => u.username === selectedUser.username);
    if (updatedSelected) {
      setSelectedUser(updatedSelected);
    }
  };

  const totalUsers = users.length;
  const activeSessions = users.filter((u) => u.status === "online").length;
  const suspendedUsers = users.filter((u) => u.status === "suspended").length;

  return (
    <div className="admin-panel-container">
      <div className="admin-header">
        <div className="admin-title-group">
          <span className="admin-title-badge">ADMIN CONTROL</span>
          <h1 className="admin-title">USER DIRECTORY & ACCESS</h1>
        </div>
      </div>

      <div className="admin-content">
        {/* Stats Dashboard */}
        <div className="admin-stats-grid">
          <div className="admin-stat-card">
            <span className="admin-stat-label">TOTAL MEMBERS</span>
            <span className="admin-stat-value">{totalUsers}</span>
            <span className="admin-stat-sub">Registered credentials</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">ACTIVE TERMINALS</span>
            <span className="admin-stat-value active-sessions">{activeSessions}</span>
            <span className="admin-stat-sub">Live WS sessions</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">SUSPENDED KEYS</span>
            <span className="admin-stat-value">{suspendedUsers}</span>
            <span className="admin-stat-sub">Revoked access codes</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">SYSTEM UPTIME</span>
            <span className="admin-stat-value" style={{ color: "var(--amber)" }}>99.98%</span>
            <span className="admin-stat-sub">Node host cluster active</span>
          </div>
        </div>

        {/* Split Layout */}
        <div className="admin-split-layout">
          {/* Left panel: User list & Form */}
          <div className="admin-card">
            <div className="admin-card-header">
              <span className="admin-card-title">CREDENTIAL REGISTRY</span>
            </div>
            <div className="admin-card-body">
              {/* User Creation Form */}
              <form className="user-form" onSubmit={handleCreateUser}>
                <div className="user-form-field">
                  <span className="user-form-label">Create Identity</span>
                  <input
                    className="user-form-input"
                    type="text"
                    placeholder="USERNAME"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                  />
                </div>
                <div className="user-form-field">
                  <span className="user-form-label">Access Code</span>
                  <input
                    className="user-form-input"
                    type="password"
                    placeholder="PASSWORD"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <button className="btn-admin-add" type="submit">
                  REGISTER USER
                </button>
              </form>

              {formError && (
                <div
                  className="login-error-msg"
                  style={{ marginBottom: "16px", padding: "6px" }}
                >
                  {formError}
                </div>
              )}

              {/* Users table */}
              <div className="users-table-wrapper">
                <table className="users-table">
                  <thead>
                    <tr>
                      <th>Identity</th>
                      <th>Level</th>
                      <th>Location</th>
                      <th>Status</th>
                      <th>Registered</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr
                        key={u.username}
                        className={`${u.role === "admin" ? "user-row-admin" : ""} ${
                          selectedUser?.username === u.username ? "selected" : ""
                        }`}
                      >
                        <td className="user-name-col">
                          <div style={{ fontWeight: "600" }}>{u.username}</div>
                          {u.email && <div style={{ fontSize: "10px", color: "var(--dim)", marginTop: "2px" }}>{u.email}</div>}
                        </td>
                        <td>
                          <span className={`user-role-badge ${u.role}`}>
                            {u.role.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            {u.countryCode ? (
                              <img
                                src={`https://flagcdn.com/w20/${u.countryCode.toLowerCase()}.png`}
                                alt={u.countryName || u.countryCode}
                                title={u.countryName || u.countryCode}
                                style={{ width: "20px", height: "auto", borderRadius: "2px", border: "1px solid rgba(255,255,255,0.15)" }}
                              />
                            ) : (
                              <span style={{ fontSize: "12px" }}>🏳️</span>
                            )}
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              <span style={{ fontSize: "11px", fontWeight: "500" }}>{u.countryName || "Unknown"}</span>
                              {u.ip && <span style={{ fontSize: "9px", color: "var(--dim)" }}>{u.ip}</span>}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="user-status-col">
                            <span className={`user-status-dot ${u.status}`} />
                            <span style={{ fontSize: "11px" }}>
                              {u.status.toUpperCase()}
                            </span>
                          </div>
                        </td>
                        <td style={{ color: "var(--dim)", fontSize: "11px" }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td>
                          <div className="users-table-actions">
                            <button
                              className="btn-action-permissions"
                              onClick={() => setSelectedUser(u)}
                            >
                              PERMISSIONS
                            </button>
                            {u.username !== "black_terminal_admin" && (
                              <>
                                <button
                                  className={
                                    u.status === "suspended"
                                      ? "btn-action-reactivate"
                                      : "btn-action-suspend"
                                  }
                                  onClick={() => toggleSuspend(u.username)}
                                >
                                  {u.status === "suspended" ? "REACTIVATE" : "SUSPEND"}
                                </button>
                                <button
                                  className="btn-action-delete"
                                  onClick={() => handleDeleteUser(u.username)}
                                >
                                  DELETE
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right panel: Audit logs */}
          <div className="admin-card">
            <div className="admin-card-header">
              <span className="admin-card-title">AUDIT TRAIL LOGS</span>
            </div>
            <div className="admin-card-body" style={{ padding: "12px" }}>
              <div className="logs-console">
                {logs.slice(0, 100).map((l, index) => (
                  <div className="log-entry" key={index}>
                    <span className="log-time">[{l.timestamp}]</span>
                    <span className={`log-tag ${l.tag.toLowerCase()}`}>{l.tag}</span>
                    <span className="log-msg">{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Expanded panel: User detailed permissions and active tracking */}
          {selectedUser && (
            <div className="admin-user-details-card">
              <div className="user-details-header">
                <span className="user-details-title">
                  ACCESS CONTROLS & MONITORING // USER: <span>{selectedUser.username.toUpperCase()}</span>
                </span>
                <button
                  className="btn-close-details"
                  onClick={() => setSelectedUser(null)}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="user-details-body">
                {/* Active monitoring column */}
                <div className="details-column">
                  <span className="details-subtitle">Live Active Indicators</span>
                  <div className="active-indicators-list">
                    {selectedUser.activeIndicators.length > 0 ? (
                      selectedUser.activeIndicators.map((key) => {
                        const metadata = ALL_INDICATORS_METADATA.find((m) => m.key === key);
                        return (
                          <span className="active-indicator-badge" key={key}>
                            {metadata ? metadata.name : key}
                          </span>
                        );
                      })
                    ) : (
                      <span className="active-indicators-empty">
                        No active indicators running on chart.
                      </span>
                    )}
                  </div>
                  <div style={{ color: "var(--dim)", fontSize: "10px", lineHeight: "1.4" }}>
                    * Updates in real-time as the client toggles overlays on their viewport canvas.
                  </div>
                </div>

                {/* Permissions configuration column */}
                <div className="details-column">
                  <span className="details-subtitle">Toggle Permissions Configuration</span>
                  <div className="permissions-grid">
                    {ALL_INDICATORS_METADATA.map((ind) => {
                      const isAllowed = selectedUser.allowedIndicators.includes(ind.key);
                      return (
                        <div
                          key={ind.key}
                          className={`permission-toggle-card ${isAllowed ? "allowed" : "blocked"}`}
                          onClick={() => handleToggleIndicatorPermission(ind.key)}
                          title={ind.desc}
                        >
                          <div className="permission-name-group">
                            <span className="permission-name">{ind.name}</span>
                            <span className="permission-key">{ind.key}</span>
                          </div>
                          <span
                            className={`permission-status-dot ${
                              isAllowed ? "allowed" : "blocked"
                            }`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
