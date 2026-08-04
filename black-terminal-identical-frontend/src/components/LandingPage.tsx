import React, { useEffect, useState } from "react";
// Trigger Vercel Webhook sync
import { Check, Activity, Code2, Shield, ArrowLeft, Chrome, Layers, Cpu, TrendingUp } from "lucide-react";
import "../styles/landing.css";
import "../styles/login.css";
import {
  dbGetUsers,
  dbVerifyUser,
  dbRegisterUser,
  dbUpdateUser,
  dbAddAuditLog,
  establishSupabaseAuthSession,
  getGeoIPInfo
} from "../lib/supabase";
import { DEFAULT_ALLOWED_INDICATORS } from "../features/premium";

// Landing page product and brand imagery
import terminalMockup from "../assets/terminal_mockup.jpg";
import terminalLiveChart from "../assets/terminal-live-chart.png";
import blackCoreEngine from "../assets/black-core-engine.png";

interface LandingPageProps {
  onLoginSuccess: (username: string, role: "admin" | "user") => void;
}

type ViewState = "landing" | "signin" | "signup";

const rotatingHeroMessages = [
  "Execution intelligence without the noise.",
  "Market structure at institutional speed.",
  "One terminal. Every decisive signal."
] as const;

const phoneDialOptions = [
  { code: "IL", label: "IL Israel", dial: "+972" },
  { code: "GR", label: "GR Greece", dial: "+30" },
  { code: "CY", label: "CY Cyprus", dial: "+357" },
  { code: "US", label: "US United States", dial: "+1" },
  { code: "CA", label: "CA Canada", dial: "+1" },
  { code: "GB", label: "GB United Kingdom", dial: "+44" },
  { code: "DE", label: "DE Germany", dial: "+49" },
  { code: "FR", label: "FR France", dial: "+33" },
  { code: "IT", label: "IT Italy", dial: "+39" },
  { code: "ES", label: "ES Spain", dial: "+34" },
  { code: "PT", label: "PT Portugal", dial: "+351" },
  { code: "NL", label: "NL Netherlands", dial: "+31" },
  { code: "BE", label: "BE Belgium", dial: "+32" },
  { code: "CH", label: "CH Switzerland", dial: "+41" },
  { code: "AT", label: "AT Austria", dial: "+43" },
  { code: "SE", label: "SE Sweden", dial: "+46" },
  { code: "NO", label: "NO Norway", dial: "+47" },
  { code: "FI", label: "FI Finland", dial: "+358" },
  { code: "DK", label: "DK Denmark", dial: "+45" },
  { code: "IE", label: "IE Ireland", dial: "+353" },
  { code: "PL", label: "PL Poland", dial: "+48" },
  { code: "CZ", label: "CZ Czechia", dial: "+420" },
  { code: "SK", label: "SK Slovakia", dial: "+421" },
  { code: "HU", label: "HU Hungary", dial: "+36" },
  { code: "RO", label: "RO Romania", dial: "+40" },
  { code: "BG", label: "BG Bulgaria", dial: "+359" },
  { code: "HR", label: "HR Croatia", dial: "+385" },
  { code: "RS", label: "RS Serbia", dial: "+381" },
  { code: "SI", label: "SI Slovenia", dial: "+386" },
  { code: "UA", label: "UA Ukraine", dial: "+380" },
  { code: "TR", label: "TR Turkey", dial: "+90" },
  { code: "AE", label: "AE United Arab Emirates", dial: "+971" },
  { code: "SA", label: "SA Saudi Arabia", dial: "+966" },
  { code: "QA", label: "QA Qatar", dial: "+974" },
  { code: "KW", label: "KW Kuwait", dial: "+965" },
  { code: "AU", label: "AU Australia", dial: "+61" },
  { code: "NZ", label: "NZ New Zealand", dial: "+64" },
  { code: "SG", label: "SG Singapore", dial: "+65" },
  { code: "IN", label: "IN India", dial: "+91" },
  { code: "JP", label: "JP Japan", dial: "+81" },
  { code: "KR", label: "KR South Korea", dial: "+82" },
  { code: "CN", label: "CN China", dial: "+86" },
  { code: "HK", label: "HK Hong Kong", dial: "+852" },
  { code: "TH", label: "TH Thailand", dial: "+66" },
  { code: "ZA", label: "ZA South Africa", dial: "+27" },
  { code: "BR", label: "BR Brazil", dial: "+55" },
  { code: "MX", label: "MX Mexico", dial: "+52" },
  { code: "AR", label: "AR Argentina", dial: "+54" },
  { code: "CL", label: "CL Chile", dial: "+56" },
  { code: "CO", label: "CO Colombia", dial: "+57" }
];

const countryDialCodes: Record<string, string> = Object.fromEntries(
  phoneDialOptions.map((option) => [option.code, option.dial])
);


