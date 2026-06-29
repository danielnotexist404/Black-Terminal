import React, { useState } from "react";
import "../styles/login.css";

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Invented credentials
  const VALID_USER = "black_terminal_admin";
  const VALID_PASS = "K9#fX$p2@mQ9&zR4*tW1!vY8";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!username || !password) {
      setError("Please fill all fields");
      return;
    }

    setLoading(true);

    // Simulate authenticating
    setTimeout(() => {
      if (username === VALID_USER && password === VALID_PASS) {
        onLogin();
      } else {
        setError("Invalid secure credentials");
        setLoading(false);
      }
    }, 600);
  };

  return (
    <div className="login-container">
      <div className="login-bg-decor" />
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo" />
          <div className="login-title-group">
            <h1 className="login-title">BLACK-TERMINAL</h1>
            <p className="login-subtitle">By Black Triangle Group</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {error && <div className="login-error-msg">{error}</div>}

          <div className="login-field">
            <label className="login-label" htmlFor="username">
              Secure Identity
            </label>
            <div className="login-input-wrapper">
              <input
                id="username"
                className="login-input"
                type="text"
                value={username}
                placeholder="SECURE_USER_ID"
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                autoComplete="off"
                autoCapitalize="off"
              />
            </div>
          </div>

          <div className="login-field">
            <label className="login-label" htmlFor="password">
              Access Code
            </label>
            <div className="login-input-wrapper">
              <input
                id="password"
                className="login-input"
                type="password"
                value={password}
                placeholder="••••••••••••••••"
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                autoComplete="off"
              />
            </div>
          </div>

          <button className="login-submit-btn" type="submit" disabled={loading}>
            {loading ? "Decrypting..." : "Establish Link"}
          </button>
        </form>

        <div className="login-footer-info">
          <div className="system-status">
            <span>SECURE BOOT</span>
            <div className="status-indicator">
              <span className="status-dot" />
              <span>ACTIVE LINK</span>
            </div>
          </div>

          <div className="mock-terminal-lines">
            <div>
              <span className="terminal-line-code">SYS://</span> v1.0.7-alpha loaded successfully.
            </div>
            <div>
              <span className="terminal-line-code">NET://</span> WS feed ping <span className="terminal-line-val">14ms</span>
            </div>
            <div>
              <span className="terminal-line-code">ENC://</span> AES-GCM-256 session handshake ready.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
