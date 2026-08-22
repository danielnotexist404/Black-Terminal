import type { LucideIcon } from "lucide-react";
import { BarChart3, BookOpenCheck, CloudCog, FileClock, FlaskConical, LockKeyhole, WalletCards } from "lucide-react";

export type StrategyLabTab =
  | "myStrategy"
  | "backtest"
  | "paperTrading"
  | "liveAutomation"
  | "analytics"
  | "research"
  | "logs";

export const strategyLabTabs: { id: StrategyLabTab; label: string; icon: LucideIcon }[] = [
  { id: "myStrategy", label: "My Strategy", icon: CloudCog },
  { id: "backtest", label: "Backtest", icon: FlaskConical },
  { id: "paperTrading", label: "Paper Trading", icon: WalletCards },
  { id: "liveAutomation", label: "Live Automation", icon: LockKeyhole },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "research", label: "Research", icon: BookOpenCheck },
  { id: "logs", label: "Logs", icon: FileClock }
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
