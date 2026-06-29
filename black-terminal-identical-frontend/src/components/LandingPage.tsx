import React, { useState } from "react";
import { Check, Activity, Bell, Code2, Shield, Lock, X } from "lucide-react";
import "../styles/landing.css";

interface LandingPageProps {
  onLoginSuccess: (username: string, role: "admin" | "user") => void;
}

export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [showSignInModal, setShowSignInModal] = useState(false);
  const [showSignUpModal, setShowSignUpModal] = useState(false);

  // Forms
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    if (!username.trim() || !password.trim()) {
      setErrorMsg("Please fill all fields");
      return;
    }

    setLoading(true);

    setTimeout(() => {
      // Load user DB
      const storedUsers = localStorage.getItem("bt_users_db");
      const storedCreds = localStorage.getItem("bt_users_creds");

      const users = storedUsers ? JSON.parse(storedUsers) : [];
      const creds = storedCreds ? JSON.parse(storedCreds) : {};

      const cleanUser = username.trim();
      const cleanPass = password.trim();

      // Check credential
      if (creds[cleanUser] && creds[cleanUser] === cleanPass) {
        // Find user status
        const userObj = users.find((u: any) => u.username === cleanUser);
        if (userObj) {
          if (userObj.status === "suspended") {
            setErrorMsg("Your secure access code is suspended");
            setLoading(false);
            return;
          }

          // Update online status
          userObj.status = "online";
          userObj.lastLogin = new Date().toISOString();
          localStorage.setItem("bt_users_db", JSON.stringify(users));

          // Log session in audit
          const storedLogs = JSON.parse(localStorage.getItem("bt_audit_logs") || "[]");
          const logMsg = {
            timestamp: new Date().toLocaleTimeString(),
            tag: "LOGIN" as const,
            message: `User ${cleanUser} logged in from landing page.`
          };
          localStorage.setItem("bt_audit_logs", JSON.stringify([logMsg, ...storedLogs]));

          onLoginSuccess(cleanUser, userObj.role);
        } else {
          // If password matches but user record is missing, reconstruct it
          const newUser = {
            username: cleanUser,
            role: (cleanUser === "black_terminal_admin" ? "admin" : "user") as any,
            status: "online" as const,
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString()
          };
          users.push(newUser);
          localStorage.setItem("bt_users_db", JSON.stringify(users));
          onLoginSuccess(cleanUser, newUser.role);
        }
      } else {
        setErrorMsg("Access denied: Invalid credentials");
        setLoading(false);
      }
    }, 600);
  };

  const handleSignUp = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    const cleanUser = username.trim();
    const cleanPass = password.trim();

    if (!cleanUser || !cleanPass) {
      setErrorMsg("Please fill all fields");
      return;
    }

    if (cleanUser.length < 3) {
      setErrorMsg("Username must be at least 3 characters");
      return;
    }

    setLoading(true);

    setTimeout(() => {
      const storedUsers = localStorage.getItem("bt_users_db");
      const storedCreds = localStorage.getItem("bt_users_creds");

      const users = storedUsers ? JSON.parse(storedUsers) : [];
      const creds = storedCreds ? JSON.parse(storedCreds) : {};

      if (creds[cleanUser]) {
        setErrorMsg("Username already exists");
        setLoading(false);
        return;
      }

      // Add user record
      const newUser = {
        username: cleanUser,
        role: "user" as const,
        status: "online" as const,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      users.push(newUser);
      localStorage.setItem("bt_users_db", JSON.stringify(users));

      creds[cleanUser] = cleanPass;
      localStorage.setItem("bt_users_creds", JSON.stringify(creds));

      // Audit logs
      const storedLogs = JSON.parse(localStorage.getItem("bt_audit_logs") || "[]");
      const logMsg = {
        timestamp: new Date().toLocaleTimeString(),
        tag: "CREATE" as const,
        message: `New account registered: ${cleanUser}`
      };
      const logMsg2 = {
        timestamp: new Date().toLocaleTimeString(),
        tag: "LOGIN" as const,
        message: `User ${cleanUser} logged in automatically.`
      };
      localStorage.setItem("bt_audit_logs", JSON.stringify([logMsg2, logMsg, ...storedLogs]));

      setSuccessMsg("Account created! Connecting...");
      setTimeout(() => {
        onLoginSuccess(cleanUser, "user");
      }, 500);
    }, 600);
  };

  const handleOpenSignIn = () => {
    setErrorMsg("");
    setUsername("");
    setPassword("");
    setShowSignUpModal(false);
    setShowSignInModal(true);
  };

  const handleOpenSignUp = () => {
    setErrorMsg("");
    setUsername("");
    setPassword("");
    setShowSignInModal(false);
    setShowSignUpModal(true);
  };

  return (
    <div className="landing-container">
      <div className="login-bg-decor" />

      {/* Header */}
      <header className="landing-header">
        <div className="landing-logo-group">
          <div className="landing-logo-icon" />
          <span className="landing-logo-title">BLACK-TERMINAL</span>
        </div>
        <nav className="landing-nav">
          <a href="#features" className="landing-nav-link">
            Features
          </a>
          <a href="#pricing" className="landing-nav-link">
            Pricing
          </a>
          <div className="landing-auth-btns">
            <button className="btn-signin" onClick={handleOpenSignIn}>
              Sign In
            </button>
            <button className="btn-signup" onClick={handleOpenSignUp}>
              Sign Up
            </button>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="hero-section">
        <span className="hero-badge">Pre-Alpha Release v1.0.7</span>
        <h1 className="hero-title">
          The Ultimate Quantum <br />
          <span>Crypto Trading Terminal</span>
        </h1>
        <p className="hero-desc">
          Professional charting, low latency order-book heatmaps, custom strategy backtesting
          engines, and fully customizable Python-ready indicators. Designed by quants, for quants.
        </p>
        <div className="hero-ctas">
          <button className="btn-primary" onClick={handleOpenSignUp}>
            Start Trading Now
          </button>
          <button className="btn-secondary" onClick={handleOpenSignIn}>
            View Live Terminal
          </button>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="features-section">
        <div className="section-header">
          <h2 className="section-title">Engineered For Execution Speed</h2>
          <p className="section-desc">State of the art technology stack running fully in client space.</p>
        </div>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">
              <Activity size={24} />
            </div>
            <h3 className="feature-name">PixiJS Canvas Renderer</h3>
            <p className="feature-text">
              High frame rate WebGL canvas engine supporting hundreds of thousands of candlesticks
              and complex heatmaps smoothly.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">
              <Code2 size={24} />
            </div>
            <h3 className="feature-name">Python Indicator Runtime</h3>
            <p className="feature-text">
              Write strategy scripts in standard Python. Parse orderbooks, liquidations, and open
              interest in real-time.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">
              <Shield size={24} />
            </div>
            <h3 className="feature-name">Secure Handshake API</h3>
            <p className="feature-text">
              Client-to-exchange direct WebSockets ensuring your trading keys never transit through
              third-party server logs.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="pricing-section">
        <div className="section-header">
          <h2 className="section-title">Select Your Operations Plan</h2>
          <p className="section-desc">Get access to professional API feeds and backtest labs.</p>
        </div>

        <div className="pricing-grid">
          <div className="pricing-card">
            <div className="plan-header">
              <span className="plan-name">Starter Pack</span>
              <div className="plan-price">
                <span className="price-amount">$0</span>
                <span className="price-period">/ forever</span>
              </div>
              <p className="plan-desc">Essential tools to observe markets and try out scripting.</p>
            </div>
            <ul className="plan-features">
              <li>
                <Check size={16} /> Basic Candlestick Charting
              </li>
              <li>
                <Check size={16} /> Binance Public WebSocket Feed
              </li>
              <li>
                <Check size={16} /> 2 Custom Python Indicators
              </li>
            </ul>
            <button className="btn-plan" onClick={handleOpenSignUp}>
              Register Free
            </button>
          </div>

          <div className="pricing-card popular">
            <span className="popular-badge">Most Popular</span>
            <div className="plan-header">
              <span className="plan-name">Pro Terminal</span>
              <div className="plan-price">
                <span className="price-amount">$49</span>
                <span className="price-period">/ month</span>
              </div>
              <p className="plan-desc">Advanced depth analytics and full indicator libraries.</p>
            </div>
            <ul className="plan-features">
              <li>
                <Check size={16} /> Order-Book & Liquidation Heatmaps
              </li>
              <li>
                <Check size={16} /> Multi-Exchange Feed (Bybit, OKX)
              </li>
              <li>
                <Check size={16} /> Unlimited Indicators & Backtesting
              </li>
              <li>
                <Check size={16} /> Priority Alert System Webhooks
              </li>
            </ul>
            <button className="btn-plan" onClick={handleOpenSignUp}>
              Activate Pro
            </button>
          </div>

          <div className="pricing-card">
            <div className="plan-header">
              <span className="plan-name">Institutional</span>
              <div className="plan-price">
                <span className="price-amount">$199</span>
                <span className="price-period">/ month</span>
              </div>
              <p className="plan-desc">Full Strategy Optimization Labs and direct low-latency pipelines.</p>
            </div>
            <ul className="plan-features">
              <li>
                <Check size={16} /> AI-Assisted Strategy Optimizer
              </li>
              <li>
                <Check size={16} /> Walk-Forward Optimization Engine
              </li>
              <li>
                <Check size={16} /> Sub-millisecond direct socket adapters
              </li>
              <li>
                <Check size={16} /> Dedicated Server Host Cluster
              </li>
            </ul>
            <button className="btn-plan" onClick={handleOpenSignUp}>
              Contact Sales
            </button>
          </div>
        </div>
      </section>

      {/* Sign In Modal */}
      {showSignInModal && (
        <div className="modal-overlay" onClick={() => setShowSignInModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="login-card">
              <button className="modal-close-btn" onClick={() => setShowSignInModal(false)}>
                <X size={18} />
              </button>

              <div className="login-header">
                <div className="login-logo" />
                <div className="login-title-group">
                  <h2 className="login-title">SECURE LOGIN</h2>
                  <p className="login-subtitle">Establish Terminal Connection</p>
                </div>
              </div>

              <form className="login-form" onSubmit={handleSignIn}>
                {errorMsg && <div className="login-error-msg">{errorMsg}</div>}

                <div className="login-field">
                  <label className="login-label">Secure Identity</label>
                  <input
                    className="login-input"
                    type="text"
                    value={username}
                    placeholder="USERNAME"
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>

                <div className="login-field">
                  <label className="login-label">Access Code</label>
                  <input
                    className="login-input"
                    type="password"
                    value={password}
                    placeholder="PASSWORD"
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>

                <button className="login-submit-btn" type="submit" disabled={loading}>
                  {loading ? "Establishing Link..." : "Decrypt Terminal Key"}
                </button>
              </form>

              <div style={{ textAlign: "center", fontSize: "11px", color: "var(--dim)" }}>
                Need a terminal key?{" "}
                <span
                  style={{ color: "var(--red-hot)", cursor: "pointer", fontWeight: "600" }}
                  onClick={handleOpenSignUp}
                >
                  Create one now
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sign Up Modal */}
      {showSignUpModal && (
        <div className="modal-overlay" onClick={() => setShowSignUpModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="login-card">
              <button className="modal-close-btn" onClick={() => setShowSignUpModal(false)}>
                <X size={18} />
              </button>

              <div className="login-header">
                <div className="login-logo" />
                <div className="login-title-group">
                  <h2 className="login-title">REGISTER SECURE IDENT</h2>
                  <p className="login-subtitle">Initialize Client-Side Shell</p>
                </div>
              </div>

              <form className="login-form" onSubmit={handleSignUp}>
                {errorMsg && <div className="login-error-msg">{errorMsg}</div>}
                {successMsg && <div className="signup-success-msg">{successMsg}</div>}

                <div className="login-field">
                  <label className="login-label">Choose Identity</label>
                  <input
                    className="login-input"
                    type="text"
                    value={username}
                    placeholder="USERNAME"
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>

                <div className="login-field">
                  <label className="login-label">Generate Access Code</label>
                  <input
                    className="login-input"
                    type="password"
                    value={password}
                    placeholder="COMPLEX_PASSWORD"
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>

                <button className="login-submit-btn" type="submit" disabled={loading}>
                  {loading ? "Registering Node..." : "Initialize Security Keys"}
                </button>
              </form>

              <div style={{ textAlign: "center", fontSize: "11px", color: "var(--dim)" }}>
                Already registered?{" "}
                <span
                  style={{ color: "var(--red-hot)", cursor: "pointer", fontWeight: "600" }}
                  onClick={handleOpenSignIn}
                >
                  Login here
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
