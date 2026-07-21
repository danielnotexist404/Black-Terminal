export function MarketStats() {
  const rows = [
    ["Open Interest (BTC)", "24.28B"],
    ["Open Interest (USD)", "366.12K"],
    ["24H Volume (USD)", "18.73B"],
    ["Funding Rate", "0.0100%"],
    ["Next Funding", "05:37:42"],
    ["24H High", "67,185.7"],
    ["24H Low", "64,520.1"]
  ];
  return (
    <div className="market-stats panel-block">
      <div className="panel-title underlined">MARKET STATS <span>24H & FUNDING</span></div>
      {rows.map(([k, v]) => (
        <div className="stat-row" key={k}>
          <span>{k}</span>
          <b className={k === "Funding Rate" ? "red" : ""}>{v}</b>
        </div>
      ))}
    </div>
  );
}
