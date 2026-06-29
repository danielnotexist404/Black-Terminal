import type { LucideIcon } from "lucide-react";
import { Activity, Bot, ChartSpline, Code2, FlaskConical, Gauge, Grid3X3, List, Play, TrendingDown } from "lucide-react";

export type StrategyLabTab =
  | "overview"
  | "backtest"
  | "trades"
  | "equity"
  | "drawdown"
  | "optimization"
  | "heatmap"
  | "aiReview"
  | "codeSuggestions"
  | "forwardTest";

export const strategyLabTabs: { id: StrategyLabTab; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "backtest", label: "Backtest", icon: FlaskConical },
  { id: "trades", label: "Trades", icon: List },
  { id: "equity", label: "Equity Curve", icon: ChartSpline },
  { id: "drawdown", label: "Drawdown", icon: TrendingDown },
  { id: "optimization", label: "Optimization", icon: Activity },
  { id: "heatmap", label: "Heatmap", icon: Grid3X3 },
  { id: "aiReview", label: "AI Review", icon: Bot },
  { id: "codeSuggestions", label: "Code Suggestions", icon: Code2 },
  { id: "forwardTest", label: "Forward Test", icon: Play }
];

type StrategyTabsProps = {
  activeTab: StrategyLabTab;
  onTabChange: (tab: StrategyLabTab) => void;
};

export function StrategyTabs({ activeTab, onTabChange }: StrategyTabsProps) {
  return (
    <div className="strategy-tabs">
      {strategyLabTabs.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" className={activeTab === id ? "active" : ""} onClick={() => onTabChange(id)}>
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
