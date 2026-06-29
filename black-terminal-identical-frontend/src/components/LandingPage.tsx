import React, { useState } from "react";
import { Check, Activity, Bell, Code2, Shield, Lock, X, ArrowLeft, Chrome, Layers, Cpu, TrendingUp, Users } from "lucide-react";
import "../styles/landing.css";

// Import generated images
import terminalMockup from "../assets/terminal_mockup.jpg";
import chartPreview from "../assets/chart_preview.jpg";

interface LandingPageProps {
  onLoginSuccess: (username: string, role: "admin" | "user") => void;
}

type ViewState = "landing" | "signin" | "signup";

export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [view, setView] = useState<ViewState>("landing");

  // Form states
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
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
      const storedUsers = localStorage.getItem("bt_users_db");
      const storedCreds = localStorage.getItem("bt_users_creds");

      const users = storedUsers ? JSON.parse(storedUsers) : [];
      const creds = storedCreds ? JSON.parse(storedCreds) : {};

      const cleanUser = username.trim();
      const cleanPass = password.trim();

      if (creds[cleanUser] && creds[cleanUser] === cleanPass) {
        const userObj = users.find((u: any) => u.username === cleanUser);
        if (userObj) {
          if (userObj.status === "suspended") {
            setErrorMsg("Access suspended by Administrator");
            setLoading(false);
            return;
          }

          userObj.status = "online";
          userObj.lastLogin = new Date().toISOString();
          localStorage.setItem("bt_users_db", JSON.stringify(users));

          const storedLogs = JSON.parse(localStorage.getItem("bt_audit_logs") || "[]");
          const logMsg = {
            timestamp: new Date().toLocaleTimeString(),
            tag: "LOGIN" as const,
            message: `User ${cleanUser} logged in from landing page.`
          };
          localStorage.setItem("bt_audit_logs", JSON.stringify([logMsg, ...storedLogs]));

          onLoginSuccess(cleanUser, userObj.role);
        } else {
          const isUserAdmin = cleanUser === "black_terminal_admin";
          const defaultAllowed = [
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
          const adminAllowed = [...defaultAllowed, "volumeProfile"];
          const newUser = {
            username: cleanUser,
            email: isUserAdmin ? "admin@blackterminal.com" : "imported@blackterminal.com",
            role: (isUserAdmin ? "admin" : "user") as any,
            status: "online" as const,
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString(),
            allowedIndicators: isUserAdmin ? adminAllowed : defaultAllowed,
            activeIndicators: []
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
    const cleanEmail = email.trim();
    const cleanPass = password.trim();

    if (!cleanUser || !cleanEmail || !cleanPass) {
      setErrorMsg("Please fill all fields");
      return;
    }

    if (!cleanEmail.includes("@")) {
      setErrorMsg("Please enter a valid email address");
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

      const defaultAllowed = [
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
      const newUser = {
        username: cleanUser,
        email: cleanEmail,
        role: (cleanUser === "black_terminal_admin" ? "admin" : "user") as any,
        status: "online" as const,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        allowedIndicators: defaultAllowed,
        activeIndicators: []
      };
      users.push(newUser);
      localStorage.setItem("bt_users_db", JSON.stringify(users));

      creds[cleanUser] = cleanPass;
      localStorage.setItem("bt_users_creds", JSON.stringify(creds));

      const storedLogs = JSON.parse(localStorage.getItem("bt_audit_logs") || "[]");
      const logMsg = {
        timestamp: new Date().toLocaleTimeString(),
        tag: "CREATE" as const,
        message: `New account registered: ${cleanUser} (${cleanEmail})`
      };
      const logMsg2 = {
        timestamp: new Date().toLocaleTimeString(),
        tag: "LOGIN" as const,
        message: `User ${cleanUser} logged in automatically.`
      };
      localStorage.setItem("bt_audit_logs", JSON.stringify([logMsg2, logMsg, ...storedLogs]));

      setSuccessMsg("Account created! Connecting...");
      setTimeout(() => {
        onLoginSuccess(cleanUser, newUser.role);
      }, 500);
    }, 600);
  };

  const handleOpenSignIn = () => {
    setErrorMsg("");
    setUsername("");
    setEmail("");
    setPassword("");
    setView("signin");
  };

  const handleOpenSignUp = () => {
    setErrorMsg("");
    setUsername("");
    setEmail("");
    setPassword("");
    setView("signup");
  };

  if (view === "signin" || view === "signup") {
    const isSignIn = view === "signin";
    return (
      <div className="login-container">
        <div className="login-bg-decor" />
        <div className="login-card">
          {/* Left Visual Column */}
          <div className="login-visual">
            <div className="CRT-glitch-line" />
            <div className="visual-top">
              <span className="visual-badge">DECRYPTED LINK</span>
              <h2 className="visual-title">BLACK TERMINAL <span>v1.0.7</span></h2>
              <p className="visual-desc">
                High-density cryptographic telemetry workspace. Low latency data node feeds straight on your viewport canvas.
              </p>
            </div>
            
            <div className="visual-bottom">
              <div className="login-live-stats">
                <div className="login-stat-item">
                  <span className="login-stat-lbl">NODE LATENCY</span>
                  <span className="login-stat-val up">1.42ms</span>
                </div>
                <div className="login-stat-item">
                  <span className="login-stat-lbl">PIXI RUNTIME</span>
                  <span className="login-stat-val">120 FPS</span>
                </div>
                <div className="login-stat-item">
                  <span className="login-stat-lbl">VOLUME (24H)</span>
                  <span className="login-stat-val">$18.73B</span>
                </div>
                <div className="login-stat-item">
                  <span className="login-stat-lbl">SSL CERT</span>
                  <span className="login-stat-val up">ACTIVE</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Form Column */}
          <div className="login-form-area">
            <button className="modal-close-btn" style={{ position: "absolute", top: "20px", right: "20px" }} onClick={() => setView("landing")}>
              <ArrowLeft size={18} />
            </button>

            <div className="login-header">
              <div className="login-logo" />
              <div className="login-title-group">
                <h2 className="login-title">{isSignIn ? "SECURE ACCESS" : "INITIALIZE SHELL"}</h2>
                <p className="login-subtitle">{isSignIn ? "BLACK TERMINAL ENCRYPTED LINK" : "GENERATE CLIENT CREDENTIALS"}</p>
              </div>
            </div>

            <form className="login-form" onSubmit={isSignIn ? handleSignIn : handleSignUp}>
              {errorMsg && <div className="login-error-msg">{errorMsg}</div>}
              {successMsg && <div className="signup-success-msg">{successMsg}</div>}

              <div className="login-field">
                <label className="login-label">Identity (Username)</label>
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

              {!isSignIn && (
                <div className="login-field">
                  <label className="login-label">Secure Email Address</label>
                  <input
                    className="login-input"
                    type="email"
                    value={email}
                    placeholder="EMAIL@DOMAIN.COM"
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="login-field">
                <label className="login-label">Access Code (Password)</label>
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
                {loading ? "Establishing handshake..." : isSignIn ? "Link Terminal" : "Generate Security Keys"}
              </button>
            </form>

            {/* SSO federated auth */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.06)" }} />
                <span style={{ fontSize: "9px", color: "var(--dim)", fontFamily: "IBM Plex Mono" }}>FEDERATED SSO</span>
                <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.06)" }} />
              </div>

              <button 
                className="btn-signin" 
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "center", 
                  gap: "10px", 
                  cursor: "not-allowed",
                  borderColor: "rgba(255,255,255,0.05)",
                  color: "var(--dim)",
                  background: "rgba(255,255,255,0.01)",
                  height: "36px"
                }}
                disabled
              >
                <Chrome size={14} />
                <span>Google Single-Sign On</span>
                <span className="premium-badge" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--dim)", fontSize: "7px", padding: "1px 4px" }}>COMING SOON</span>
              </button>
            </div>

            <div style={{ textAlign: "center", fontSize: "11px", color: "var(--dim)", marginTop: "4px" }}>
              {isSignIn ? (
                <>
                  Need secure terminal credentials?{" "}
                  <span style={{ color: "var(--red-hot)", cursor: "pointer", fontWeight: "600" }} onClick={handleOpenSignUp}>
                    Create keys
                  </span>
                </>
              ) : (
                <>
                  Credentials already configured?{" "}
                  <span style={{ color: "var(--red-hot)", cursor: "pointer", fontWeight: "600" }} onClick={handleOpenSignIn}>
                    Login
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

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
          <a href="#features" className="landing-nav-link">Features</a>
          <a href="#preview" className="landing-nav-link">Previews</a>
          <a href="#pricing" className="landing-nav-link">Pricing</a>
          <div className="landing-auth-btns">
            <button className="btn-signin" onClick={handleOpenSignIn}>Sign In</button>
            <button className="btn-signup" onClick={handleOpenSignUp}>Sign Up</button>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="hero-section">
        <span className="hero-badge">Cybernetic Release v1.0.7-alpha</span>
        <h1 className="hero-title">
          The Ultimate Quantum <br />
          <span>Crypto Trading Terminal</span>
        </h1>
        <p className="hero-desc">
          Professional order-book depth tracking, sub-millisecond execution pipelines, custom Strategy Labs,
          and sandboxed Python runtimes. Styled and optimized for institutional digital assets operations.
        </p>
        <div className="hero-ctas">
          <button className="btn-primary" onClick={handleOpenSignUp}>Start Trading Now</button>
          <button className="btn-secondary" onClick={handleOpenSignIn}>Open Live Demo</button>
        </div>
      </section>

      {/* Image Previews Section */}
      <section id="preview" className="preview-section" style={{ padding: "80px 40px", maxWidth: "1200px", margin: "0 auto", textAlign: "center" }}>
        <div className="section-header" style={{ marginBottom: "60px" }}>
          <h2 className="section-title">Visual Viewport Mockups</h2>
          <p className="section-desc">Designed with high-density telemetry dashboards and sleek layouts.</p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "60px" }}>
          {/* Mockup 1 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", alignItems: "center" }}>
            <div style={{ border: "1px solid rgba(255,0,0,0.15)", borderRadius: "6px", overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.6), 0 0 20px rgba(255,0,0,0.05)" }}>
              <img src={terminalMockup} alt="Black Terminal Interface Mockup" style={{ display: "block", width: "100%", maxWidth: "960px", height: "auto" }} />
            </div>
            <div style={{ maxWidth: "600px" }}>
              <h3 style={{ fontFamily: "Georgia, serif", fontSize: "20px", color: "var(--strong)", marginBottom: "8px" }}>Quant Trading Node Interface</h3>
              <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: "1.5" }}>
                Multi-monitor dashboard layout detailing order flows, tape deltas, volume profiles, and automated indicator logs.
              </p>
            </div>
          </div>

          {/* Mockup 2 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", alignItems: "center" }}>
            <div style={{ border: "1px solid rgba(255,0,0,0.15)", borderRadius: "6px", overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.6), 0 0 20px rgba(255,0,0,0.05)" }}>
              <img src={chartPreview} alt="Black Terminal Holographic Chart Projection" style={{ display: "block", width: "100%", maxWidth: "960px", height: "auto" }} />
            </div>
            <div style={{ maxWidth: "600px" }}>
              <h3 style={{ fontFamily: "Georgia, serif", fontSize: "20px", color: "var(--strong)", marginBottom: "8px" }}>Holographic Depth Telemetry Chart</h3>
              <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: "1.5" }}>
                Real-time rendered candlestick patterns overlayed with value area profiles, POC lines, and leverage liquidity clusters.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Expanded Features Section */}
      <section id="features" className="features-section">
        <div className="section-header">
          <h2 className="section-title">Cybernetic Operations Pipeline</h2>
          <p className="section-desc">Fully decoupled client architectures ensuring privacy and rendering speed.</p>
        </div>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon"><Activity size={24} /></div>
            <h3 className="feature-name">PixiJS WebGL Engine</h3>
            <p className="feature-text">
              Renders millions of candlesticks and leverage cluster graphics at 120 FPS. Superbly optimized to run smoothly even on multiple monitors.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Code2 size={24} /></div>
            <h3 className="feature-name">Sandboxed Indicator Editor</h3>
            <p className="feature-text">
              Write, compile, and run indicators using Python. Fully equipped with historical data buffering and custom signal triggers.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Shield size={24} /></div>
            <h3 className="feature-name">Encrypted Key Sockets</h3>
            <p className="feature-text">
              All API keys remain local. Handshakes are directly signed and transited straight to the exchanges (Binance, Bybit, OKX).
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Cpu size={24} /></div>
            <h3 className="feature-name">Strategy Optimization Lab</h3>
            <p className="feature-text">
              Test strategies in complex historical regimes. Features automated optimizer grids and walk-forward diagnostic matrix reports.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><TrendingUp size={24} /></div>
            <h3 className="feature-name">Real-Time Depth Analytics</h3>
            <p className="feature-text">
              Observe L2 depth blocks and order deltas. Get custom alerts for sweep runs, block reclaims, and large market maker fills.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Layers size={24} /></div>
            <h3 className="feature-name">Decoupled Architecture</h3>
            <p className="feature-text">
              If an API stream fails, the workspace falls back dynamically to backup REST nodes, preventing execution locks.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
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
              <li><Check size={16} /> Basic Candlestick Charting</li>
              <li><Check size={16} /> Binance Public WebSocket Feed</li>
              <li><Check size={16} /> 2 Custom Python Indicators</li>
              <li style={{ color: "var(--dim)" }}><X size={16} style={{ color: "var(--red)" }} /> No Order-Book Heatmaps</li>
            </ul>
            <button className="btn-plan" onClick={handleOpenSignUp}>Register Free</button>
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
              <li><Check size={16} /> Order-Book & Liquidation Heatmaps</li>
              <li><Check size={16} /> Multi-Exchange Feed (Bybit, OKX)</li>
              <li><Check size={16} /> Unlimited Indicators & Backtesting</li>
              <li><Check size={16} /> Priority Alert System Webhooks</li>
            </ul>
            <button className="btn-plan" onClick={handleOpenSignUp}>Activate Pro</button>
          </div>

          <div className="pricing-card" style={{ borderColor: "rgba(70,184,102,0.3)", boxShadow: "0 16px 40px rgba(70,184,102,0.05)" }}>
            <div className="plan-header">
              <span className="plan-name" style={{ color: "var(--green)" }}>Institutional & Investors</span>
              <div className="plan-price">
                <span className="price-amount">$199</span>
                <span className="price-period">/ month</span>
              </div>
              <p className="plan-desc">Full Strategy Optimization Labs and direct low-latency pipelines.</p>
            </div>
            <ul className="plan-features">
              <li><Check size={16} /> AI-Assisted Strategy Optimizer</li>
              <li><Check size={16} /> Sub-millisecond direct socket adapters</li>
              <li style={{ color: "var(--green)", fontWeight: "600" }}><Check size={16} /> INCL. INVESTOR ACCESS PANEL (VC & Angel backing)</li>
              <li style={{ color: "var(--green)", fontWeight: "600" }}><Check size={16} /> Portfolio metrics pipeline & Equity reports</li>
            </ul>
            <button className="btn-plan" style={{ borderColor: "rgba(70,184,102,0.4)", color: "var(--green)" }} onClick={handleOpenSignUp}>Contact Sales</button>
          </div>
        </div>
      </section>
    </div>
  );
}
