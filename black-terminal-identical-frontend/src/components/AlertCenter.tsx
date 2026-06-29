import { Bell, Mail, Pencil, Plus, Power, Save, Trash2, Webhook, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AlertCondition,
  AlertIndicatorTarget,
  AlertLevelTarget,
  AlertRunMode,
  IndicatorAlertDefinition
} from "../automation/alerts";
import type { Timeframe } from "../market-data/types";

type AlertCenterProps = {
  alerts: IndicatorAlertDefinition[];
  onAlertsChange: Dispatch<SetStateAction<IndicatorAlertDefinition[]>>;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
};

const indicatorOptions: { value: AlertIndicatorTarget; label: string }[] = [
  { value: "price", label: "Price" },
  { value: "hdlxProfile", label: "HDLX Profile" },
  { value: "vwap", label: "VWAP" },
  { value: "ema20", label: "EMA 20" },
  { value: "ema50", label: "EMA 50" },
  { value: "ema200", label: "EMA 200" }
];

const levelOptions: { value: AlertLevelTarget; label: string }[] = [
  { value: "any", label: "Any Level" },
  { value: "poc", label: "POC" },
  { value: "vah", label: "VAH" },
  { value: "val", label: "VAL" },
  { value: "lvn", label: "LVN" }
];

const conditionOptions: { value: AlertCondition; label: string }[] = [
  { value: "testing", label: "Testing" },
  { value: "crossingAbove", label: "Crossing Above" },
  { value: "crossingBelow", label: "Crossing Below" }
];

const runModeOptions: { value: AlertRunMode; label: string }[] = [
  { value: "once", label: "Fire Once" },
  { value: "perpetual", label: "Perpetual" }
];

const indicatorLabels = Object.fromEntries(indicatorOptions.map((option) => [option.value, option.label])) as Record<AlertIndicatorTarget, string>;
const conditionLabels = Object.fromEntries(conditionOptions.map((option) => [option.value, option.label])) as Record<AlertCondition, string>;
const levelLabels = Object.fromEntries(levelOptions.map((option) => [option.value, option.label])) as Record<AlertLevelTarget, string>;

