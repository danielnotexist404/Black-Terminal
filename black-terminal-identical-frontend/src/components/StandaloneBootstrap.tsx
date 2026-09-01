import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, HardDrive, LockKeyhole, Network, ShieldCheck } from "lucide-react";
import App from "../App";
import brandIcon from "../assets/brand-icon.png";
import {
  initializeLocalRuntime,
  isTauriRuntime,
  readLocalRuntimeStatus,
  sendLocalRuntimeHeartbeat,
  type LocalRuntimeStatus,
} from "../core/local-runtime/localRuntimeClient";
import { hydrateLocalPreferenceCache } from "../core/local-runtime/localDocumentStore";
import { restoreLocalBrokerAccounts } from "../core/local-runtime/localBrokerStore";
import { hydrateLocalUserScripts } from "../core/local-runtime/localUserScriptStore";
import { startLocalP2p } from "../core/local-runtime/localP2pClient";
import { startLocalStrategyCoordinator } from "../core/local-runtime/localStrategyCoordinator";
import { startLocalInvestmentGroupP2pCoordinator } from "../core/local-runtime/localInvestmentGroupP2pCoordinator";
import { startLocalP2pOutbox } from "../core/local-runtime/localP2pOutbox";
import { startLocalAlertDeliveryOutbox } from "../core/local-runtime/localAlertDeliveryOutbox";
import { hydrateProfessionalNetworkStore } from "../modules/profile/professionalNetworkStore";
import { restoreActiveLocalQalcRuntime } from "../modules/strategy-lab/qalc/localQalcRuntime";
import "../styles/standalone-bootstrap.css";

const steps = ["Welcome", "Runtime", "Identity", "Ready"] as const;

export function StandaloneBootstrap() {
  const setupPreview = window.location.hostname === "127.0.0.1"
    && new URLSearchParams(window.location.search).get("standaloneSetupPreview") === "1";
  const [status, setStatus] = useState<LocalRuntimeStatus | null | undefined>(isTauriRuntime() ? undefined : null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isTauriRuntime()) return;
    readLocalRuntimeStatus().then(async (nextStatus) => {
      await hydrateLocalPreferenceCache();
      await hydrateProfessionalNetworkStore();
      if (nextStatus?.initialized && nextStatus.config?.mode === "LOCAL_ONLY") {
        await hydrateLocalUserScripts(nextStatus.config.profile.username);
        await restoreLocalBrokerAccounts();
        await restoreActiveLocalQalcRuntime();
      }
      if (nextStatus?.initialized && nextStatus.config?.p2pEnabled) {
        await startLocalP2p().catch((cause) => console.error("Local P2P startup failed", cause));
      }
      setStatus(nextStatus);
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
    });
  }, []);

  useEffect(() => {
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<LocalRuntimeStatus>).detail;
      if (detail?.initialized) setStatus(detail);
    };
    window.addEventListener("bt-local-runtime-updated", updated);
    return () => window.removeEventListener("bt-local-runtime-updated", updated);
  }, []);

  useEffect(() => {
    if (!status?.initialized || status.config?.mode !== "LOCAL_ONLY") return;
    const stopStrategy = startLocalStrategyCoordinator();
    const stopGroups = status.config.p2pEnabled ? startLocalInvestmentGroupP2pCoordinator() : () => undefined;
    const stopOutbox = status.config.p2pEnabled ? startLocalP2pOutbox() : () => undefined;
    const stopAlerts = startLocalAlertDeliveryOutbox();
    return () => { stopAlerts(); stopOutbox(); stopGroups(); stopStrategy(); };
  }, [status]);

  useEffect(() => {
    if (!status?.initialized || status.config?.mode !== "LOCAL_ONLY") return;
    let stopped = false;
    let releaseWebLock: (() => void) | null = null;
    if (status.config.backgroundExecution && "locks" in navigator) {
      void navigator.locks.request("black-terminal-local-strategy-host", { mode: "exclusive" }, async () => {
        await new Promise<void>((resolve) => { releaseWebLock = resolve; });
      });
    }
    const heartbeat = () => void sendLocalRuntimeHeartbeat()
      .then((next) => { if (!stopped && next) setStatus(next); })
      .catch((cause) => console.error("Local runtime heartbeat failed", cause));
    heartbeat();
    const timer = window.setInterval(heartbeat, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      releaseWebLock?.();
    };
  }, [status?.initialized, status?.config?.mode, status?.config?.backgroundExecution]);

  if (setupPreview) return <SetupWizard platformStatus={previewPlatformStatus()} initialError="" onInitialized={setStatus} />;
  if (status === undefined) return <BootSplash detail="Verifying the encrypted local runtime…" />;
  if (!isTauriRuntime() || status?.initialized) return <App />;
  return <SetupWizard platformStatus={status} initialError={error} onInitialized={setStatus} />;
}