export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [view, setView] = useState<ViewState>(() => {
    if (window.location.hostname !== "127.0.0.1") return "landing";
    const requestedView = new URLSearchParams(window.location.search).get("authPreview");
    return requestedView === "signin" || requestedView === "signup" ? requestedView : "landing";
  });
  const [heroMessageIndex, setHeroMessageIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHeroMessageIndex((current) => (current + 1) % rotatingHeroMessages.length);
    }, 2800);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(".landing-reveal"));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      elements.forEach((element) => element.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14, rootMargin: "0px 0px -8%" }
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  // Form states
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // New registration multi-step states
  const [signUpStep, setSignUpStep] = useState(1);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [organization, setOrganization] = useState("");
  const [billingAddress, setBillingAddress] = useState("");
  const [purposeOfUse, setPurposeOfUse] = useState<"personal" | "commercial">("personal");
  const [referredBy, setReferredBy] = useState("google");
  const [otherReferral, setOtherReferral] = useState("");
  const [phone, setPhone] = useState("");
  const [phonePrefix, setPhonePrefix] = useState("+972");
  const [newsletterOptIn, setNewsletterOptIn] = useState(false);

  // Captcha & Code verification states
  const [mathCaptcha, setMathCaptcha] = useState({ num1: 0, num2: 0, result: 0 });
  const [captchaAnswer, setCaptchaAnswer] = useState("");

  const generateCaptcha = () => {
    const num1 = Math.floor(Math.random() * 9) + 2;
    const num2 = Math.floor(Math.random() * 9) + 2;
    setMathCaptcha({ num1, num2, result: num1 + num2 });
    setCaptchaAnswer("");
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    const cleanUser = username.trim();
    const cleanPass = password.trim();

    if (!cleanUser || !cleanPass) {
      setErrorMsg("Please fill all fields");
      return;
    }

    setLoading(true);

    try {
      const authResult = await dbVerifyUser(cleanUser, cleanPass);
      if (!authResult.success) {
        setErrorMsg(authResult.error || "Access denied: Invalid credentials");
        setLoading(false);
        return;
      }

      // Fetch user details to verify suspension and update status/lastLogin
      const users = await dbGetUsers();
      const userObj = users.find((u) => u.email.toLowerCase() === cleanUser.toLowerCase());
      if (userObj) {
        if (userObj.status === "suspended") {
          setErrorMsg("Access suspended by Administrator");
          setLoading(false);
          return;
        }

        const geo = await getGeoIPInfo();
        await dbUpdateUser(cleanUser, {
          status: "online",
          lastLogin: new Date().toISOString(),
          ip: geo.ip,
          countryCode: geo.countryCode,
          countryName: geo.countryName
        });

        if (!userObj.emailVerified) await dbUpdateUser(userObj.username, { emailVerified: true });

        await dbAddAuditLog("LOGIN", `User ${cleanUser} logged in from landing page.`);
        onLoginSuccess(cleanUser, userObj.role);
      } else {
        setErrorMsg("User profile not found. Please register a fresh account.");
        setLoading(false);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Database connection error");
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    const cleanUser = username.trim();
    const cleanDisplayName = displayName.trim();
    const cleanEmail = email.trim();
    const cleanPass = password.trim();

    if (signUpStep === 1) {
      if (!cleanDisplayName || !cleanUser || !cleanEmail || !cleanPass || !confirmPassword.trim()) {
        setErrorMsg("Please fill all fields");
        return;
      }

      if (cleanUser.length < 3) {
        setErrorMsg("Username must be at least 3 characters");
        return;
      }

      if (!cleanEmail.includes("@")) {
        setErrorMsg("Please enter a valid email address");
        return;
      }

      // Allowed domains validation
      const allowedDomains = ["gmail.com", "googlemail.com", "proton.me", "protonmail.com", "protonmail.ch", "outlook.com", "hotmail.com", "icloud.com", "yahoo.com"];
      const emailDomain = cleanEmail.split("@")[1]?.toLowerCase();
      if (!allowedDomains.includes(emailDomain)) {
        setErrorMsg("Access denied. Only standard email domains are allowed (Google, Proton, Outlook, Hotmail, iCloud, Yahoo).");
        return;
      }

      if (cleanPass.length < 6) {
        setErrorMsg("Password must be at least 6 characters");
        return;
      }

      if (cleanPass !== confirmPassword.trim()) {
        setErrorMsg("Passwords do not match");
        return;
      }

      // Check if user already exists locally
      setLoading(true);
      try {
        const users = await dbGetUsers();
        if (users.some(u => u.username.toLowerCase() === cleanUser.toLowerCase())) {
          setErrorMsg("Username already exists");
          setLoading(false);
          return;
        }
      } catch (err) {
        console.error("User pre-check failed:", err);
      }
      setLoading(false);

      // Advance to Step 2
      generateCaptcha();
      setLoading(true);
      try {
        const geo = await getGeoIPInfo();
        if (geo.countryCode) {
          const dial = countryDialCodes[geo.countryCode.toUpperCase()];
          if (dial) setPhonePrefix(dial);
        }
      } catch (e) {
        console.error("Geo pre-fetch failed:", e);
      }
      setLoading(false);
      setSignUpStep(2);
      return;
    }

    if (signUpStep === 2) {
      const cleanFirst = firstName.trim();
      const cleanLast = lastName.trim();
      const cleanOrg = organization.trim();
      const cleanBilling = billingAddress.trim();
      const cleanPhone = phone.trim();

      if (!cleanFirst || !cleanLast || !cleanOrg || !cleanBilling || !cleanPhone || !captchaAnswer.trim()) {
        setErrorMsg("Please fill all fields and solve CAPTCHA");
        return;
      }

      if (parseInt(captchaAnswer) !== mathCaptcha.result) {
        setErrorMsg("CAPTCHA answer is incorrect. Please try again.");
        return;
      }

      // Supabase Auth owns verification email generation and code/link validation.
      setLoading(true);
      try {
        const authResult = await establishSupabaseAuthSession({
          username: cleanUser,
          displayName: cleanDisplayName,
          email: cleanEmail,
          role: "user"
        }, cleanPass, { allowCreate: true });
        setLoading(false);
        setSignUpStep(3);
        setSuccessMsg(authResult.success
          ? "Secure Supabase Auth session established. Complete profile setup."
          : authResult.error || `Verification link sent to ${cleanEmail}. Confirm it, then continue.`);
      } catch (err: any) {
        setLoading(false);
        setErrorMsg(err.message || "Email dispatch failed");
      }
      return;
    }

    if (signUpStep === 3) {
      setLoading(true);
      try {
        const defaultAllowed = [...DEFAULT_ALLOWED_INDICATORS];
        const newUser = {
          username: cleanUser,
          displayName: cleanDisplayName,
          email: cleanEmail,
          role: "user" as const,
          status: "online" as const,
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          allowedIndicators: defaultAllowed,
          activeIndicators: [],
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          organization: organization.trim(),
          billingAddress: billingAddress.trim(),
          purposeOfUse: purposeOfUse,
          phone: `${phonePrefix} ${phone.trim()}`,
          newsletterOptIn: newsletterOptIn,
          referredBy: referredBy === "other" ? otherReferral.trim() : referredBy,
          emailVerified: false
        };

        const secureSession = await establishSupabaseAuthSession(newUser, cleanPass);
        if (!secureSession.success) {
          setErrorMsg(secureSession.error || "Confirm your email, then continue registration.");
          setLoading(false);
          return;
        }
        const regResult = await dbRegisterUser(newUser, cleanPass);
        if (!regResult.success) {
          setErrorMsg(regResult.error || "Registration failed. Try again.");
          setLoading(false);
          return;
        }

        await dbAddAuditLog("CREATE", `New secure account registered: ${cleanUser} (${cleanEmail})`);
        await dbAddAuditLog("LOGIN", `User ${cleanUser} logged in automatically.`);
        await dbUpdateUser(cleanUser, { emailVerified: true });

        setSuccessMsg("Handshake successful! Terminal ready...");
        setTimeout(() => {
          onLoginSuccess(cleanUser, newUser.role);
        }, 800);
      } catch (err: any) {
        setErrorMsg(err.message || "Database connection error");
        setLoading(false);
      }
    }
  };

  const handleOpenSignIn = () => {
    setErrorMsg("");
    setUsername("");
    setDisplayName("");
    setEmail("");
    setPassword("");
    setView("signin");
  };

  const handleOpenSignUp = () => {
    setErrorMsg("");
    setUsername("");
    setDisplayName("");
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setFirstName("");
    setLastName("");
    setOrganization("");
    setBillingAddress("");
    setPurposeOfUse("personal");
    setReferredBy("google");
    setOtherReferral("");
    setPhone("");
    setNewsletterOptIn(false);
    setSignUpStep(1);
    setView("signup");
  };

  const renderAuthModal = () => {
    if (view === "landing") return null;
    const isSignIn = view === "signin";
    return (
      <div className={`login-container auth-page ${isSignIn ? "signin-page" : "signup-page"}`}>
        <div className="login-bg-decor" />
        <header className="auth-page-nav">
          <button type="button" className="auth-page-brand" onClick={() => setView("landing")}>
            <span className="auth-brand-mark" aria-hidden="true" />
            <span><b>BLACK TERMINAL</b><small>QUANTITATIVE EXECUTION SYSTEM</small></span>
          </button>
          <div className="auth-page-status"><i /> BLACK CORE ONLINE <span>01</span></div>
          <button type="button" className="auth-page-switch" onClick={isSignIn ? handleOpenSignUp : handleOpenSignIn}>
            {isSignIn ? "Create account" : "Sign in"}
          </button>
        </header>

        <main className="login-card">
          <section className="login-visual">
            <div className="auth-visual-grid" aria-hidden="true" />
            <div className="visual-top">
              <span className="visual-badge"><Activity size={13} /> INSTITUTIONAL ACCESS</span>
              <h1 className="visual-title">
                {isSignIn ? <>Enter the <span>decision layer.</span></> : <>Build your <span>trading edge.</span></>}
              </h1>
              <p className="visual-desc">
                {isSignIn
                  ? "One secure workspace for market structure, execution intelligence and real-time risk control."
                  : "Create a private Black Terminal workspace engineered for high-signal research and decisive execution."}
              </p>
              <div className="auth-feature-pills">
                <span><Layers size={14} /> Unified market intelligence</span>
                <span><Shield size={14} /> Encrypted workspace</span>
                <span><Cpu size={14} /> Black Core runtime</span>
              </div>
            </div>

            <div className="auth-terminal-preview">
              <div className="auth-preview-bar">
                <span><i /> LIVE / BTCUSDT</span>
                <small>BLACK CORE ENGINE</small>
              </div>
              <img src={terminalLiveChart} alt="Black Terminal live trading workspace" />
              <div className="auth-preview-signal">
                <span>MARKET SIGNAL</span>
                <b>STRUCTURE CONFIRMED</b>
              </div>
            </div>

            <div className="visual-bottom">
              <div className="login-live-stats">
                <div className="login-stat-item"><span className="login-stat-lbl">ENGINE LATENCY</span><span className="login-stat-val up">1.42ms</span></div>
                <div className="login-stat-item"><span className="login-stat-lbl">RENDER PIPELINE</span><span className="login-stat-val">120 FPS</span></div>
                <div className="login-stat-item"><span className="login-stat-lbl">DATA COVERAGE</span><span className="login-stat-val">24 / 7</span></div>
              </div>
              <div className="auth-engine-signature"><span className="auth-core-mini" /> Powered by <b>Black Core Engine</b></div>
            </div>
          </section>

          <section className="login-form-area">
            <button type="button" className="modal-close-btn auth-back-button" onClick={() => setView("landing")}>
              <ArrowLeft size={18} />
              <span>Back to home</span>
            </button>

            <div className="login-header">
              <div className="login-logo" />
              <div className="login-title-group">
                <span className="login-kicker">{isSignIn ? "WELCOME BACK" : "NEW WORKSPACE"}</span>
                <h2 className="login-title">{isSignIn ? "Access your terminal" : "Create your account"}</h2>
                <p className="login-subtitle">{isSignIn ? "Continue to your encrypted execution workspace." : "Three short steps to initialize your private terminal."}</p>
              </div>
            </div>

             {view === "signup" && (
               <div className="signup-steps-header">
                 <div className={`signup-step-tab ${signUpStep === 1 ? 'active' : ''}`}>
                   <span className="signup-step-tab-num">1</span> CREDENTIALS
                 </div>
                 <div className={`signup-step-tab ${signUpStep === 2 ? 'active' : ''}`}>
                   <span className="signup-step-tab-num">2</span> PROFILE & BILLING
                 </div>
                 <div className={`signup-step-tab ${signUpStep === 3 ? 'active' : ''}`}>
                   <span className="signup-step-tab-num">3</span> VERIFY
                 </div>
               </div>
             )}

             <form className="login-form" onSubmit={isSignIn ? handleSignIn : handleSignUp}>
               {errorMsg && <div className="login-error-msg">{errorMsg}</div>}
               {successMsg && <div className="signup-success-msg">{successMsg}</div>}

               {/* SIGN IN VIEW */}
               {isSignIn && (
                 <>
                   <div className="login-field">
                     <label className="login-label">Email or terminal handle</label>
                     <input
                       className="login-input"
                       type="text"
                       value={username}
                       placeholder="name@company.com"
                       onChange={(e) => setUsername(e.target.value)}
                       disabled={loading}
                       autoComplete="off"
                       required
                     />
                   </div>
                   <div className="login-field">
                     <label className="login-label">Password</label>
                     <input
                       className="login-input"
                       type="password"
                       value={password}
                       placeholder="Enter your secure password"
                       onChange={(e) => setPassword(e.target.value)}
                       disabled={loading}
                       autoComplete="off"
                       required
                     />
                   </div>
                   <button className="login-submit-btn" type="submit" disabled={loading}>
                     {loading ? "Establishing secure session..." : "Enter Black Terminal"}
                   </button>
                 </>
               )}

               {/* SIGN UP STEP 1: CREDENTIALS */}
               {!isSignIn && signUpStep === 1 && (
                 <>
                   <div className="login-field">
                     <label className="login-label">Display Name</label>
                     <input
                       className="login-input"
                       type="text"
                       value={displayName}
                       placeholder="DISPLAY NAME"
                       onChange={(e) => setDisplayName(e.target.value)}
                       disabled={loading}
                       autoComplete="name"
                     />
                     <span style={{ fontSize: '9px', color: 'var(--dim)', marginTop: '4px', display: 'block' }}>
                       Public profile name. Spaces are allowed.
                     </span>
                   </div>
                   <div className="login-field">
                     <label className="login-label">Terminal Handle</label>
                     <input
                       className="login-input"
                       type="text"
                       value={username}
                       placeholder="YOUR USERNAME"
                       onChange={(e) => setUsername(e.target.value)}
                       disabled={loading}
                       autoComplete="email"
                     />
                   </div>
                   <div className="login-field">
                     <label className="login-label">Email Address</label>
                     <input
                       className="login-input"
                       type="email"
                       value={email}
                       placeholder="name@company.com"
                       onChange={(e) => setEmail(e.target.value)}
                       disabled={loading}
                       autoComplete="off"
                     />
                     <span style={{ fontSize: '9px', color: 'var(--dim)', marginTop: '4px', display: 'block' }}>
                       Only Google, Proton, Outlook, Hotmail, iCloud, Yahoo addresses accepted.
                     </span>
                   </div>
                   <div className="login-field">
                     <label className="login-label">Password</label>
                     <input
                       className="login-input"
                       type="password"
                       value={password}
                       placeholder="Create a secure password"
                       onChange={(e) => setPassword(e.target.value)}
                       disabled={loading}
                       autoComplete="off"
                     />
                   </div>
                   <div className="login-field">
                     <label className="login-label">Confirm Password</label>
                     <input
                       className="login-input"
                       type="password"
                       value={confirmPassword}
                       placeholder="Repeat your password"
                       onChange={(e) => setConfirmPassword(e.target.value)}
                       disabled={loading}
                       autoComplete="off"
                     />
                   </div>
                   <button className="login-submit-btn" type="submit" disabled={loading}>
                     Next: Profile Setup
                   </button>
                 </>
               )}

               {/* SIGN UP STEP 2: PROFILE & BILLING */}
               {!isSignIn && signUpStep === 2 && (
                 <>
                   <div className="signup-two-col">
                     <div className="login-field">
                       <label className="login-label">First Name</label>
                       <input
                         className="login-input"
                         type="text"
                         value={firstName}
                         placeholder="FIRST NAME"
                         onChange={(e) => setFirstName(e.target.value)}
                         disabled={loading}
                       />
                     </div>
                     <div className="login-field">
                       <label className="login-label">Last Name</label>
                       <input
                         className="login-input"
                         type="text"
                         value={lastName}
                         placeholder="LAST NAME"
                         onChange={(e) => setLastName(e.target.value)}
                         disabled={loading}
                       />
                     </div>
                   </div>

                   <div className="login-field">
                     <label className="login-label">Organization / Company</label>
                     <input
                       className="login-input"
                       type="text"
                       value={organization}
                       placeholder="COMPANY OR INDEPENDENT"
                       onChange={(e) => setOrganization(e.target.value)}
                       disabled={loading}
                     />
                   </div>

                   <div className="login-field">
                     <label className="login-label">Billing Address</label>
                     <input
                       className="login-input"
                       type="text"
                       value={billingAddress}
                       placeholder="STREET, CITY, COUNTRY"
                       onChange={(e) => setBillingAddress(e.target.value)}
                       disabled={loading}
                     />
                   </div>

                   <div className="signup-two-col">
                     <div className="login-field">
                       <label className="login-label">Purpose of Use</label>
                       <select
                         className="signup-select"
                         value={purposeOfUse}
                         onChange={(e: any) => setPurposeOfUse(e.target.value)}
                         disabled={loading}
                       >
                          <option value="personal">Personal Use</option>
                          <option value="commercial">Commercial Use</option>
                        </select>
                     </div>

                     <div className="login-field">
                       <label className="login-label">How did you find us?</label>
                       <select
                         className="signup-select"
                         value={referredBy}
                         onChange={(e) => setReferredBy(e.target.value)}
                         disabled={loading}
                       >
                         <option value="google">Google Search</option>
                          <option value="social">Social Media</option>
                          <option value="friend">Friend / Colleague</option>
                          <option value="other">Other (Please specify)</option>
                       </select>
                     </div>
                   </div>

                   {referredBy === "other" && (
                     <div className="login-field">
                       <label className="login-label">Referral Source Details</label>
                       <input
                         className="login-input"
                         type="text"
                         value={otherReferral}
                         placeholder="SPECIFY SOURCE"
                         onChange={(e) => setOtherReferral(e.target.value)}
                         disabled={loading}
                       />
                     </div>
                   )}

                   <div className="login-field">
                     <label className="login-label">Phone Number for 2FA</label>
                     <div className="signup-phone-container">
                       <select
                         className="signup-phone-prefix"
                         value={phonePrefix}
                          onChange={(e) => setPhonePrefix(e.target.value)}
                          disabled={loading}
                        >
                          {phoneDialOptions.map((option) => (
                            <option key={`${option.code}-${option.dial}`} value={option.dial}>
                              {option.label} {option.dial}
                            </option>
                          ))}
                          {false && (
                            <>
                         <option value="+972">🇮🇱 +972</option>
                         <option value="+1">🇺🇸 +1</option>
                         <option value="+44">🇬🇧 +44</option>
                         <option value="+49">🇩🇪 +49</option>
                         <option value="+33">🇫🇷 +33</option>
                         <option value="+971">🇦🇪 +971</option>
                         <option value="+39">🇮🇹 +39</option>
                         <option value="+34">🇪🇸 +34</option>
                            </>
                          )}
                       </select>
                       <input
                         className="login-input"
                         type="tel"
                         value={phone}
                         placeholder="541234567"
                         onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                         disabled={loading}
                       />
                     </div>
                   </div>

                   <label className="signup-checkbox-label">
                     <input
                       type="checkbox"
                       className="signup-checkbox"
                       checked={newsletterOptIn}
                       onChange={(e) => setNewsletterOptIn(e.target.checked)}
                       disabled={loading}
                     />
                     <span>I want to receive terminal system updates, hot features, billing terms and statements.</span>
                   </label>

                   {/* CAPTCHA SECTION */}
                   <div className="signup-captcha-box">
                     <span className="signup-captcha-question">
                       CAPTCHA: {mathCaptcha.num1} + {mathCaptcha.num2} =
                     </span>
                     <input
                       className="signup-captcha-input"
                       type="text"
                       value={captchaAnswer}
                       placeholder="?"
                       onChange={(e) => setCaptchaAnswer(e.target.value.replace(/\D/g, ''))}
                       disabled={loading}
                       maxLength={3}
                     />
                   </div>

                   <div className="signup-wizard-nav">
                     <button
                       className="signup-back-btn"
                       type="button"
                       onClick={() => setSignUpStep(1)}
                       disabled={loading}
                     >
                       Back
                     </button>
                     <button className="login-submit-btn" type="submit" disabled={loading}>
                       {loading ? "Sending mail..." : "Send Verification Code"}
                     </button>
                   </div>
                 </>
               )}

               {/* SIGN UP STEP 3: CODE VERIFICATION */}
               {!isSignIn && signUpStep === 3 && (
                 <>
                   <div className="signup-verification-text">
                     Confirm the Supabase Auth verification email, then continue. Black Terminal never generates verification codes in browser JavaScript.
                   </div>
                   <div className="signup-wizard-nav">
                     <button
                       className="signup-back-btn"
                       type="button"
                       onClick={() => setSignUpStep(2)}
                       disabled={loading}
                     >
                       Back
                     </button>
                     <button className="login-submit-btn" type="submit" disabled={loading}>
                       {loading ? "Completing handshake..." : "I Confirmed Email — Complete Signup"}
                     </button>
                   </div>
                 </>
               )}
             </form>

            <div className="auth-sso-area">
              <div className="auth-sso-divider">
                <div />
                <span>OR CONTINUE WITH</span>
                <div />
              </div>

              <button className="auth-google-btn" disabled>
                <Chrome size={17} />
                <span>Continue with Google</span>
                <small>COMING SOON</small>
              </button>
            </div>

            <div className="auth-form-switch">
              {isSignIn ? (
                <>
                  New to Black Terminal? <button type="button" onClick={handleOpenSignUp}>Create an account</button>
                </>
              ) : (
                <>
                  Already have an account? <button type="button" onClick={handleOpenSignIn}>Sign in</button>
                </>
              )}
            </div>
          </section>
        </main>

        <footer className="auth-page-footer">
          <span>© 2026 BLACK TERMINAL</span>
          <span>SECURE SESSION / AES-256</span>
          <span>PRIVACY · TERMS · SYSTEM STATUS</span>
        </footer>
      </div>
    );
  };

  if (view !== "landing") return renderAuthModal();

  return (
    <div className="landing-container">
      <div className="landing-ambient landing-ambient-one" aria-hidden="true" />
      <div className="landing-ambient landing-ambient-two" aria-hidden="true" />

      <header className="landing-header">
        <div className="landing-shell landing-header-inner">
          <a className="landing-logo-group" href="#top" aria-label="Black Terminal home">
            <div className="landing-logo-icon" />
            <div className="landing-logo-copy">
              <span className="landing-logo-title">BLACK TERMINAL</span>
              <span className="landing-logo-subtitle">QUANTITATIVE EXECUTION SYSTEM</span>
            </div>
          </a>

          <nav className="landing-nav" aria-label="Primary navigation">
            <a href="#features" className="landing-nav-link">Features</a>
            <a href="#engine" className="landing-nav-link">Platform</a>
            <a href="#pricing" className="landing-nav-link">Pricing</a>
            <a href="#footer" className="landing-nav-link">Resources</a>
          </nav>

          <div className="landing-auth-btns">
            <button type="button" className="btn-signin" onClick={handleOpenSignIn}>Sign In</button>
            <button type="button" className="btn-signup" onClick={handleOpenSignUp}>Start Trading</button>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero-section landing-shell">
          <div className="hero-copy landing-reveal is-visible">
            <div className="hero-system-line">
              <span className="hero-status-dot" />
              SYSTEM ONLINE <span>v1.0.7</span> <span>ALL SYSTEMS NOMINAL</span>
            </div>
            <h1 className="hero-title">
              The Ultimate Quantum
              <span>Crypto Trading Terminal</span>
            </h1>
            <div className="hero-rotator" aria-live="polite">
              <span key={heroMessageIndex} className="hero-rotating-text">
                {rotatingHeroMessages[heroMessageIndex]}
              </span>
            </div>
            <p className="hero-desc">
              Institutional-grade execution, live market intelligence, and quantitative workflows built for traders who need clarity at speed.
            </p>
            <div className="hero-ctas">
              <button type="button" className="btn-primary" onClick={handleOpenSignUp}>Start Trading</button>
              <button type="button" className="btn-secondary" onClick={handleOpenSignIn}>View Live Demo</button>
            </div>
            <div className="hero-trust-row" aria-label="Platform highlights">
              <span><Shield size={15} /> Institutional Security</span>
              <span><Activity size={15} /> Sub-Millisecond</span>
              <span><Layers size={15} /> Multi-Exchange</span>
            </div>
          </div>

          <div className="hero-product landing-reveal is-visible">
            <div className="hero-product-glow" aria-hidden="true" />
            <div className="terminal-window">
              <div className="terminal-window-bar">
                <span className="terminal-window-brand"><i /> BLACK TERMINAL / LIVE DESK</span>
                <span className="terminal-window-market">BTCUSDT · 1D · BINANCE</span>
                <span className="terminal-window-live">LIVE</span>
              </div>
              <img src={terminalLiveChart} alt="Black Terminal live BTCUSDT market workspace" />
            </div>
          </div>

          <div className="hero-metrics landing-reveal is-visible">
            <article>
              <span>LATENCY</span>
              <strong>0.42ms</strong>
              <small>Average</small>
            </article>
            <article>
              <span>DAILY VOLUME</span>
              <strong>$18.73B</strong>
              <small>24 hours</small>
            </article>
            <article>
              <span>ACTIVE STRATEGIES</span>
              <strong>1,402</strong>
              <small>Running</small>
            </article>
            <article>
              <span>UPTIME</span>
              <strong>99.999%</strong>
              <small>Verified</small>
            </article>
          </div>
        </section>

        <section id="engine" className="engine-section">
          <div className="landing-shell engine-grid landing-reveal">
            <div className="engine-artwork-wrap">
              <div className="engine-orbit engine-orbit-one" aria-hidden="true" />
              <div className="engine-orbit engine-orbit-two" aria-hidden="true" />
              <img className="engine-artwork" src={blackCoreEngine} alt="Black Core Engine triangular mark" />
            </div>

            <div className="engine-copy">
              <span className="section-kicker">ENGINE CORE</span>
              <h2>Powered by <span>Black Core Engine</span></h2>
              <p>
                Proprietary execution intelligence connects live data, analytics, and resilient routing in one focused operating layer.
              </p>
              <div className="engine-capabilities">
                <article><Activity size={20} /><strong>Sub-Millisecond</strong><span>Execution</span></article>
                <article><Cpu size={20} /><strong>Multi-Core</strong><span>Processing</span></article>
                <article><TrendingUp size={20} /><strong>Predictive</strong><span>Analytics</span></article>
                <article><Shield size={20} /><strong>Institutional</strong><span>Reliability</span></article>
              </div>
            </div>
          </div>
        </section>

        <section id="preview" className="preview-section landing-shell landing-reveal">
          <div className="section-header section-header-split">
            <div>
              <span className="section-kicker">THE PLATFORM</span>
              <h2 className="section-title">Institutional Interface, <span>Reimagined.</span></h2>
            </div>
            <p className="section-desc">Powerful, intuitive workspaces built for speed, precision, and institutional scale.</p>
          </div>

          <div className="preview-grid">
            <article className="preview-card">
              <div className="preview-media">
                <img src={terminalMockup} alt="Black Terminal quantitative order book desk" />
              </div>
              <div className="preview-card-copy">
                <h3>Quantitative Order Book Desk</h3>
                <p>Cross-market execution with real-time volume profiles, risk context, and deep order-book analytics.</p>
                <a href="#features">Explore Order Book <span>→</span></a>
              </div>
            </article>

            <article className="preview-card">
              <div className="preview-media preview-media-live">
                <img src={terminalLiveChart} alt="Live Black Terminal BTCUSDT chart workspace" />
                <span className="preview-live-pill"><i /> LIVE WORKSPACE</span>
              </div>
              <div className="preview-card-copy">
                <h3>Real-Time Market Workspace</h3>
                <p>Your real Black Terminal chart, market depth, order book, and execution controls in one high-density viewport.</p>
                <a href="#features">Explore Live Chart <span>→</span></a>
              </div>
            </article>
          </div>
        </section>

        <section id="features" className="features-section landing-shell landing-reveal">
          <div className="section-header">
            <span className="section-kicker">BUILT FOR SERIOUS MARKET WORK</span>
            <h2 className="section-title">Advanced Tools. Institutional Edge.</h2>
            <p className="section-desc">Every workflow stays focused, fast, and visually consistent from research to execution.</p>
          </div>

          <div className="features-grid">
            <article className="feature-card">
              <div className="feature-icon"><Activity size={24} /></div>
              <h3 className="feature-name">High-Throughput WebGL Engine</h3>
              <p className="feature-text">Hardware-accelerated rendering for dense data and fluid multi-monitor workflows.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><Code2 size={24} /></div>
              <h3 className="feature-name">Strategy Simulation Sandbox</h3>
              <p className="feature-text">Develop, compile, and backtest strategies against native low-latency feeds.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><Shield size={24} /></div>
              <h3 className="feature-name">Institutional Security Protocol</h3>
              <p className="feature-text">Locally signed credentials, protected routes, and controlled execution boundaries.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><Cpu size={24} /></div>
              <h3 className="feature-name">Algorithmic Optimization Suite</h3>
              <p className="feature-text">Walk-forward diagnostics, optimizer grids, and rigorous risk analytics.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><TrendingUp size={24} /></div>
              <h3 className="feature-name">Order Flow & Liquidity Intelligence</h3>
              <p className="feature-text">Level 2 context and market-activity signals presented without visual noise.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><Layers size={24} /></div>
              <h3 className="feature-name">Fault-Tolerant Infrastructure</h3>
              <p className="feature-text">Resilient routing and failover paths designed to reduce execution disruption.</p>
            </article>
          </div>
        </section>

        <section id="pricing" className="pricing-section landing-shell landing-reveal">
          <div className="section-header">
            <span className="section-kicker">SIMPLE, TRANSPARENT PRICING</span>
            <h2 className="section-title">Choose the Plan That Powers Your Edge</h2>
            <p className="section-desc">Flexible access for independent researchers, professional traders, and institutions.</p>
          </div>

          <div className="pricing-grid">
            <article className="pricing-card">
              <div className="plan-header">
                <span className="plan-name">Quantum Sandbox</span>
                <div className="plan-price"><span className="price-amount">$0</span><span className="price-period">/ forever</span></div>
                <p className="plan-desc">A focused environment for quantitative research and strategy validation.</p>
              </div>
              <ul className="plan-features">
                <li><Check size={16} /> Standard Charting Environment</li>
                <li><Check size={16} /> Real-Time Exchange Data</li>
                <li><Check size={16} /> Two Strategy Slots</li>
              </ul>
              <button type="button" className="btn-plan" onClick={handleOpenSignUp}>Register Free</button>
            </article>

            <article className="pricing-card popular">
              <span className="popular-badge">Most Popular</span>
              <div className="plan-header">
                <span className="plan-name">Professional Terminal</span>
                <div className="plan-price"><span className="price-amount">$49</span><span className="price-period">/ month</span></div>
                <p className="plan-desc">Advanced execution desks, backtests, heatmaps, and professional workflows.</p>
              </div>
              <ul className="plan-features">
                <li><Check size={16} /> Order Book & Liquidity Heatmaps</li>
                <li><Check size={16} /> Multi-Exchange Data Feeds</li>
                <li><Check size={16} /> Unlimited Indicators</li>
                <li><Check size={16} /> Priority Alert Webhooks</li>
              </ul>
              <button type="button" className="btn-plan" onClick={handleOpenSignUp}>Activate Pro</button>
            </article>

            <article className="pricing-card">
              <div className="plan-header">
                <span className="plan-name">Enterprise Execution Suite</span>
                <div className="plan-price"><span className="price-amount">$199</span><span className="price-period">/ month</span></div>
                <p className="plan-desc">Dedicated infrastructure, execution controls, and custom compliance support.</p>
              </div>
              <ul className="plan-features">
                <li><Check size={16} /> AI-Assisted Strategy Optimizer</li>
                <li><Check size={16} /> Direct Socket Execution</li>
                <li><Check size={16} /> Institutional Access Panel</li>
                <li><Check size={16} /> Portfolio & Equity Reports</li>
              </ul>
              <button type="button" className="btn-plan" onClick={handleOpenSignUp}>Contact Sales</button>
            </article>
          </div>
        </section>

        <section className="landing-cta landing-shell landing-reveal">
          <div className="landing-cta-mark"><TrendingUp size={27} /></div>
          <div>
            <h2>Ready to elevate your trading infrastructure?</h2>
            <p>Enter a faster, clearer, and more focused quantitative workspace.</p>
          </div>
          <div className="landing-cta-actions">
            <button type="button" className="btn-primary" onClick={handleOpenSignUp}>Start Trading</button>
            <button type="button" className="btn-secondary" onClick={handleOpenSignIn}>View Live Demo</button>
          </div>
        </section>
      </main>

      <footer id="footer" className="landing-footer">
        <div className="landing-shell landing-footer-grid">
          <div className="landing-footer-brand">
            <div className="landing-logo-group">
              <div className="landing-logo-icon" />
              <span className="landing-logo-title">BLACK TERMINAL</span>
            </div>
            <p>Institutional-grade crypto trading technology for quantitative researchers and professional traders.</p>
          </div>
          <div><strong>Platform</strong><a href="#features">Features</a><a href="#preview">Trading Terminal</a><a href="#engine">Black Core Engine</a></div>
          <div><strong>Resources</strong><a href="#preview">Product Preview</a><a href="#pricing">Plans</a><a href="#top">System Status</a></div>
          <div><strong>Company</strong><a href="#top">About Us</a><a href="#footer">Contact</a><a href="#footer">Legal</a></div>
        </div>
        <div className="landing-shell landing-footer-bottom">
          <span>© 2026 BLACK TERMINAL. All rights reserved.</span>
          <span>Privacy Policy · Terms of Service · Cookie Policy</span>
        </div>
      </footer>

    </div>
  );
}
