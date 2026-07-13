import { Activity, Check, Code2, Download, Eye, EyeOff, Globe2, Lock, Plus, Search, ShieldCheck, Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { IndicatorPeriods, VisibleIndicators } from "../chart-engine/types";
import { canUseIndicator, isPremiumIndicator } from "../features/premium";
import type { StrategyRuntimeKind } from "../modules/strategy-lab/types/strategy.types";

type IndicatorKey = keyof VisibleIndicators;
type IndicatorPeriodKey = keyof IndicatorPeriods;
type IndicatorTab = "builtins" | "myIndicators" | "myStrategies" | "communityIndicators" | "communityStrategies";

type IndicatorLibraryProps = {
  visibleIndicators: VisibleIndicators;
  indicatorPeriods: IndicatorPeriods;
  activeStrategyKind?: StrategyRuntimeKind;
  onVisibleIndicatorsChange: Dispatch<SetStateAction<VisibleIndicators>>;
  onIndicatorPeriodsChange: Dispatch<SetStateAction<IndicatorPeriods>>;
  onAddCommunityStrategy?: (strategyKind: StrategyRuntimeKind) => void;
  onClose: () => void;
  onOpenScriptEditor: () => void;
  allowedIndicators: string[];
};

type BuiltInIndicator = {
  key: IndicatorKey;
  title: string;
  group: string;
  type: string;
  signal: string;
  runtime?: "Native" | "Python";
  periodKey?: IndicatorPeriodKey;
  min?: number;
  max?: number;
  premium?: boolean;
};

type CommunityScript = {
  title: string;
  author: string;
  category: string;
  rating: string;
  installs: string;
  summary: string;
  verified?: boolean;
  strategyKind?: StrategyRuntimeKind;
};

const builtInIndicators: BuiltInIndicator[] = [
  {
    key: "aif",
    title: "A.I.F. Auction Intelligence Framework",
    group: "Proprietary / Auction Intelligence",
    type: "Overlay + Timeline",
    signal: "Long-horizon auction structure, future LVNs and event lifecycle",
    runtime: "Native"
  },
  {
    key: "orderBookHeatmap",
    title: "Order Book Heatmap",
    group: "Orderflow",
    type: "Overlay",
    signal: "Live L2 depth blocks"
  },
  {
    key: "liquidationHeatmap",
    title: "Liquidation Heatmap",
    group: "Liquidity",
    type: "Overlay",
    signal: "Modeled leverage clusters"
  },
  {
    key: "volatilityHeatmap",
    title: "Volatility-At-Entry Clusters",
    group: "Liquidity",
    type: "Overlay",
    signal: "Pine-compatible stop-cluster projection with strong active buy/sell zones",
    runtime: "Python",
    periodKey: "volatilityHeatmap",
    min: 5,
    max: 300,
    premium: true
  },
  {
    key: "volumeProfile",
    title: "HDLX Profile",
    group: "market Structure",
    type: "Overlay",
    signal: "",
    runtime: "Python"
  },
  {
    key: "adaptiveSwingStrategy",
    title: "Adaptive Swing Reversal",
    group: "Strategy",
    type: "Overlay",
    signal: "Long/short entries, TP/SL projections, regime EMA, swing levels",
    runtime: "Native"
  },
  { key: "vwap", title: "VWAP", group: "Session", type: "Overlay", signal: "Volume weighted average price" },
  { key: "ema20", title: "EMA 20", group: "Trend", type: "Overlay", signal: "Fast exponential mean", periodKey: "ema20", min: 2, max: 500 },
  { key: "ema50", title: "EMA 50", group: "Trend", type: "Overlay", signal: "Medium exponential mean", periodKey: "ema50", min: 2, max: 500 },
  { key: "ema200", title: "EMA 200", group: "Trend", type: "Overlay", signal: "Macro exponential mean", periodKey: "ema200", min: 2, max: 500 },
  { key: "sma20", title: "SMA 20", group: "Trend", type: "Overlay", signal: "Fast simple average", periodKey: "sma20", min: 2, max: 500 },
  { key: "sma50", title: "SMA 50", group: "Trend", type: "Overlay", signal: "Medium simple average", periodKey: "sma50", min: 2, max: 500 },
  { key: "bollinger", title: "Bollinger Bands", group: "Volatility", type: "Bands", signal: "2 sigma envelope", periodKey: "bollinger", min: 5, max: 300 },
  {
    key: "openInterestOscillator",
    title: "Open Interest Oscillator",
    group: "Derivatives",
    type: "Oscillator",
    signal: "Modeled OI pressure",
    runtime: "Python",
    periodKey: "openInterestOscillator",
    min: 5,
    max: 200
  },
  {
    key: "zScoreOscillator",
    title: "Z-Score Oscillator",
    group: "Mean Reversion",
    type: "Oscillator",
    signal: "Standard deviation distance",
    runtime: "Python",
    periodKey: "zScoreOscillator",
    min: 5,
    max: 300
  },
  {
    key: "waveTrendOscillator",
    title: "WaveTrend Oscillator",
    group: "Momentum",
    type: "Oscillator",
    signal: "WT main and signal",
    runtime: "Python",
    periodKey: "waveTrendOscillator",
    min: 4,
    max: 80
  },
  { key: "volume", title: "Volume", group: "Volume", type: "Pane", signal: "Exchange traded volume" }
];

const communityIndicators: CommunityScript[] = [
  {
    title: "Liquidity Sweep Detector",
    author: "BTG Labs",
    category: "Liquidity",
    rating: "4.9",
    installs: "18.2K",
    summary: "Marks stop-run candles, displacement, and reclaim zones.",
    verified: true
  },
  {
    title: "Adaptive Market Structure",
    author: "QuantDesk",
    category: "Structure",
    rating: "4.8",
    installs: "11.7K",
    summary: "Auto swing points, BOS/CHOCH labels, and premium-discount ranges.",
    verified: true
  },
  {
    title: "Session VWAP Bands Pro",
    author: "ApexFlow",
    category: "Volume",
    rating: "4.7",
    installs: "9.4K",
    summary: "Anchored session VWAP with deviation bands and volume filters."
  }
];

const communityStrategies: CommunityScript[] = [
  {
    title: "Adaptive Swing Reversal",
    author: "BTG Labs",
    category: "Swing / Regime",
    rating: "4.9",
    installs: "LOCAL",
    summary: "Targets swing tops and bottoms with liquidity sweeps, RSI reclaim, ATR stops, volume gating, and chop filters.",
    verified: true,
    strategyKind: "builtin-adaptive-swing"
  },
  {
    title: "Funding Mean Reversion",
    author: "DeltaForge",
    category: "Perpetuals",
    rating: "4.8",
    installs: "7.6K",
    summary: "Combines funding extremes, VWAP distance, and volatility compression.",
    verified: true
  },
  {
    title: "Breakout Retest Engine",
    author: "QuantDesk",
    category: "Momentum",
    rating: "4.6",
    installs: "6.1K",
    summary: "Detects range expansion, retest quality, and invalidation zones."
  },
  {
    title: "Orderflow Scalper",
    author: "BTG Labs",
    category: "Orderflow",
    rating: "4.9",
    installs: "13.8K",
    summary: "Uses DOM pressure, trade tape delta, and local liquidity imbalance.",
    verified: true
  }
];

const tabs: { id: IndicatorTab; label: string }[] = [
  { id: "builtins", label: "Built-ins" },
  { id: "myIndicators", label: "My Indicators" },
  { id: "myStrategies", label: "My Strategies" },
  { id: "communityIndicators", label: "Community Indicators" },
  { id: "communityStrategies", label: "Community Strategies" }
];

export function IndicatorLibrary({
  visibleIndicators,
  indicatorPeriods,
  activeStrategyKind,
  onVisibleIndicatorsChange,
  onIndicatorPeriodsChange,
  onAddCommunityStrategy,
  onClose,
  onOpenScriptEditor,
  allowedIndicators
}: IndicatorLibraryProps) {
  const [activeTab, setActiveTab] = useState<IndicatorTab>("builtins");
  const [query, setQuery] = useState("");
  const activeCount = builtInIndicators.filter((indicator) => visibleIndicators[indicator.key]).length;
  const searchPlaceholder = activeTab === "builtins"
    ? "Search built-in indicators"
    : activeTab === "communityIndicators"
      ? "Search community indicators"
      : activeTab === "communityStrategies"
        ? "Search community strategies"
        : "Search scripts";

  const filteredIndicators = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return builtInIndicators;

    return builtInIndicators.filter((indicator) =>
      [indicator.title, indicator.group, indicator.type, indicator.signal, indicator.runtime ?? ""].some((value) => value.toLowerCase().includes(needle))
    );
  }, [query]);

  const filteredCommunityIndicators = useMemo(
    () => filterCommunityScripts(communityIndicators, query),
    [query]
  );

  const filteredCommunityStrategies = useMemo(
    () => filterCommunityScripts(communityStrategies, query),
    [query]
  );
  const adaptiveSwingInstalled = activeStrategyKind === "builtin-adaptive-swing";

  const toggleIndicator = (key: IndicatorKey) => {
    if (!allowedIndicators.includes(key)) return;
    onVisibleIndicatorsChange((current) => ({ ...current, [key]: !current[key] }));
  };

  const updatePeriod = (key: IndicatorPeriodKey, value: number, min = 2, max = 500) => {
    onIndicatorPeriodsChange((current) => ({
      ...current,
      [key]: Math.max(min, Math.min(max, Number.isFinite(value) ? value : current[key]))
    }));
  };

  const renderCommunityScripts = (items: CommunityScript[], kind: "indicator" | "strategy") => (
    <div className="community-library">
      <div className="community-library-head">
        <Globe2 size={15} />
        <span>{kind === "indicator" ? "Community Indicators" : "Community Strategies"}</span>
        <b>BROWSE MODE</b>
      </div>
      <div className="community-list">
        {items.map((item) => {
          const installableStrategy = kind === "strategy" && item.strategyKind !== undefined;
          const activeStrategy = installableStrategy && item.strategyKind === activeStrategyKind;

          return (
            <div className={activeStrategy ? "community-row active-strategy" : "community-row"} key={item.title}>
              <div className="community-row-main">
                <div>
                  <strong>{item.title}</strong>
                  <em>{item.author} / {item.category}</em>
                </div>
                {item.verified && (
                  <span className="community-verified">
                    <ShieldCheck size={12} />
                    verified
                  </span>
                )}
              </div>
              <p>{item.summary}</p>
              <div className="community-meta">
                <span><Star size={12} /> {item.rating}</span>
                <span><Download size={12} /> {item.installs}</span>
                <button
                  type="button"
                  className={activeStrategy ? "active" : installableStrategy ? "installable" : ""}
                  disabled={!installableStrategy}
                  onClick={() => {
                    if (!item.strategyKind) return;
                    onAddCommunityStrategy?.(item.strategyKind);
                  }}
                >
                  {activeStrategy ? "ADDED" : installableStrategy ? "ADD" : "INSTALL SOON"}
                </button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="library-empty-state">No {kind === "indicator" ? "community indicators" : "community strategies"} found</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="indicator-library">
      <div className="library-head">
        <div>
          <span>INDICATORS</span>
          <strong>{activeCount} ACTIVE</strong>
        </div>
        <button type="button" aria-label="Close indicators" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="library-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeTab ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <label className="library-search">
        <Search size={14} />
        <input
          value={query}
          placeholder={searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {activeTab === "builtins" && (
        <div className="library-list">
          {filteredIndicators.map((indicator) => {
            const active = visibleIndicators[indicator.key];
            const locked = !allowedIndicators.includes(indicator.key);

            return indicator.key === "volumeProfile" ? (
              <div className={`${active ? "library-row active" : "library-row"}${locked ? " premium-locked" : ""}`} key={indicator.key}>
                <button
                  type="button"
                  className="library-row-main"
                  disabled={locked}
                  onClick={() => toggleIndicator(indicator.key)}
                >
                  {locked ? <Lock size={15} style={{ color: "var(--red-hot)" }} /> : <Activity size={15} />}
                  <span>
                    <strong>HDLX Profile</strong>
                    <em>
                      market Structure / Overlay / Python
                      {locked ? (
                        <b style={{
                          background: "rgba(255, 0, 68, 0.12)",
                          border: "1px solid var(--red-hot)",
                          color: "var(--red-hot)",
                          padding: "1px 5px",
                          fontSize: "8px",
                          borderRadius: "2px",
                          fontWeight: 800,
                          marginLeft: "8px",
                          textTransform: "uppercase"
                        }}>Proprietary/classified</b>
                      ) : null}
                    </em>
                  </span>
                </button>
                <span className="library-signal"></span>
                <span className="library-period static">AUTO</span>
                <button
                  type="button"
                  className={active ? "library-action active" : "library-action"}
                  disabled={locked}
                  onClick={() => toggleIndicator(indicator.key)}
                  style={{ minWidth: "110px" }}
                >
                  {locked ? <Lock size={14} style={{ color: "var(--red-hot)" }} /> : active ? <Check size={14} /> : <Plus size={14} />}
                  <span>{locked ? "PROPRIETARY" : active ? "ON" : "ADD"}</span>
                </button>
              </div>
            ) : (
              <div className={`${active ? "library-row active" : "library-row"}${locked ? " premium-locked" : ""}`} key={indicator.key}>
                <button
                  type="button"
                  className="library-row-main"
                  disabled={locked}
                  onClick={() => toggleIndicator(indicator.key)}
                >
                  {locked ? <Lock size={15} /> : <Activity size={15} />}
                    <span>
                      <strong>{indicator.title}</strong>
                      <em>
                        {indicator.group} / {indicator.type}{indicator.runtime ? ` / ${indicator.runtime}` : ""}
                        {indicator.premium ? <b className="premium-badge">PREMIUM</b> : null}
                      </em>
                    </span>
                </button>
                <span className="library-signal">{indicator.signal}</span>
                {indicator.periodKey ? (
                  <input
                    aria-label={`${indicator.title} length`}
                    className="library-period"
                    disabled={locked}
                    max={indicator.max}
                    min={indicator.min}
                    type="number"
                    value={indicatorPeriods[indicator.periodKey]}
                    onChange={(event) => updatePeriod(indicator.periodKey!, Number(event.target.value), indicator.min, indicator.max)}
                  />
                ) : (
                  <span className="library-period static">AUTO</span>
                )}
                <button
                  type="button"
                  className={active ? "library-action active" : "library-action"}
                  disabled={locked}
                  onClick={() => toggleIndicator(indicator.key)}
                >
                  {locked ? <Lock size={14} /> : active ? <Check size={14} /> : <Plus size={14} />}
                  <span>{locked ? "LOCKED" : active ? "ON" : "ADD"}</span>
                </button>
              </div>
            );
          })}
          {filteredIndicators.length === 0 && (
            <div className="library-empty-state">No built-in indicators found</div>
          )}
        </div>
      )}

      {activeTab === "myIndicators" && (
        <div className="script-library">
          <div className="script-library-empty">
            <Code2 size={18} />
            <strong>Python Indicators</strong>
            <span>0 LOCAL / 0 PUBLISHED</span>
            <button type="button" onClick={onOpenScriptEditor}>NEW INDICATOR</button>
          </div>
        </div>
      )}

      {activeTab === "myStrategies" && (
        adaptiveSwingInstalled ? (
          <div className="library-list">
            {(() => {
              const locked = !allowedIndicators.includes("adaptiveSwingStrategy");
              return (
                <div className={`${visibleIndicators.adaptiveSwingStrategy ? "library-row active" : "library-row"}${locked ? " premium-locked" : ""}`}>
                  <button
                    type="button"
                    className="library-row-main"
                    disabled={locked}
                    onClick={() => toggleIndicator("adaptiveSwingStrategy")}
                  >
                    {locked ? <Lock size={15} /> : <Activity size={15} />}
                    <span>
                      <strong>Adaptive Swing Reversal</strong>
                      <em>Community / Strategy Overlay / Native</em>
                    </span>
                  </button>
                  <span className="library-signal">Long Entry, Short Entry, TP/SL projections, regime EMA</span>
                  <span className="library-period static">AUTO</span>
                  <button
                    type="button"
                    className={visibleIndicators.adaptiveSwingStrategy ? "library-action active" : "library-action"}
                    disabled={locked}
                    onClick={() => toggleIndicator("adaptiveSwingStrategy")}
                  >
                    {locked ? <Lock size={14} /> : visibleIndicators.adaptiveSwingStrategy ? <Check size={14} /> : <Plus size={14} />}
                    <span>{locked ? "LOCKED" : visibleIndicators.adaptiveSwingStrategy ? "ON" : "ADD"}</span>
                  </button>
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="script-library">
            <div className="script-library-empty">
              <Code2 size={18} />
              <strong>Python Strategies</strong>
              <span>0 LOCAL / 0 DEPLOYED</span>
              <button type="button" onClick={onOpenScriptEditor}>NEW STRATEGY</button>
            </div>
          </div>
        )
      )}

      {activeTab === "communityIndicators" && renderCommunityScripts(filteredCommunityIndicators, "indicator")}

      {activeTab === "communityStrategies" && renderCommunityScripts(filteredCommunityStrategies, "strategy")}

      <div className="library-footer">
        <span><Eye size={12} /> visible</span>
        <span><EyeOff size={12} /> hidden</span>
      </div>
    </div>
  );
}

function filterCommunityScripts(items: CommunityScript[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;

  return items.filter((item) =>
    [
      item.title,
      item.author,
      item.category,
      item.rating,
      item.installs,
      item.summary,
      item.verified ? "verified" : ""
    ].some((value) => value.toLowerCase().includes(needle))
  );
}
