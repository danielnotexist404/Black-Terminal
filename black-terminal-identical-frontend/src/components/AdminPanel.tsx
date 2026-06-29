import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import "../styles/admin.css";

interface User {
  username: string;
  role: "admin" | "user";
  status: "online" | "offline" | "suspended";
  createdAt: string;
  lastLogin: string;
  allowedIndicators: string[];
  activeIndicators: string[];
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
    const fetchDB = () => {
      const storedUsers = localStorage.getItem("bt_users_db");
      if (storedUsers) {
        const parsed = JSON.parse(storedUsers);
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
      }
    };

    fetchDB();
    const interval = setInterval(fetchDB, 1500); // Poll every 1.5s for real-time tracking
    return () => clearInterval(interval);
  }, []);

  // Load logs
  useEffect(() => {
    const storedLogs = localStorage.getItem("bt_audit_logs");
    if (storedLogs) {
      setLogs(JSON.parse(storedLogs));
    }
  }, [users]); // Refresh logs list on users update

  const addLog = (tag: AuditLog["tag"], message: string) => {
    const newLog: AuditLog = {
      timestamp: new Date().toLocaleTimeString(),
      tag,
      message
    };
    setLogs((prev) => {
      const updated = [newLog, ...prev];
      localStorage.setItem("bt_audit_logs", JSON.stringify(updated));
      return updated;
    });
  };

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    const cleanUser = newUsername.trim();
    const cleanPass = newPassword.trim();

    if (!cleanUser || !cleanPass) {
      setFormError("Fill username & password");
      return;
    }

    const creds = JSON.parse(localStorage.getItem("bt_users_creds") || "{}");
    if (creds[cleanUser]) {
      setFormError("User already exists");
      return;
    }

    const newUser: User = {
      username: cleanUser,
      role: "user",
      status: "offline",
      createdAt: new Date().toISOString(),
      lastLogin: "Never",
      allowedIndicators: [...DEFAULT_ALLOWED], // volumeProfile (HDLX) is NOT in DEFAULT_ALLOWED
      activeIndicators: []
    };

    const updatedUsers = [...users, newUser];
    setUsers(updatedUsers);
    localStorage.setItem("bt_users_db", JSON.stringify(updatedUsers));

    creds[cleanUser] = cleanPass;
    localStorage.setItem("bt_users_creds", JSON.stringify(creds));

    addLog("CREATE", `New user ${cleanUser} created by Admin.`);
    setNewUsername("");
    setNewPassword("");
  };

  const toggleSuspend = (username: string) => {
    if (username === "black_terminal_admin") return;

    const updated = users.map((u) => {
      if (u.username === username) {
        const nextStatus = u.status === "suspended" ? "offline" : "suspended";
        addLog(
          nextStatus === "suspended" ? "SUSPEND" : "REACTIVATE",
          `User ${username} status changed to ${nextStatus}.`
        );
        return { ...u, status: nextStatus as any };
      }
      return u;
    });

    setUsers(updated);
    localStorage.setItem("bt_users_db", JSON.stringify(updated));
  };

  const handleDeleteUser = (username: string) => {
    if (username === "black_terminal_admin") return;

    const updated = users.filter((u) => u.username !== username);
    setUsers(updated);
    localStorage.setItem("bt_users_db", JSON.stringify(updated));

    const creds = JSON.parse(localStorage.getItem("bt_users_creds") || "{}");
    delete creds[username];
    localStorage.setItem("bt_users_creds", JSON.stringify(creds));

    addLog("DELETE", `User ${username} deleted from database.`);
    if (selectedUser?.username === username) {
      setSelectedUser(null);
    }
  };

  const handleToggleIndicatorPermission = (indicatorKey: string) => {
    if (!selectedUser) return;
    const isAllowed = selectedUser.allowedIndicators.includes(indicatorKey);
    let nextAllowed = [];

    if (isAllowed) {
      nextAllowed = selectedUser.allowedIndicators.filter((k) => k !== indicatorKey);
      addLog("SUSPEND", `Revoked access to [${indicatorKey}] for user ${selectedUser.username}.`);
    } else {
      nextAllowed = [...selectedUser.allowedIndicators, indicatorKey];
      addLog("REACTIVATE", `Granted access to [${indicatorKey}] for user ${selectedUser.username}.`);
    }

    const updatedUsers = users.map((u) => {
      if (u.username === selectedUser.username) {
        const updated = { ...u, allowedIndicators: nextAllowed };
        setSelectedUser(updated);
        return updated;
      }
      return u;
    });

    setUsers(updatedUsers);
    localStorage.setItem("bt_users_db", JSON.stringify(updatedUsers));
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
                        <td className="user-name-col">{u.username}</td>
                        <td>
                          <span className={`user-role-badge ${u.role}`}>
                            {u.role.toUpperCase()}
                          </span>
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