function makeAlertId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `alert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function createAlertDraft(symbol: string, exchange: string, timeframe: Timeframe): IndicatorAlertDefinition {
  return {
    id: makeAlertId(),
    enabled: true,
    name: `${symbol} HDLX test`,
    symbol,
    exchange,
    timeframe,
    indicator: "hdlxProfile",
    levelTarget: "any",
    targetPrice: undefined,
    color: "#ffffff",
    condition: "testing",
    runMode: "perpetual",
    cooldownSeconds: 90,
    webhookUrl: "",
    p2pEndpoint: "",
    sshTarget: "",
    emailTo: "",
    message: "{{name}}: {{indicator}} {{condition}} on {{symbol}} at {{price}}",
    script: "",
    createdAt: Date.now(),
    fired: false
  };
}

export function AlertCenter({ alerts, onAlertsChange, symbol, exchange, timeframe }: AlertCenterProps) {
  const [draft, setDraft] = useState<IndicatorAlertDefinition | null>(null);

  const sortedAlerts = useMemo(() => {
    return [...alerts].sort((a, b) => {
      const aCurrent = a.symbol === symbol && a.exchange === exchange && a.timeframe === timeframe ? 0 : 1;
      const bCurrent = b.symbol === symbol && b.exchange === exchange && b.timeframe === timeframe ? 0 : 1;
      return aCurrent - bCurrent || b.createdAt - a.createdAt;
    });
  }, [alerts, exchange, symbol, timeframe]);

  const activeCount = alerts.filter((alert) => alert.enabled && !alert.fired).length;

  const beginNewAlert = () => {
    setDraft(createAlertDraft(symbol, exchange, timeframe));
  };

  const saveDraft = () => {
    if (!draft) return;
    const nextAlert: IndicatorAlertDefinition = {
      ...draft,
      name: draft.name.trim() || `${indicatorLabels[draft.indicator]} alert`,
      symbol: draft.symbol || symbol,
      exchange: draft.exchange || exchange,
      timeframe: draft.timeframe || timeframe,
      levelTarget: draft.indicator === "hdlxProfile" ? draft.levelTarget ?? "any" : undefined,
      targetPrice: draft.indicator === "price" && Number.isFinite(draft.targetPrice) ? draft.targetPrice : undefined,
      color: draft.indicator === "price" ? draft.color || "#ffffff" : draft.color,
      cooldownSeconds: clampNumber(Math.round(draft.cooldownSeconds), 5, 86400),
      webhookUrl: draft.webhookUrl?.trim() || "",
      p2pEndpoint: draft.p2pEndpoint?.trim() || "",
      sshTarget: draft.sshTarget?.trim() || "",
      emailTo: draft.emailTo?.trim() || "",
      fired: draft.runMode === "once" ? draft.fired : false
    };

    onAlertsChange((current) => {
      const exists = current.some((alert) => alert.id === nextAlert.id);
      if (!exists) return [nextAlert, ...current];
      return current.map((alert) => alert.id === nextAlert.id ? nextAlert : alert);
    });
    setDraft(null);
  };

  const updateDraft = <Key extends keyof IndicatorAlertDefinition>(key: Key, value: IndicatorAlertDefinition[Key]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleAlert = (alertId: string) => {
    onAlertsChange((current) =>
      current.map((alert) =>
        alert.id === alertId
          ? { ...alert, enabled: !alert.enabled, fired: alert.enabled ? alert.fired : false }
          : alert
      )
    );
  };

  const deleteAlert = (alertId: string) => {
    onAlertsChange((current) => current.filter((alert) => alert.id !== alertId));
    setDraft((current) => current?.id === alertId ? null : current);
  };

  return (
    <div className="alerts-workspace">
      <div className="alerts-list-pane">
        <div className="alerts-head">
          <div>
            <span>ALERTS</span>
            <b>{activeCount}</b>
          </div>
          <button type="button" className="alerts-add-button" aria-label="Create alert" title="Create alert" onClick={beginNewAlert}>
            <Plus size={18} />
          </button>
        </div>
        <div className="alerts-list">
          {sortedAlerts.length === 0 ? (
            <div className="alerts-empty">NO ALERTS CONFIGURED</div>
          ) : (
            sortedAlerts.map((alert) => (
              <div key={alert.id} className={alert.enabled && !alert.fired ? "alert-row active" : "alert-row"}>
                <button
                  type="button"
                  className={alert.enabled ? "alert-row-power on" : "alert-row-power"}
                  aria-label={alert.enabled ? "Disable alert" : "Enable alert"}
                  title={alert.enabled ? "Disable" : "Enable"}
                  onClick={() => toggleAlert(alert.id)}
                >
                  <Power size={13} />
                </button>
                <button type="button" className="alert-row-main" onClick={() => setDraft(alert)}>
                  <strong>{alert.name}</strong>
                  <span>
                    {indicatorLabels[alert.indicator]}
                    {alert.indicator === "hdlxProfile" && alert.levelTarget ? ` ${levelLabels[alert.levelTarget]}` : ""}
                    {alert.indicator === "price" && Number.isFinite(alert.targetPrice) ? ` ${alert.targetPrice?.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ""}
                    {" / "}
                    {conditionLabels[alert.condition]}
                  </span>
                </button>
                <div className="alert-row-actions">
                  {alert.webhookUrl?.trim() || alert.p2pEndpoint?.trim() || alert.sshTarget?.trim() ? <Webhook size={13} /> : null}
                  {alert.emailTo?.trim() ? <Mail size={13} /> : null}
                  <button type="button" aria-label="Edit alert" title="Edit" onClick={() => setDraft(alert)}>
                    <Pencil size={13} />
                  </button>
                  <button type="button" aria-label="Delete alert" title="Delete" onClick={() => deleteAlert(alert.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="alert-editor-pane">
        {draft ? (
          <form
            className="alert-editor"
            onSubmit={(event) => {
              event.preventDefault();
              saveDraft();
            }}
          >
            <div className="alert-editor-head">
              <div>
                <span>{draft.symbol}</span>
                <b>{draft.exchange.toUpperCase()} / {draft.timeframe}</b>
              </div>
              <button type="button" aria-label="Close alert editor" title="Close" onClick={() => setDraft(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="alert-editor-grid">
              <label className="alert-field wide">
                Alert Name
                <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} />
              </label>
              <label className="alert-field toggle-field">
                Enabled
                <input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft("enabled", event.target.checked)} />
              </label>
              <label className="alert-field">
                Indicator
                <select
                  value={draft.indicator}
                  onChange={(event) => {
                    const indicator = event.target.value as AlertIndicatorTarget;
                    setDraft((current) => current ? {
                      ...current,
                      indicator,
                      levelTarget: indicator === "hdlxProfile" ? current.levelTarget ?? "any" : undefined,
                      targetPrice: indicator === "price" ? current.targetPrice : undefined
                    } : current);
                  }}
                >
                  {indicatorOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="alert-field">
                Level
                <select
                  value={draft.levelTarget ?? "any"}
                  disabled={draft.indicator !== "hdlxProfile"}
                  onChange={(event) => updateDraft("levelTarget", event.target.value as AlertLevelTarget)}
                >
                  {levelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="alert-field">
                Price
                <input
                  type="number"
                  step="0.1"
                  value={draft.targetPrice ?? ""}
                  disabled={draft.indicator !== "price"}
                  onChange={(event) => updateDraft("targetPrice", Number(event.target.value))}
                />
              </label>
              <label className="alert-field">
                Line Color
                <input
                  type="color"
                  value={draft.color ?? "#ffffff"}
                  disabled={draft.indicator !== "price"}
                  onChange={(event) => updateDraft("color", event.target.value)}
                />
              </label>
              <label className="alert-field">
                Condition
                <select value={draft.condition} onChange={(event) => updateDraft("condition", event.target.value as AlertCondition)}>
                  {conditionOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="alert-field">
                Cooldown Seconds
                <input
                  type="number"
                  min={5}
                  max={86400}
                  step={5}
                  value={draft.cooldownSeconds}
                  onChange={(event) => updateDraft("cooldownSeconds", clampNumber(Number(event.target.value), 5, 86400))}
                />
              </label>
              <div className="alert-field wide">
                Run Mode
                <div className="alert-segmented">
                  {runModeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={draft.runMode === option.value ? "active" : ""}
                      onClick={() => updateDraft("runMode", option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="alert-field wide">
                Webhook URL
                <input value={draft.webhookUrl ?? ""} onChange={(event) => updateDraft("webhookUrl", event.target.value)} />
              </label>
              <label className="alert-field wide">
                P2P Relay Endpoint
                <input placeholder="http://peer.local:8787/alert" value={draft.p2pEndpoint ?? ""} onChange={(event) => updateDraft("p2pEndpoint", event.target.value)} />
              </label>
              <label className="alert-field wide">
                SSH Target
                <input placeholder="user@host" value={draft.sshTarget ?? ""} onChange={(event) => updateDraft("sshTarget", event.target.value)} />
              </label>
              <label className="alert-field wide">
                Email Address
                <input type="email" value={draft.emailTo ?? ""} onChange={(event) => updateDraft("emailTo", event.target.value)} />
              </label>
              <label className="alert-field wide">
                Custom Message
                <textarea rows={3} value={draft.message} onChange={(event) => updateDraft("message", event.target.value)} />
              </label>
              <label className="alert-field wide">
                Custom Script
                <textarea rows={4} value={draft.script} onChange={(event) => updateDraft("script", event.target.value)} />
              </label>
            </div>

            <div className="alert-editor-actions">
              <button type="button" className="ghost" onClick={() => deleteAlert(draft.id)}>
                <Trash2 size={14} />
                Delete
              </button>
              <span />
              <button type="button" className="ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button type="submit" className="primary">
                <Save size={14} />
                Save Alert
              </button>
            </div>
          </form>
        ) : (
          <div className="alerts-idle">
            <Bell size={18} />
            <span>ALERT DESK</span>
          </div>
        )}
      </div>
    </div>
  );
}
