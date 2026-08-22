import { RotateCcw, WalletCards } from "lucide-react";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";
import { NumberField } from "./ExecutionStep";

export function PaperStep({ draft, onChange }: { draft: StrategyWizardDraft; onChange: (draft: StrategyWizardDraft) => void }) {
  const paper = draft.definition.paper || {};
  const patch = (key: string, value: unknown) => onChange({ ...draft, definition: { ...draft.definition, paper: { ...paper, [key]: value } } });
  const equity = Number(paper.demoEquity || 10_000);
  const policy = draft.paperPolicy;
  const allocated = policy.strategyAllocationMode === "FIXED_USDT" ? Math.min(equity, policy.strategyAllocationValue) : equity * policy.strategyAllocationValue / 100;
  const entry = policy.tradeAmountMode === "FIXED_USDT" ? policy.tradeAmountValue : allocated * policy.tradeAmountValue / 100;
  return <div className="strategy-wizard-section"><header><span>08</span><div><h2>Paper account</h2><p>Paper Trading is the default target and runs securely on Black Cloud after an explicit start.</p></div></header>
    <div className="paper-account-hero"><WalletCards size={24} /><div><strong>PAPER TARGET</strong><span>Separate virtual account · {draft.definition.marketType} · Not connected to real funds</span></div><b>ACTIVE BY DEFAULT</b></div>
    <div className="strategy-form-grid"><NumberField label="DEMO EQUITY" value={equity} suffix="USDT" min={100} step={100} onChange={(value) => patch("demoEquity", value)} /><NumberField label="FEES" value={Number(paper.feesBps || 6)} suffix="BPS" min={0} step={0.1} onChange={(value) => patch("feesBps", value)} /><NumberField label="SLIPPAGE" value={Number(paper.slippageBps || 5)} suffix="BPS" min={0} step={0.1} onChange={(value) => patch("slippageBps", value)} />{draft.definition.marketType === "FUTURES" ? <label className="wizard-toggle"><span><strong>MODEL FUNDING</strong><em>Apply periodic funding to Paper positions.</em></span><input type="checkbox" checked={paper.modelFunding !== false} onChange={(event) => patch("modelFunding", event.target.checked)} /></label> : null}</div>
    <div className="capital-preview"><span>FINAL PAPER SIZING</span><div><b>Demo equity</b><strong>{money(equity)}</strong></div><div><b>Strategy allocation</b><strong>{policy.strategyAllocationValue}{policy.strategyAllocationMode === "FIXED_USDT" ? " USDT" : "%"}</strong></div><div><b>Allocated capital</b><strong>{money(allocated)}</strong></div><div><b>Per-trade capital</b><strong>{money(entry)}</strong></div><div><b>Estimated notional</b><strong>{money(entry * (policy.requestedLeverage || 1))}</strong></div></div>
    <div className="paper-actions-preview"><button type="button" disabled><RotateCcw size={13} /> RESET AFTER PUBLISHING</button><span>Top-up, reset and runtime controls become available in the Paper cockpit.</span></div>
  </div>;
}
function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