function previewPlatformStatus(): LocalRuntimeStatus {
  return {
    available: true,
    initialized: false,
    vaultReady: true,
    config: null,
    platform: "linux",
    persistentBackgroundSupported: true,
    backgroundLimitation: null,
    webviewHeartbeatAt: null,
    executionWorkerHeartbeatAt: null,
    backgroundHealth: "NOT_CONFIGURED",
  };
}

function BootSplash({ detail }: { detail: string }) {
  return <main className="standalone-boot-shell">
    <section className="standalone-boot-card is-splash">
      <img src={brandIcon} alt="Black Terminal" />
      <span>BLACK TERMINAL</span>
      <h1>LOCAL CORE</h1>
      <p>{detail}</p>
      <div className="standalone-progress"><i /></div>
    </section>
  </main>;
}

function SetupWizard({ platformStatus, initialError, onInitialized }: {
  platformStatus: LocalRuntimeStatus | null;
  initialError: string;
  onInitialized: (status: LocalRuntimeStatus) => void;
}) {
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [backgroundExecution, setBackgroundExecution] = useState(platformStatus?.persistentBackgroundSupported !== false);
  const [p2pEnabled, setP2pEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const mobileLimited = platformStatus?.persistentBackgroundSupported === false;
  const canContinue = step !== 2 || (email.trim().includes("@") && displayName.trim().length >= 2);
  const platformName = useMemo(() => (platformStatus?.platform || "desktop").replace("macos", "macOS").replace("ios", "iOS"), [platformStatus?.platform]);

  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      const initialized = await initializeLocalRuntime({
        mode: "LOCAL_ONLY",
        backgroundExecution: mobileLimited ? false : backgroundExecution,
        p2pEnabled,
        email,
        displayName,
      });
      await hydrateLocalPreferenceCache();
      await hydrateProfessionalNetworkStore();
      await hydrateLocalUserScripts(initialized.config?.profile.username);
      await restoreLocalBrokerAccounts();
      await restoreActiveLocalQalcRuntime();
      if (initialized.config?.p2pEnabled) {
        await startLocalP2p().catch((cause) => console.error("Local P2P startup failed", cause));
      }
      onInitialized(initialized);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <main className="standalone-boot-shell">
    <section className="standalone-setup">
      <aside>
        <img src={brandIcon} alt="Black Terminal pyramid and red arrow" />
        <span>BLACK TERMINAL</span>
        <strong>STANDALONE CORE</strong>
        <p>Your workstation becomes the private execution host while Black Terminal is running.</p>
        <ol>{steps.map((label, index) => <li key={label} className={index === step ? "active" : index < step ? "done" : ""}><b>{index < step ? <Check size={12} /> : index + 1}</b><span>{label}</span></li>)}</ol>
        <small>LOCAL-FIRST · ENCRYPTED · OWNER CONTROLLED</small>
      </aside>
      <div className="standalone-setup-body">
        <header><span>SETUP {String(step + 1).padStart(2, "0")}</span><em>{platformName}</em></header>
        {step === 0 && <section>
          <span className="standalone-kicker">WELCOME TO BLACK TERMINAL</span>
          <h1>Institutional infrastructure.<br />On your machine.</h1>
          <p>This installer creates an isolated local runtime, an operating-system protected credential vault, and a permanent cryptographic device identity.</p>
          <div className="standalone-feature-grid">
            <article><HardDrive /><strong>Local execution</strong><span>Strategies and alerts continue when the chart window is hidden.</span></article>
            <article><LockKeyhole /><strong>OS credential vault</strong><span>Broker secrets never enter localStorage or return to the webview.</span></article>
            <article><Network /><strong>P2P identity</strong><span>A stable peer address for signed direct connections and encrypted sharing.</span></article>
            <article><ShieldCheck /><strong>Fail-closed controls</strong><span>No broker action is accepted without runtime, mandate, risk, and venue checks.</span></article>
          </div>
        </section>}
        {step === 1 && <section>
          <span className="standalone-kicker">RUNTIME POLICY</span>
          <h1>Choose what stays active.</h1>
          <label className="standalone-choice selected"><input type="radio" checked readOnly /><div><strong>Local-only core</strong><span>No VPS is required for terminal state, alerts, strategies, broker execution, or workspace persistence.</span></div></label>
          <label className={`standalone-choice ${backgroundExecution ? "selected" : ""} ${mobileLimited ? "disabled" : ""}`}><input type="checkbox" checked={backgroundExecution && !mobileLimited} disabled={mobileLimited} onChange={(event) => setBackgroundExecution(event.target.checked)} /><div><strong>Run after the window closes</strong><span>{mobileLimited ? platformStatus?.backgroundLimitation : "Closing the window hides it. Quit from the tray menu to stop the local host."}</span></div></label>
          <label className={`standalone-choice ${p2pEnabled ? "selected" : ""}`}><input type="checkbox" checked={p2pEnabled} onChange={(event) => setP2pEnabled(event.target.checked)} /><div><strong>Encrypted P2P identity</strong><span>Prepare direct peer addressing. Public discovery and relaying remain separately permissioned.</span></div></label>
        </section>}
        {step === 2 && <section>
          <span className="standalone-kicker">LOCAL OWNER</span>
          <h1>Name this installation.</h1>
          <p>This profile is stored locally. Importing an existing VPS account is a separate encrypted migration after setup.</p>
          <label className="standalone-input"><span>Display name</span><input autoFocus value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="Black Triangle Group" /></label>
          <label className="standalone-input"><span>Owner email</span><input type="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} placeholder="owner@example.com" /></label>
        </section>}
        {step === 3 && <section>
          <span className="standalone-kicker">READY TO INITIALIZE</span>
          <h1>One device. One identity.</h1>
          <div className="standalone-summary">
            <div><span>Mode</span><strong>LOCAL ONLY</strong></div>
            <div><span>Owner</span><strong>{displayName.trim()}</strong></div>
            <div><span>Background</span><strong>{backgroundExecution && !mobileLimited ? "TRAY RUNTIME" : "APP FOREGROUND"}</strong></div>
            <div><span>P2P</span><strong>{p2pEnabled ? "IDENTITY ENABLED" : "DISABLED"}</strong></div>
          </div>
          <p className="standalone-warning">Initialization will fail if the operating-system credential vault is locked or unavailable. Black Terminal will never downgrade to plaintext secret storage.</p>
        </section>}
        {error && <div className="standalone-error" role="alert">{error}</div>}
        <footer>
          <button type="button" disabled={step === 0 || busy} onClick={() => { setError(""); setStep((current) => current - 1); }}><ChevronLeft size={15} /> Back</button>
          {step < steps.length - 1
            ? <button className="primary" type="button" disabled={!canContinue || busy} onClick={() => { setError(""); setStep((current) => current + 1); }}>Continue <ChevronRight size={15} /></button>
            : <button className="primary" type="button" disabled={busy} onClick={() => void finish()}>{busy ? "Securing local core…" : "Initialize Black Terminal"} <ShieldCheck size={15} /></button>}
        </footer>
      </div>
    </section>
  </main>;
}
