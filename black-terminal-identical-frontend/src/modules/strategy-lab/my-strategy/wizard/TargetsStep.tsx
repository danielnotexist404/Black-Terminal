import { CheckCircle2, CloudCog, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { StrategyTargetBinding } from "../../automation/strategyAutomation.types";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";

type DemoConnection = { id: string; label: string; state: string };

export function TargetsStep({ draft, bindings, demoConnection, busy, onConnectDemo, onRefreshDemo }: {
  draft: StrategyWizardDraft;
  bindings: StrategyTargetBinding[];
  demoConnection?: DemoConnection | null;
  busy: boolean;
  onConnectDemo: (credentials: { accountName: string; apiKey: string; apiSecret: string }) => Promise<void>;
  onRefreshDemo: () => Promise<void>;
}) {
  const [accountName, setAccountName] = useState("Black Core Demo");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const demoBinding = bindings.find((binding) => binding.targetType === "BROKER_ACCOUNT");
  const connect = async () => {
    if (!accountName.trim() || !apiKey.trim() || !apiSecret.trim()) return;
    try {
      await onConnectDemo({ accountName: accountName.trim(), apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
    } finally {
      setApiKey("");
      setApiSecret("");
    }
  };
  return <div className="strategy-wizard-section"><header><span>09</span><div><h2>Bybit Demo account</h2><p>Simulated funds on Bybit Demo execution, using mainnet public market data. Testnet and real-funds automation are not part of this path.</p></div></header>
    <div className="target-boundary demo-boundary"><div><ShieldCheck size={15} /><strong>DEMO EXECUTION ONLY</strong><span>Orders route only to api-demo.bybit.com. Withdrawals and transfers are prohibited.</span></div><div><CloudCog size={15} /><strong>BLACK CLOUD PERSISTENT RUNTIME</strong><span>Closed-candle signals continue on the VPS after the browser closes.</span></div></div>
    {demoConnection ? <section className="strategy-demo-connected"><CheckCircle2 size={18} /><div><strong>{demoConnection.label}</strong><span>{demoConnection.state} · SIMULATED FUNDS · MAINNET PUBLIC DATA</span></div><button type="button" disabled={busy} onClick={() => void onRefreshDemo()}><RefreshCw size={13} /> REFRESH READINESS</button></section> : <section className="strategy-demo-connect"><div className="strategy-demo-connect-head"><KeyRound size={15} /><div><strong>CONNECT BYBIT DEMO TRADING API</strong><span>Create the key inside Bybit Mainnet → Demo Trading. Enable read and trade only.</span></div></div><label><span>ACCOUNT NAME</span><input value={accountName} maxLength={80} autoComplete="off" onChange={(event) => setAccountName(event.target.value)} /></label><label><span>DEMO API KEY</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} /></label><label><span>DEMO API SECRET</span><input value={apiSecret} type="password" autoComplete="new-password" onChange={(event) => setApiSecret(event.target.value)} /></label><button type="button" className="primary" disabled={busy || !accountName.trim() || !apiKey.trim() || !apiSecret.trim()} onClick={() => void connect()}>{busy ? "VERIFYING DEMO ACCOUNT…" : "CONNECT & VERIFY DEMO ACCOUNT"}</button></section>}
    <div className="review-summary-grid"><div><span>STRATEGY MARKET</span><strong>{draft.definition.symbol} · {draft.definition.timeframe.toUpperCase()}</strong></div><div><span>ALLOCATION</span><strong>{draft.paperPolicy.strategyAllocationValue}{draft.paperPolicy.strategyAllocationMode === "FIXED_USDT" ? " USDT" : "%"}</strong></div><div><span>PER TRADE</span><strong>{draft.paperPolicy.tradeAmountValue}{draft.paperPolicy.tradeAmountMode === "FIXED_USDT" ? " USDT" : "%"}</strong></div><div><span>TARGET STATE</span><strong>{demoBinding?.status || demoConnection?.state || "NOT CONNECTED"}</strong></div></div>
    <p className="target-matrix-note">Activation requires authenticated credentials, a synchronized private stream, deterministic order identity, a non-zero risk policy and an immutable strategy version. API secrets are cleared from this form immediately after submission and never returned by the server.</p>
  </div>;
}
