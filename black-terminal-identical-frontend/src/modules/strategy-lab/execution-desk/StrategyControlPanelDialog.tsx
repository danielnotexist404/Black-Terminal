import { AlertTriangle, Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CompiledScriptInput, ScriptInputValue } from "../../../components/ScriptCompiler";
import type { StrategyControlPanel } from "../automation/strategyAutomation.types";

type Tab = "inputs" | "properties" | "style" | "visibility";

export function StrategyControlPanelDialog({
  name,
  accountLabel,
  initial,
  initialSettings = {},
  nativeInputs = [],
  sourceKey = "default",
  authoritativeEquity,
  authoritativeAvailableBalance,
  authoritativeEquityTimestamp,
  authoritativeFreshness,
  authoritativeDestination = false,
  embedded = false,
  busy,
  onCancel,
  onApply,
}: {
  name: string;
  accountLabel: string;
  initial: StrategyControlPanel;
  initialSettings?: Record<string, unknown>;
  nativeInputs?: CompiledScriptInput[];
  sourceKey?: string;
  authoritativeEquity?: number;
  authoritativeAvailableBalance?: number;
  authoritativeEquityTimestamp?: number;
  authoritativeFreshness?: string;
  authoritativeDestination?: boolean;
  embedded?: boolean;
  busy: boolean;
  onCancel: () => void;
  onApply: (value: StrategyControlPanel, nativeSettings?: Record<string, unknown>) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("inputs");
  const [value, setValue] = useState(() => structuredClone(initial));
  const [settings, setSettings] = useState<Record<string, unknown>>(() => initialNativeSettings(nativeInputs, initialSettings));
  const [error, setError] = useState<string>();
  const dirty = useRef(false);
  // Cockpit snapshots refresh every few seconds and reconstruct equivalent
  // objects. Depending on object identity here reset in-progress edits on each
  // refresh, making the controls appear locked. Reset only when the persisted
  // configuration values actually change.
  const initialSignature = JSON.stringify(initial);
  const nativeSettingsSignature = JSON.stringify([nativeInputs, initialSettings]);
  const lastSourceKey = useRef(sourceKey);
  useEffect(() => {
    if (lastSourceKey.current !== sourceKey) {
      lastSourceKey.current = sourceKey;
      dirty.current = false;
      setValue(structuredClone(initial));
      setSettings(initialNativeSettings(nativeInputs, initialSettings));
      setError(undefined);
      return;
    }
    if (!dirty.current) setValue(structuredClone(initial));
  }, [initialSignature, sourceKey]);
  useEffect(() => { if (!dirty.current) setSettings(initialNativeSettings(nativeInputs, initialSettings)); }, [nativeSettingsSignature, sourceKey]);
  const markDirty = () => { dirty.current = true; };
  const patchInputs = (patch: Partial<StrategyControlPanel["inputs"]>) => { markDirty(); setValue((current) => ({ ...current, inputs: { ...current.inputs, ...patch } })); };
  const patchProperties = (patch: Partial<StrategyControlPanel["properties"]>) => { markDirty(); setValue((current) => ({ ...current, properties: { ...current.properties, ...patch } })); };
  const patchStyle = (patch: Partial<StrategyControlPanel["style"]>) => { markDirty(); setValue((current) => ({ ...current, style: { ...current.style, ...patch } })); };
  const patchVisibility = (patch: Partial<StrategyControlPanel["visibility"]>) => { markDirty(); setValue((current) => ({ ...current, visibility: { ...current.visibility, ...patch } })); };
  const reset = () => { dirty.current = false; setValue(structuredClone(initial)); setSettings(initialNativeSettings(nativeInputs, initialSettings)); setError(undefined); if (!embedded) onCancel(); };
  const submit = async () => {
    setError(undefined);
    const sizingError = validateOrderSize(value, authoritativeEquity, authoritativeAvailableBalance, authoritativeDestination, authoritativeEquityTimestamp, authoritativeFreshness);
    if (sizingError) { setError(sizingError); return; }
    const submitted = authoritativeDestination && Number.isFinite(authoritativeEquity) && Number(authoritativeEquity) > 0
      ? { ...value, properties: { ...value.properties, initialCapital: Number(authoritativeEquity), currency: "USDT" as const } }
      : value;
    const submittedSettings = nativeInputs.length ? structuredClone(settings) : undefined;
    try {
      await onApply(submitted, submittedSettings);
      // Keep the exact successfully submitted values in the form. React may not
      // have committed the parent's refreshed VPS snapshot yet when onApply
      // resolves; restoring `initial` here used to visibly roll every field back
      // to the pre-save values.
      dirty.current = false;
      setValue(structuredClone(submitted));
      if (submittedSettings) setSettings(submittedSettings);
    }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Strategy configuration could not be saved."); }
  };
  const panel = <section className={`strategy-control-dialog${embedded ? " embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={`${name} settings`}>
      <header><div><span>STRATEGY SETTINGS</span><h2>{name}</h2><em>{nativeInputs.length ? `${nativeInputs.length} SCRIPT-NATIVE INPUTS` : "CERTIFIED NATIVE CONTROL CONTRACT"}</em></div>{!embedded ? <button type="button" aria-label="Close strategy settings" disabled={busy} onClick={onCancel}><X size={18} /></button> : null}</header>
      <nav aria-label="Strategy settings sections">{(["inputs", "properties", "style", "visibility"] as Tab[]).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item.toUpperCase()}</button>)}</nav>
      <div key={tab} className="strategy-control-scroll" tabIndex={0} aria-label={`${tab} strategy settings controls`}>
        {tab === "inputs" ? nativeInputs.length ? <NativeInputs inputs={nativeInputs} settings={settings} onChange={(key, next) => { markDirty(); setSettings((current) => ({ ...current, [key]: next })); }} /> : <Inputs value={value} patch={patchInputs} /> : null}
        {tab === "properties" ? <Properties value={value} patch={patchProperties} accountLabel={accountLabel} authoritativeEquity={authoritativeEquity} authoritativeAvailableBalance={authoritativeAvailableBalance} authoritativeEquityTimestamp={authoritativeEquityTimestamp} authoritativeFreshness={authoritativeFreshness} authoritativeDestination={authoritativeDestination} /> : null}
        {tab === "style" ? <Style value={value} patch={patchStyle} /> : null}
        {tab === "visibility" ? <Visibility value={value} patch={patchVisibility} /> : null}
      </div>
      {error ? <div className="strategy-control-error"><AlertTriangle size={13} />{error}</div> : null}
      <footer><select aria-label="Strategy defaults"><option>Current saved values</option><option>{nativeInputs.length ? "Script defaults" : "SuperATR Pine defaults"}</option></select><div><button type="button" disabled={busy} onClick={reset}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Applying…" : <><Check size={13} />Save</>}</button></div></footer>
    </section>;
  if (embedded) return <div className="strategy-settings-embedded">{panel}</div>;
  const dialog = <div className="strategy-control-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>{panel}</div>;
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

function NativeInputs({ inputs, settings, onChange }: { inputs: CompiledScriptInput[]; settings: Record<string, unknown>; onChange: (key: string, value: ScriptInputValue) => void }) {
  let group = "";
  return <div className="strategy-control-form native-inputs">{inputs.map((input) => {
    const groupChanged = input.group && input.group !== group;
    if (input.group) group = input.group;
    const current = nativeValue(input, settings[input.key]);
    return <div className="native-input-block" key={`${input.variable}:${input.key}`}>{groupChanged ? <h3>{input.group!.toUpperCase()}</h3> : null}{input.type === "bool" ? <CheckRow label={input.label} checked={Boolean(current)} onChange={(next) => onChange(input.key, next)} /> : input.options?.length ? <SelectRow label={input.label} value={String(current)} onChange={(next) => onChange(input.key, typedOption(input, next))}>{input.options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</SelectRow> : input.type === "color" ? <label className="strategy-control-row native-color"><span>{input.label}</span><input type="color" value={String(current)} onChange={(event) => onChange(input.key, event.target.value)} /></label> : input.type === "string" ? <label className="strategy-control-row"><span>{input.label}</span><input value={String(current)} onChange={(event) => onChange(input.key, event.target.value)} /></label> : <NumberRow label={input.label} value={Number(current)} min={input.min} max={input.max} step={input.step || (input.type === "int" ? 1 : 0.01)} onChange={(next) => onChange(input.key, input.type === "int" ? Math.round(next) : next)} />}{input.tooltip ? <p className="native-input-tooltip">{input.tooltip}</p> : null}</div>;
  })}</div>;
}

function initialNativeSettings(inputs: CompiledScriptInput[], settings: Record<string, unknown>) {
  return inputs.reduce<Record<string, unknown>>((output, input) => { output[input.key] = nativeValue(input, settings[input.key]); return output; }, {});
}
function nativeValue(input: CompiledScriptInput, value: unknown): ScriptInputValue { return ["number", "boolean", "string"].includes(typeof value) ? value as ScriptInputValue : input.defaultValue; }
function typedOption(input: CompiledScriptInput, value: string): ScriptInputValue { return input.options?.find((option) => String(option) === value) ?? value; }

function Inputs({ value, patch }: { value: StrategyControlPanel; patch: (value: Partial<StrategyControlPanel["inputs"]>) => void }) {
  const input = value.inputs;
  const atr = [...input.atrMultipliers] as [number, number, number, number];
  const fixed = [...input.fixedTakeProfitPercentages] as [number, number, number];
  return <div className="strategy-control-form">
    <NumberRow label="Short Period" value={input.shortPeriod} min={1} onChange={(shortPeriod) => patch({ shortPeriod })} />
    <NumberRow label="Long Period" value={input.longPeriod} min={1} onChange={(longPeriod) => patch({ longPeriod })} />
    <NumberRow label="Momentum Period" value={input.momentumPeriod} min={1} onChange={(momentumPeriod) => patch({ momentumPeriod })} />
    <NumberRow label="ATR SMA Period for Confirmation" value={input.atrConfirmationPeriod} min={1} onChange={(atrConfirmationPeriod) => patch({ atrConfirmationPeriod })} />
    <NumberRow label="Trend Strength Threshold" value={input.trendStrengthThreshold} min={0} step={0.1} onChange={(trendStrengthThreshold) => patch({ trendStrengthThreshold })} />
    <CheckRow label="Enable Multi-Step Take Profit" checked={input.multiStepTakeProfit} onChange={(multiStepTakeProfit) => patch({ multiStepTakeProfit })} />
    <NumberRow label="ATR Length for Take Profit" value={input.takeProfitAtrLength} min={1} disabled={!input.multiStepTakeProfit} onChange={(takeProfitAtrLength) => patch({ takeProfitAtrLength })} />
    {atr.map((item, index) => <NumberRow key={index} label={`ATR Multiplier for TP Level ${index + 1}`} value={item} min={0.1} step={0.1} disabled={!input.multiStepTakeProfit} onChange={(next) => { atr[index] = next; patch({ atrMultipliers: atr }); }} />)}
    {fixed.map((item, index) => <NumberRow key={index} label={`Fixed TP Level ${index + 1} (%)`} value={item} min={0.1} step={0.1} disabled={!input.multiStepTakeProfit} onChange={(next) => { fixed[index] = next; patch({ fixedTakeProfitPercentages: fixed }); }} />)}
    <NumberRow label="Percentage to Exit at Each ATR TP Level" value={input.atrExitPercent} min={0.1} max={100} disabled={!input.multiStepTakeProfit} onChange={(atrExitPercent) => patch({ atrExitPercent })} />
    <NumberRow label="Percentage to Exit at Each Fixed TP Level" value={input.fixedExitPercent} min={0.1} max={100} disabled={!input.multiStepTakeProfit} onChange={(fixedExitPercent) => patch({ fixedExitPercent })} />
  </div>;
}

function Properties({ value, patch, accountLabel, authoritativeEquity, authoritativeAvailableBalance, authoritativeEquityTimestamp, authoritativeFreshness, authoritativeDestination }: { value: StrategyControlPanel; patch: (value: Partial<StrategyControlPanel["properties"]>) => void; accountLabel: string; authoritativeEquity?: number; authoritativeAvailableBalance?: number; authoritativeEquityTimestamp?: number; authoritativeFreshness?: string; authoritativeDestination: boolean }) {
  const item = value.properties;
  const hasAuthoritativeSnapshot = authoritativeDestination
    && typeof authoritativeEquity === "number"
    && Number.isFinite(authoritativeEquity)
    && typeof authoritativeEquityTimestamp === "number"
    && Number.isFinite(authoritativeEquityTimestamp);
  const equitySynchronized = hasAuthoritativeSnapshot && authoritativeFreshness === "LIVE";
  const displayedEquity = hasAuthoritativeSnapshot ? Math.max(0, authoritativeEquity) : undefined;
  const available = authoritativeAvailableBalance !== undefined && Number.isFinite(authoritativeAvailableBalance) ? Math.max(0, authoritativeAvailableBalance) : undefined;
  const fixedUsdtLimit = !equitySynchronized || displayedEquity === undefined ? undefined : Math.min(displayedEquity, available ?? displayedEquity);
  const orderSizeMaximum = item.orderSizeMode === "PERCENT_EQUITY" ? 100 : item.orderSizeMode === "FIXED_USDT" ? fixedUsdtLimit : undefined;
  const syncLabel = authoritativeEquityTimestamp ? new Date(authoritativeEquityTimestamp).toLocaleTimeString() : "awaiting timestamp";
  return <div className="strategy-control-form properties">
    <h3>GENERAL</h3>
    <ChoiceRow label={authoritativeDestination ? "Full account equity · API" : "Initial capital"}><input className={authoritativeDestination ? "authoritative" : undefined} type="number" min="0" readOnly={authoritativeDestination} disabled={authoritativeDestination && !equitySynchronized} placeholder={authoritativeDestination && !hasAuthoritativeSnapshot ? "SYNCING" : undefined} value={authoritativeDestination ? displayedEquity ?? "" : item.initialCapital} onChange={(event) => patch({ initialCapital: numeric(event, item.initialCapital) })} /><select disabled={authoritativeDestination} value={authoritativeDestination ? "USDT" : item.currency} onChange={(event) => patch({ currency: event.target.value as typeof item.currency })}><option>USD</option><option>USDT</option></select></ChoiceRow>
    {equitySynchronized ? <p className="strategy-control-equity-source">LIVE BROKER EQUITY · {authoritativeFreshness || "SYNCED"} · {syncLabel}{available !== undefined ? ` · ${available.toLocaleString(undefined, { maximumFractionDigits: 8 })} USDT available` : ""}. The field is broker-owned and updates automatically; execution reads Bybit again when an alert fires.</p> : null}
    {authoritativeDestination && hasAuthoritativeSnapshot && !equitySynchronized ? <p className="strategy-control-equity-source unavailable"><AlertTriangle size={12} />LAST-KNOWN BROKER EQUITY · {authoritativeFreshness || "UNAVAILABLE"} · {syncLabel}. It remains visible for diagnosis, but saving live sizing is locked until reconciliation marks it LIVE.</p> : null}
    {authoritativeDestination && !hasAuthoritativeSnapshot ? <p className="strategy-control-equity-source unavailable"><AlertTriangle size={12} />BROKER EQUITY IS SYNCHRONIZING. The script default is intentionally hidden and saving live sizing is locked until the authoritative account snapshot arrives.</p> : null}
    <ChoiceRow label="Default order size"><input type="number" min="0.00000001" max={orderSizeMaximum} value={item.orderSizeValue} onChange={(event) => patch({ orderSizeValue: numeric(event, item.orderSizeValue) })} /><select value={item.orderSizeMode} onChange={(event) => patch({ orderSizeMode: event.target.value as typeof item.orderSizeMode })}><option value="PERCENT_EQUITY">% of equity</option><option value="FIXED_USDT">USDT balance</option><option value="FIXED_QUANTITY">Raw quantity</option></select></ChoiceRow>
    {fixedUsdtLimit !== undefined && item.orderSizeMode === "FIXED_USDT" ? <p className="strategy-control-field-limit">CURRENT MAXIMUM · {fixedUsdtLimit.toLocaleString(undefined, { maximumFractionDigits: 8 })} USDT</p> : null}
    <NumberRow label="Long entry leverage · per trade" value={item.longLeverage} min={1} max={1000} suffix="x" onChange={(longLeverage) => patch({ longLeverage })} />
    <NumberRow label="Short entry leverage · per trade" value={item.shortLeverage} min={1} max={1000} suffix="x" onChange={(shortLeverage) => patch({ shortLeverage })} />
    <NumberRow label="Pyramiding" value={item.pyramiding} min={1} max={100} onChange={(pyramiding) => patch({ pyramiding })} />
    <h3>DETAILIZATION AND EXECUTION</h3>
    <SelectRow label="Bar detailization" value={item.barDetailization} onChange={(barDetailization) => patch({ barDetailization: barDetailization as typeof item.barDetailization })}><option value="DEFAULT_4_TICKS">Default (4 ticks per bar)</option><option value="HIGH_LOWER_TIMEFRAME">High (lower-timeframe bars)</option><option value="CLOSED_BAR">Conservative OHLC (stop first)</option></SelectRow>
    <SelectRow label="Script execution" value={item.executionCadence} onChange={(executionCadence) => patch({ executionCadence: executionCadence as typeof item.executionCadence })}><option value="BAR_CLOSE_AND_REALTIME">On bar close, On realtime bar tick</option><option value="BAR_CLOSE">On bar close</option></SelectRow>
    <h3>BROKER EMULATOR · {accountLabel.toUpperCase()}</h3>
    <ChoiceRow label="Commission"><input type="number" min="0" step="0.01" value={item.commissionValue} onChange={(event) => patch({ commissionValue: numeric(event, item.commissionValue) })} /><select value={item.commissionMode} onChange={(event) => patch({ commissionMode: event.target.value as typeof item.commissionMode })}><option value="PERCENT">Percent</option><option value="USDT_PER_ORDER">USDT per order</option></select></ChoiceRow>
    <NumberRow label="Slippage" value={item.slippageTicks} min={0} suffix="ticks" onChange={(slippageTicks) => patch({ slippageTicks })} />
    <SelectRow label="Limit order execution" value={item.limitExecution} onChange={(limitExecution) => patch({ limitExecution: limitExecution as typeof item.limitExecution })}><option value="REQUESTED_PRICE">Requested price</option><option value="TOUCH">Price touch</option></SelectRow>
    <SelectRow label="Order execution delay" value={item.executionDelay} onChange={(executionDelay) => patch({ executionDelay: executionDelay as typeof item.executionDelay })}><option value="ONE_TICK">One tick</option><option value="NONE">None</option></SelectRow>
    <p className="strategy-control-authority">Equity/USDT sizing and side leverage are enforced server-side against this selected destination, its available balance, Bybit instrument limits, account caps, and Strategy Lab risk ceilings.</p>
  </div>;
}

function Style({ value, patch }: { value: StrategyControlPanel; patch: (value: Partial<StrategyControlPanel["style"]>) => void }) {
  const style = value.style;
  return <div className="strategy-control-form style">
    <VisualRow label="Short MA" checked={style.shortMaVisible} color={style.shortMaColor} width={style.shortMaWidth} onCheck={(shortMaVisible) => patch({ shortMaVisible })} onColor={(shortMaColor) => patch({ shortMaColor })} onWidth={(shortMaWidth) => patch({ shortMaWidth })} />
    <VisualRow label="Long MA" checked={style.longMaVisible} color={style.longMaColor} width={style.longMaWidth} onCheck={(longMaVisible) => patch({ longMaVisible })} onColor={(longMaColor) => patch({ longMaColor })} onWidth={(longMaWidth) => patch({ longMaWidth })} />
    <CheckRow label="Trades on chart" checked={style.tradesOnChart} onChange={(tradesOnChart) => patch({ tradesOnChart })} />
    <CheckRow label="Signal labels" checked={style.signalLabels} onChange={(signalLabels) => patch({ signalLabels })} />
    <CheckRow label="Quantity" checked={style.quantity} onChange={(quantity) => patch({ quantity })} />
    <h3>OUTPUT VALUES</h3>
    <SelectRow label="Precision" value={style.precision} onChange={(precision) => patch({ precision: precision as typeof style.precision })}><option value="DEFAULT">Default</option>{[0,1,2,3,4,5,6,7,8].map((number) => <option key={number} value={String(number)}>{number}</option>)}</SelectRow>
    <CheckRow label="Labels on price scale" checked={style.labelsOnPriceScale} onChange={(labelsOnPriceScale) => patch({ labelsOnPriceScale })} />
    <CheckRow label="Values in status line" checked={style.valuesInStatusLine} onChange={(valuesInStatusLine) => patch({ valuesInStatusLine })} />
    <h3>INPUT VALUES</h3>
    <CheckRow label="Inputs in status line" checked={style.inputsInStatusLine} onChange={(inputsInStatusLine) => patch({ inputsInStatusLine })} />
  </div>;
}

function Visibility({ value, patch }: { value: StrategyControlPanel; patch: (value: Partial<StrategyControlPanel["visibility"]>) => void }) {
  const visibility = value.visibility;
  return <div className="strategy-control-form visibility"><p>Choose the dedicated Execution Desk timeframes that display the strategy plots and trade labels. The headless strategy remains active on its configured runtime timeframe.</p><CheckRow label="All timeframes" checked={visibility.allTimeframes} onChange={(allTimeframes) => patch({ allTimeframes })} />{(["seconds", "minutes", "hours", "days", "weeks", "months"] as const).map((key) => <CheckRow key={key} label={key[0]!.toUpperCase() + key.slice(1)} checked={visibility[key]} disabled={visibility.allTimeframes} onChange={(checked) => patch({ [key]: checked })} />)}</div>;
}

function NumberRow({ label, value, min, max, step, suffix, disabled, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean; onChange: (value: number) => void }) { return <label className="strategy-control-row"><span>{label}</span><span className="strategy-control-number"><input type="number" value={value} min={min} max={max} step={step || 1} disabled={disabled} onChange={(event) => onChange(numeric(event, value))} />{suffix ? <em>{suffix}</em> : null}</span></label>; }
function CheckRow({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) { return <label className="strategy-control-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>; }
function SelectRow({ label, value, children, onChange }: { label: string; value: string; children: ReactNode; onChange: (value: string) => void }) { return <label className="strategy-control-row"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>; }
function ChoiceRow({ label, children }: { label: string; children: ReactNode }) { return <label className="strategy-control-row choice"><span>{label}</span><span>{children}</span></label>; }
function validateOrderSize(value: StrategyControlPanel, authoritativeEquity?: number, authoritativeAvailableBalance?: number, authoritativeDestination = false, authoritativeEquityTimestamp?: number, authoritativeFreshness?: string) {
  if (authoritativeDestination && (authoritativeFreshness !== "LIVE" || !Number.isFinite(authoritativeEquity) || !Number.isFinite(authoritativeEquityTimestamp) || Number(authoritativeEquity) <= 0)) {
    return "The selected broker has not supplied a positive authoritative equity snapshot yet. Refresh or restore broker reconciliation before saving live sizing.";
  }
  const amount = Number(value.properties.orderSizeValue);
  if (!Number.isFinite(amount) || amount <= 0) return "Default order size must be greater than zero.";
  if (value.properties.orderSizeMode === "PERCENT_EQUITY" && amount > 100) return "Default order size cannot exceed 100% of the selected account equity.";
  if (value.properties.orderSizeMode === "FIXED_USDT" && authoritativeEquity !== undefined && authoritativeEquity > 0) {
    const available = authoritativeAvailableBalance !== undefined && Number.isFinite(authoritativeAvailableBalance) ? Math.max(0, authoritativeAvailableBalance) : authoritativeEquity;
    const limit = Math.min(authoritativeEquity, available);
    if (amount > limit + 1e-8) return `Default order size cannot exceed the broker's current available funds (${limit.toLocaleString(undefined, { maximumFractionDigits: 8 })} USDT).`;
  }
  return undefined;
}
function VisualRow({ label, checked, color, width, onCheck, onColor, onWidth }: { label: string; checked: boolean; color: string; width: number; onCheck: (value: boolean) => void; onColor: (value: string) => void; onWidth: (value: number) => void }) { return <div className="strategy-control-visual"><label><input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} />{label}</label><input type="color" value={color} onChange={(event) => onColor(event.target.value)} /><span className="line" style={{ color, height: Math.max(1, width) }} /><select value={width} onChange={(event) => onWidth(Number(event.target.value))}>{[1,2,3,4,5].map((item) => <option key={item}>{item}</option>)}</select></div>; }
function numeric(event: ChangeEvent<HTMLInputElement>, fallback: number) { const value = Number(event.target.value); return Number.isFinite(value) ? value : fallback; }
