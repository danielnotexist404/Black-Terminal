import React, { useState, useEffect } from "react";
import "../styles/admin.css";

interface User {
  username: string;
  role: "admin" | "user";
  status: "online" | "offline" | "suspended";
  createdAt: string;
  lastLogin: string;
}

interface AuditLog {
  timestamp: string;
  tag: "LOGIN" | "LOGOUT" | "CREATE" | "SUSPEND" | "REACTIVATE" | "DELETE" | "ERROR";
  message: string;
}

export default function AdminPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [formError, setFormError] = useState("");

  // Load database
  useEffect(() => {
    // Check users DB
    const storedUsers = localStorage.getItem("bt_users_db");
    let currentUsers: User[] = [];
    if (!storedUsers) {
      const defaultUsers = [
        {
          username: "black_terminal_admin",
          role: "admin" as const,
          status: "online" as const,
          createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
          lastLogin: new Date().toISOString()
        },
        {
          username: "demo_user",
          role: "user" as const,
          status: "offline" as const,
          createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
          lastLogin: new Date(Date.now() - 3600000 * 4).toISOString()
        }
      ];
      localStorage.setItem("bt_users_db", JSON.stringify(defaultUsers));
      // Save default passwords in another map
      const defaultCreds = {
        black_terminal_admin: "K9#fX$p2@mQ9&zR4*tW1!vY8",
        demo_user: "DemoUser123!"
      };
      localStorage.setItem("bt_users_creds", JSON.stringify(defaultCreds));
      currentUsers = defaultUsers;
    } else {
      currentUsers = JSON.parse(storedUsers);
    }
    setUsers(currentUsers);

    // Check logs DB
    const storedLogs = localStorage.getItem("bt_audit_logs");
    if (!storedLogs) {
      const defaultLogs = [
        {
          timestamp: new Date(Date.now() - 3600000 * 2).toLocaleTimeString(),
          tag: "CREATE" as const,
          message: "User demo_user created successfully."
        },
        {
          timestamp: new Date(Date.now() - 3600000 * 1).toLocaleTimeString(),
          tag: "LOGIN" as const,
          message: "User demo_user logged in from IP 127.0.0.1"
        },
        {
          timestamp: new Date(Date.now() - 1800000).toLocaleTimeString(),
          tag: "LOGOUT" as const,
          message: "User demo_user logged out."
        },
        {
          timestamp: new Date().toLocaleTimeString(),
          tag: "LOGIN" as const,
          message: "Admin black_terminal_admin established secure link."
        }
      ];
      localStorage.setItem("bt_audit_logs", JSON.stringify(defaultLogs));
      setLogs(defaultLogs);
    } else {
      setLogs(JSON.parse(storedLogs));
    }
  }, []);

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

    // Check if user exists
    const creds = JSON.parse(localStorage.getItem("bt_users_creds") || "{}");
    if (creds[cleanUser]) {
      setFormError("User already exists");
      return;
    }

    // Add user
    const newUser: User = {
      username: cleanUser,
      role: "user",
      status: "offline",
      createdAt: new Date().toISOString(),
      lastLogin: "Never"
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
                        className={u.role === "admin" ? "user-row-admin" : ""}
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
                          {u.username !== "black_terminal_admin" && (
                            <div className="users-table-actions">
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
                            </div>
                          )}
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
                {logs.map((l, index) => (
                  <div className="log-entry" key={index}>
                    <span className="log-time">[{l.timestamp}]</span>
                    <span className={`log-tag ${l.tag.toLowerCase()}`}>{l.tag}</span>
                    <span className="log-msg">{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
