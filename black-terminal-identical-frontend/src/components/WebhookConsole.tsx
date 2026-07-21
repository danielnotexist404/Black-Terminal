type ConsoleTab = "ALERTS" | "WEBHOOKS" | "STRATEGY TESTER" | "LOGS" | "SIGNALS";

type WebhookConsoleProps = {
  activeTab: ConsoleTab;
  onTabChange: (tab: ConsoleTab) => void;
  symbol: string;
};

const tabs: ConsoleTab[] = ["ALERTS", "WEBHOOKS", "STRATEGY TESTER", "LOGS", "SIGNALS"];

function rowsFor(tab: ConsoleTab, symbol: string) {
  const common = {
    ALERTS: [
      ["11:22:17.352", "ALERT_TRIGGERED", `${symbol} 15m`, "Price crossed above active level", "200 OK"],
      ["11:22:14.102", "ALERT_TRIGGERED", `${symbol} 1h`, "RSI crossed below 30.0", "200 OK"],
      ["11:21:58.443", "ALERT_ARMED", `${symbol} 5m`, "Liquidity sweep condition armed", "READY"]
    ],
    WEBHOOKS: [
      ["11:22:17.352", "ALERT_TRIGGERED", `${symbol} 15m`, "Price crossed above 66,650.0 (EMA20)", "200 OK"],
      ["11:22:16.981", "ORDER_FILLED", symbol, "Market Buy 0.050 BTC @ 66,678.0", "200 OK"],
      ["11:22:15.443", "STRATEGY_SIGNAL", "MeanReversion-v2", "Long signal generated (Score: 0.87)", "200 OK"],
      ["11:22:14.102", "ALERT_TRIGGERED", `${symbol} 1h`, "RSI crossed below 30.0", "200 OK"],
      ["11:22:13.578", "POSITION_UPDATE", symbol, "Position size: 0.150 BTC (Long)", "200 OK"]
    ],
    "STRATEGY TESTER": [
      ["11:22:17.352", "BACKTEST_READY", "MeanReversion-v2", "260 candles loaded from selected timeframe", "READY"],
      ["11:22:16.981", "RISK_GUARD", "Paper Engine", "Max order size 2,500 USDT", "ARMED"],
      ["11:22:15.443", "SIGNAL_SCAN", symbol, "12 setups evaluated", "DONE"]
    ],
    LOGS: [
      ["11:22:17.352", "DATA_CONNECTED", "BINANCE", `${symbol} live kline stream active`, "OK"],
      ["11:22:16.981", "WORKSPACE_LOAD", "LOCAL", "Quant Desk layout restored", "OK"],
      ["11:22:15.443", "RENDERER", "PIXI", "Chart canvas initialized", "OK"]
    ],
    SIGNALS: [
      ["11:22:17.352", "EMA_SIGNAL", `${symbol} 15m`, "EMA compression detected", "ACTIVE"],
      ["11:22:16.981", "VWAP_SIGNAL", symbol, "Price below anchored VWAP", "WATCH"],
      ["11:22:15.443", "LIQUIDITY_SIGNAL", "Heatmap", "Strong high cluster visible", "ACTIVE"]
    ]
  } satisfies Record<ConsoleTab, string[][]>;

  return common[tab];
}

export function WebhookConsole({ activeTab, onTabChange, symbol }: WebhookConsoleProps) {
  const rows = rowsFor(activeTab, symbol);

  return (
    <div className="console">
      <div className="console-tabs">
        {tabs.map((tab) => (
          <button key={tab} className={tab === activeTab ? "active" : ""} onClick={() => onTabChange(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="log-table">
        <div className="log-head">
          <span>TIME</span>
          <span>EVENT</span>
          <span>SOURCE</span>
          <span>MESSAGE</span>
          <span>STATUS</span>
        </div>
        {rows.map((row) => (
          <div className="log-row" key={row.join("")}>
            {row.map((cell, index) => (
              <span key={index} className={index === 4 ? "ok" : ""}>
                {cell}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
