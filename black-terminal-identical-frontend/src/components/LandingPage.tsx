import React, { useState } from "react";
// Trigger Vercel Webhook sync
import { Check, Activity, Bell, Code2, Shield, Lock, X, ArrowLeft, Chrome, Layers, Cpu, TrendingUp, Users } from "lucide-react";
import "../styles/landing.css";
import "../styles/login.css";
import {
  BLACK_TERMINAL_ADMIN_EMAIL,
  BLACK_TERMINAL_ADMIN_USERNAME,
  dbGetUsers,
  dbVerifyUser,
  dbRegisterUser,
  dbUpdateUser,
  dbAddAuditLog,
  establishSupabaseAuthSession,
  getGeoIPInfo
} from "../lib/supabase";
import { sendVerificationEmail } from "../lib/resend";

// Import generated images
import terminalMockup from "../assets/terminal_mockup.jpg";
import chartPreview from "../assets/chart_preview.jpg";

interface LandingPageProps {
  onLoginSuccess: (username: string, role: "admin" | "user") => void;
}

type ViewState = "landing" | "signin" | "signup";

const countryDialCodes: Record<string, string> = {
  "IL": "+972",
  "US": "+1",
  "CA": "+1",
  "GB": "+44",
  "AU": "+61",
  "DE": "+49",
  "FR": "+33",
  "IT": "+39",
  "ES": "+34",
  "RU": "+7",
  "IN": "+91",
  "CN": "+86",
  "JP": "+81",
  "BR": "+55",
  "ZA": "+27",
  "SG": "+65",
  "AE": "+971",
  "UA": "+380",
  "PL": "+48",
  "NL": "+31",
  "BE": "+32",
  "CH": "+41",
  "SE": "+46",
  "NO": "+47",
  "FI": "+358",
  "DK": "+45",
  "IE": "+353",
  "NZ": "+64",
  "MX": "+52",
  "AR": "+54",
  "CL": "+56",
  "CO": "+57",
  "TR": "+90",
  "SA": "+966",
  "CY": "+357",
  "GR": "+30",
  "PT": "+351"
};


export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [view, setView] = useState<ViewState>("landing");

  // Form states
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
  const [generatedVerificationCode, setGeneratedVerificationCode] = useState("");
  const [verificationInput, setVerificationInput] = useState("");

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
      const userObj = users.find((u) => u.username === cleanUser);
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

        const secureSession = await establishSupabaseAuthSession(userObj, cleanPass);
        if (!secureSession.success) {
          setErrorMsg(secureSession.error || "Secure Supabase Auth session failed.");
          setLoading(false);
          return;
        }

        await dbAddAuditLog("LOGIN", `User ${cleanUser} logged in from landing page.`);
        onLoginSuccess(cleanUser, userObj.role);
      } else {
        // Fallback for special black_terminal_admin case if not in DB yet
        const isUserAdmin = cleanUser === BLACK_TERMINAL_ADMIN_USERNAME;
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
          email: isUserAdmin ? BLACK_TERMINAL_ADMIN_EMAIL : "imported@blackterminal.com",
          role: (isUserAdmin ? "admin" : "user") as any,
          status: "online" as const,
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          allowedIndicators: isUserAdmin ? adminAllowed : defaultAllowed,
          activeIndicators: []
        };
        await dbRegisterUser(newUser, cleanPass);
        const secureSession = await establishSupabaseAuthSession(newUser, cleanPass);
        if (!secureSession.success) {
          setErrorMsg(secureSession.error || "Secure Supabase Auth session failed.");
          setLoading(false);
          return;
        }
        onLoginSuccess(cleanUser, newUser.role);
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
    const cleanEmail = email.trim();
    const cleanPass = password.trim();

    if (signUpStep === 1) {
      if (!cleanUser || !cleanEmail || !cleanPass || !confirmPassword.trim()) {
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

      // Send Verification Email
      setLoading(true);
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      setGeneratedVerificationCode(code);

      try {
        const mailRes = await sendVerificationEmail(cleanEmail, cleanUser, code);
        setLoading(false);
        if (mailRes.success) {
          setSignUpStep(3);
          setSuccessMsg(`Verification code sent to ${cleanEmail}`);
        } else {
          setErrorMsg(mailRes.error || "Failed to send verification email. Verify your address or Resend setup.");
        }
      } catch (err: any) {
        setLoading(false);
        setErrorMsg(err.message || "Email dispatch failed");
      }
      return;
    }

    if (signUpStep === 3) {
      if (verificationInput.trim() !== generatedVerificationCode) {
        setErrorMsg("Invalid verification code. Please check your email.");
        return;
      }

      setLoading(true);
      try {
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
          role: (cleanUser === BLACK_TERMINAL_ADMIN_USERNAME ? "admin" : "user") as any,
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
          emailVerified: true
        };

        const regResult = await dbRegisterUser(newUser, cleanPass);
        if (!regResult.success) {
          setErrorMsg(regResult.error || "Registration failed. Try again.");
          setLoading(false);
          return;
        }

        await dbAddAuditLog("CREATE", `New secure account registered: ${cleanUser} (${cleanEmail})`);
        await dbAddAuditLog("LOGIN", `User ${cleanUser} logged in automatically.`);
        const secureSession = await establishSupabaseAuthSession(newUser, cleanPass);
        if (!secureSession.success) {
          setErrorMsg(secureSession.error || "Secure Supabase Auth session failed.");
          setLoading(false);
          return;
        }

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
    setEmail("");
    setPassword("");
    setView("signin");
  };

  const handleOpenSignUp = () => {
    setErrorMsg("");
    setUsername("");
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
                     <label className="login-label">Identity (Username)</label>
                     <input
                       className="login-input"
                       type="text"
                       value={username}
                       placeholder="USERNAME"
                       onChange={(e) => setUsername(e.target.value)}
                       disabled={loading}
                       autoComplete="off"
                       required
                     />
                   </div>
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
                       required
                     />
                   </div>
                   <button className="login-submit-btn" type="submit" disabled={loading}>
                     {loading ? "Establishing handshake..." : "Link Terminal"}
                   </button>
                 </>
               )}

               {/* SIGN UP STEP 1: CREDENTIALS */}
               {!isSignIn && signUpStep === 1 && (
                 <>
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
                     <span style={{ fontSize: '9px', color: 'var(--dim)', marginTop: '4px', display: 'block' }}>
                       Only Google, Proton, Outlook, Hotmail, iCloud, Yahoo addresses accepted.
                     </span>
                   </div>
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
                   <div className="login-field">
                     <label className="login-label">Confirm Password</label>
                     <input
                       className="login-input"
                       type="password"
                       value={confirmPassword}
                       placeholder="CONFIRM PASSWORD"
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
                         <option value="+972">🇮🇱 +972</option>
                         <option value="+1">🇺🇸 +1</option>
                         <option value="+44">🇬🇧 +44</option>
                         <option value="+49">🇩🇪 +49</option>
                         <option value="+33">🇫🇷 +33</option>
                         <option value="+971">🇦🇪 +971</option>
                         <option value="+39">🇮🇹 +39</option>
                         <option value="+34">🇪🇸 +34</option>
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
                     Security protocol initiated. Enter the 6-digit cryptographic verification code sent to your secure email to authorize registration.
                   </div>
                   <div className="login-field">
                     <label className="login-label">Verification Code</label>
                     <input
                       className="login-input"
                       style={{ letterSpacing: '6px', textAlign: 'center', fontSize: '18px', fontWeight: 'bold' }}
                       type="text"
                       maxLength={6}
                       value={verificationInput}
                       placeholder="XXXXXX"
                       onChange={(e) => setVerificationInput(e.target.value.replace(/\D/g, ''))}
                       disabled={loading}
                       autoComplete="off"
                     />
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
                       {loading ? "Completing handshake..." : "Verify & Complete Signup"}
                     </button>
                   </div>
                 </>
               )}
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
                  borderColor: "rgba(255,0,0,0.25)",
                  color: "var(--strong)",
                  background: "rgba(255,0,0,0.05)",
                  height: "36px",
                  borderRadius: "3px",
                  transition: "all 0.2s"
                }}
                disabled
              >
                <Chrome size={14} style={{ color: "#ff0000" }} />
                <span style={{ fontWeight: 600, fontSize: "11px" }}>Google Single-Sign On</span>
                <span className="premium-badge" style={{ background: "rgba(255,0,0,0.1)", border: "1px solid rgba(255,0,0,0.3)", color: "#ff0000", fontSize: "8px", padding: "2px 6px", borderRadius: "2px", fontWeight: 800 }}>COMING SOON</span>
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
      <section className="hero-section" style={{ position: "relative" }}>
        <div className="CRT-glitch-line" />
        <span className="hero-badge">Cybernetic Release v1.0.7-alpha</span>
        <h1 className="hero-title">
          The Ultimate Quantum <br />
          <span>Crypto Trading Terminal</span>
        </h1>
        <p className="hero-desc">
          Institutional grade execution desk designed for top level traders, hedge funds and large investment firms.
        </p>
        <div className="hero-ctas">
          <button className="btn-primary" onClick={handleOpenSignUp}>Start Trading Now</button>
          <button className="btn-secondary" onClick={handleOpenSignIn}>Open Live Demo</button>
        </div>

        <div className="hero-telemetry" style={{ display: "flex", gap: "16px", marginTop: "40px", flexWrap: "wrap", justifyContent: "center" }}>
          <div className="login-stat-item" style={{ minWidth: "130px", alignItems: "center" }}>
            <span className="login-stat-lbl">SYSTEM LATENCY</span>
            <span className="login-stat-val up">0.82ms</span>
          </div>
          <div className="login-stat-item" style={{ minWidth: "130px", alignItems: "center" }}>
            <span className="login-stat-lbl">24H VOLUME</span>
            <span className="login-stat-val">$18.73B</span>
          </div>
          <div className="login-stat-item" style={{ minWidth: "130px", alignItems: "center" }}>
            <span className="login-stat-lbl">ACTIVE NODES</span>
            <span className="login-stat-val up">1,402</span>
          </div>
          <div className="login-stat-item" style={{ minWidth: "130px", alignItems: "center" }}>
            <span className="login-stat-lbl">UPTIME</span>
            <span className="login-stat-val">99.999%</span>
          </div>
        </div>
      </section>

      {/* Image Previews Section */}
      <section id="preview" className="preview-section" style={{ padding: "80px 40px", maxWidth: "1200px", margin: "0 auto", textAlign: "center" }}>
        <div className="section-header" style={{ marginBottom: "60px" }}>
          <h2 className="section-title">Institutional Interface Viewports</h2>
          <p className="section-desc">Sleek high-density telemetry dashboards optimized for multi-monitor desktop environments.</p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "60px" }}>
          {/* Mockup 1 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", alignItems: "center" }}>
            <div style={{ border: "1px solid rgba(255,0,0,0.15)", borderRadius: "6px", overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.6), 0 0 20px rgba(255,0,0,0.05)" }}>
              <img src={terminalMockup} alt="Black Terminal Interface Mockup" style={{ display: "block", width: "100%", maxWidth: "960px", height: "auto" }} />
            </div>
            <div style={{ maxWidth: "600px" }}>
              <h3 style={{ fontFamily: "Georgia, serif", fontSize: "20px", color: "var(--strong)", marginBottom: "8px" }}>Quantitative Order Book Desk</h3>
              <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: "1.5" }}>
                Cross-market execution interface featuring microsecond tick resolution, real-time volume profiles, and order book depth analytics.
              </p>
            </div>
          </div>

          {/* Mockup 2 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", alignItems: "center" }}>
            <div style={{ border: "1px solid rgba(255,0,0,0.15)", borderRadius: "6px", overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.6), 0 0 20px rgba(255,0,0,0.05)" }}>
              <img src={chartPreview} alt="Black Terminal Holographic Chart Projection" style={{ display: "block", width: "100%", maxWidth: "960px", height: "auto" }} />
            </div>
            <div style={{ maxWidth: "600px" }}>
              <h3 style={{ fontFamily: "Georgia, serif", fontSize: "20px", color: "var(--strong)", marginBottom: "8px" }}>Real-Time Liquidity Heatmap Visualizer</h3>
              <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: "1.5" }}>
                High-performance WebGL charting engine plotting order-book depth, liquidation clusters, and historical volume profiles.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Expanded Features Section */}
      <section id="features" className="features-section">
        <div className="section-header">
          <h2 className="section-title">Institutional-Grade Capabilities</h2>
          <p className="section-desc">Engineered for sub-millisecond execution pipelines, sandboxed execution, and decentralized data nodes.</p>
        </div>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon"><Activity size={24} /></div>
            <h3 className="feature-name">High-Throughput WebGL Engine</h3>
            <p className="feature-text">
              Hardware-accelerated rendering capable of processing millions of data points at 120 FPS, optimized for multi-monitor workstations.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Code2 size={24} /></div>
            <h3 className="feature-name">Strategy Simulation Sandbox</h3>
            <p className="feature-text">
              Develop, compile, and backtest custom strategies using sandboxed Python environments with native low-latency data feeds.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Shield size={24} /></div>
            <h3 className="feature-name">Military-Grade Security Protocol</h3>
            <p className="feature-text">
              Client-side API key management. Handshakes are locally signed using advanced cryptography and routed directly to institutional endpoints.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Cpu size={24} /></div>
            <h3 className="feature-name">Algorithmic Optimization Suite</h3>
            <p className="feature-text">
              Execute robust historical backtests with walk-forward diagnostic matrices, optimizer grids, and institutional risk metrics.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><TrendingUp size={24} /></div>
            <h3 className="feature-name">Order Flow & Liquidity Intelligence</h3>
            <p className="feature-text">
              Granular Level 2 order-book tracking and market maker activity analytics with real-time institutional liquidity delta alerts.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon"><Layers size={24} /></div>
            <h3 className="feature-name">Fault-Tolerant Redundant Infrastructure</h3>
            <p className="feature-text">
              Dynamically routed failovers utilizing high-availability REST backup arrays to prevent execution disruptions or connection loss.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="pricing-section">
        <div className="section-header">
          <h2 className="section-title">Flexible Deployment Licensing</h2>
          <p className="section-desc">Tailored operational environments designed for individual quantitative researchers, hedge funds, and enterprises.</p>
        </div>

        <div className="pricing-grid">
          <div className="pricing-card">
            <div className="plan-header">
              <span className="plan-name">Quantum Sandbox</span>
              <div className="plan-price">
                <span className="price-amount">$0</span>
                <span className="price-period">/ forever</span>
              </div>
              <p className="plan-desc">Complimentary tier for quantitative research, strategy validation, and basic API evaluation.</p>
            </div>
            <ul className="plan-features">
              <li><Check size={16} /> Standard Charting Environment</li>
              <li><Check size={16} /> Real-Time Exchange Data Stream</li>
              <li><Check size={16} /> 2 Active Sandbox Strategy Slots</li>
              <li style={{ color: "var(--dim)" }}><X size={16} style={{ color: "var(--red)" }} /> Restricted Order-Book Heatmaps</li>
            </ul>
            <button className="btn-plan" onClick={handleOpenSignUp}>Register Free</button>
          </div>

          <div className="pricing-card popular">
            <span className="popular-badge">Most Popular</span>
            <div className="plan-header">
              <span className="plan-name">Professional Terminal</span>
              <div className="plan-price">
                <span className="price-amount">$49</span>
                <span className="price-period">/ month</span>
              </div>
              <p className="plan-desc">Full access to multi-exchange execution desks, backtest environments, and advanced heatmaps.</p>
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
              <span className="plan-name" style={{ color: "var(--green)" }}>Enterprise Execution Suite</span>
              <div className="plan-price">
                <span className="price-amount">$199</span>
                <span className="price-period">/ month</span>
              </div>
              <p className="plan-desc">Dedicated cloud infrastructure, sub-millisecond execution arrays, and custom compliance frameworks.</p>
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
      {renderAuthModal()}
    </div>
  );
}
