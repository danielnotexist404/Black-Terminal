import { useState, useEffect } from "react";
import { TrendingUp, TrendingDown, Volume2, Percent, Activity, BarChart2, Compass, AlertCircle, X } from "lucide-react";

type MarketOverviewProps = {
  onClose: () => void;
  onSelectSymbol: (symbolToken: string) => void;
};

type MarketToken = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  volume: number;
};

export function MarketOverview({ onClose, onSelectSymbol }: MarketOverviewProps) {
  const [sentiment, setSentiment] = useState(58); // Bullish sentiment percentage (0-100)
  const [tokens, setTokens] = useState<MarketToken[]>([]);

  // Initialize and simulate changing stats
  useEffect(() => {
    const initialTokens: MarketToken[] = [
      { symbol: "BTC", name: "Bitcoin", price: 66240.5, change: 2.45, volume: 28490000000 },
      { symbol: "ETH", name: "Ethereum", price: 3485.2, change: 3.12, volume: 15320000000 },
      { symbol: "SOL", name: "Solana", price: 145.8, change: 7.82, volume: 3840000000 },
      { symbol: "HYPE", name: "Hyperliquid", price: 12.45, change: 14.28, volume: 1250000000 },
      { symbol: "BNB", name: "Binance Coin", price: 582.4, change: -1.02, volume: 920000000 },
      { symbol: "XRP", name: "Ripple", price: 0.485, change: -2.35, volume: 810000000 },
      { symbol: "LINK", name: "Chainlink", price: 14.2, change: 4.88, volume: 460000000 },
      { symbol: "AVAX", name: "Avalanche", price: 28.5, change: -3.85, volume: 320000000 }
    ];
    setTokens(initialTokens);

    const timer = setInterval(() => {
      // Fluctuate sentiment slightly
      setSentiment(s => {
        const delta = Math.floor(Math.random() * 5) - 2;
        return Math.max(30, Math.min(85, s + delta));
      });

      // Fluctuate tokens
      setTokens(prev =>
        prev.map(t => {
          const delta = (Math.random() - 0.5) * 0.4;
          const newPrice = t.price * (1 + delta / 100);
          const newChange = t.change + delta;
          return {
            ...t,
            price: Number(newPrice.toFixed(2)),
            change: Number(newChange.toFixed(2)),
            volume: t.volume + Math.floor((Math.random() - 0.5) * 2000000)
          };
        })
      );
    }, 4000);

    return () => clearInterval(timer);
  }, []);

  const gainers = [...tokens].sort((a, b) => b.change - a.change);
  const losers = [...tokens].sort((a, b) => a.change - b.change);
  const volumeLeaders = [...tokens].sort((a, b) => b.volume - a.volume);

  return (
    <div className="market-overview-panel" style={{
      padding: "24px",
      height: "100%",
      overflowY: "auto",
      background: "linear-gradient(180deg, rgba(6,7,8,0.99) 0%, rgba(3,4,5,0.99) 100%)",
      color: "var(--text)",
      fontFamily: "IBM Plex Mono, monospace"
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottom: "1px solid var(--line)",
        paddingBottom: "16px",
        marginBottom: "24px"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Compass style={{ color: "var(--red-hot)" }} size={20} />
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--strong)", letterSpacing: "0.08em" }}>
            MARKET SENTIMENT & OVERVIEW
          </h2>
        </div>
        <button type="button" onClick={onClose} style={{
          background: "transparent",
          border: 0,
          color: "var(--muted)",
          cursor: "pointer"
        }}>
          <X size={18} />
        </button>
      </div>

      {/* Sentiment Gauge & Stats Grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 2fr",
        gap: "24px",
        marginBottom: "28px"
      }}>
        {/* Sentiment Meter */}
        <div style={{
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255, 0, 0, 0.12)",
          borderRadius: "4px",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden"
        }}>
          <span style={{ fontSize: "10px", color: "var(--muted)", fontWeight: 700, marginBottom: "16px", letterSpacing: "0.06em" }}>MARKET SENTIMENT</span>
          
          {/* Circular dial gauge */}
          <div style={{
            position: "relative",
            width: "120px",
            height: "120px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}>
            <svg width="120" height="120" viewBox="0 0 120 120" style={{ transform: "rotate(-90deg)" }}>
              {/* Dial Track */}
              <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
              {/* Dial Arc (Sentiment Value) */}
              <circle cx="60" cy="60" r="50" fill="none" 
                stroke="var(--red-hot)" 
                strokeWidth="6" 
                strokeDasharray={`${2 * Math.PI * 50}`}
                strokeDashoffset={`${2 * Math.PI * 50 * (1 - sentiment / 100)}`}
                style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)" }}
              />
            </svg>
            <div style={{
              position: "absolute",
              display: "flex",
              flexDirection: "column",
              alignItems: "center"
            }}>
              <span style={{ fontSize: "24px", fontWeight: 700, color: "var(--strong)" }}>{sentiment}%</span>
              <span style={{ fontSize: "9px", color: sentiment > 55 ? "var(--green)" : "var(--red-hot)", fontWeight: 700 }}>
                {sentiment > 55 ? "BULLISH" : "BEARISH"}
              </span>
            </div>
          </div>
        </div>

        {/* Global Market Stats */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "16px"
        }}>
          <div style={{
            background: "rgba(255,255,255,0.015)",
            border: "1px solid rgba(255,255,255,0.035)",
            borderRadius: "4px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}>
            <span style={{ fontSize: "9px", color: "var(--muted)", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}><Volume2 size={12} /> GLOBAL 24H VOLUME</span>
            <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--strong)", margin: "12px 0 4px" }}>$54.67 B</div>
            <span style={{ fontSize: "9px", color: "var(--green)" }}>+8.45% vs yesterday</span>
          </div>

          <div style={{
            background: "rgba(255,255,255,0.015)",
            border: "1px solid rgba(255,255,255,0.035)",
            borderRadius: "4px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}>
            <span style={{ fontSize: "9px", color: "var(--muted)", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}><Percent size={12} /> BTC DOMINANCE</span>
            <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--strong)", margin: "12px 0 4px" }}>62.4 %</div>
            <span style={{ fontSize: "9px", color: "var(--muted)" }}>Macro trend expansion</span>
          </div>

          <div style={{
            background: "rgba(255,255,255,0.015)",
            border: "1px solid rgba(255,255,255,0.035)",
            borderRadius: "4px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}>
            <span style={{ fontSize: "9px", color: "var(--muted)", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}><Activity size={12} /> OPEN INTEREST</span>
            <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--strong)", margin: "12px 0 4px" }}>$18.91 B</div>
            <span style={{ fontSize: "9px", color: "var(--red-hot)" }}>-2.12% leverage flush</span>
          </div>
        </div>
      </div>

      {/* Lists section */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: "24px"
      }}>
        {/* Top Gainers */}
        <div style={{
          background: "rgba(255,255,255,0.01)",
          border: "1px solid rgba(255,255,255,0.025)",
          borderRadius: "4px",
          padding: "16px"
        }}>
          <h4 style={{ margin: "0 0 12px", fontSize: "11px", color: "var(--green)", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}>
            <TrendingUp size={14} /> TOP GAINERS
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {gainers.slice(0, 4).map(t => (
              <div key={t.symbol} 
                onClick={() => onSelectSymbol(t.symbol)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px",
                  background: "rgba(255,255,255,0.01)",
                  borderRadius: "2px",
                  cursor: "pointer",
                  transition: "background 0.2s"
                }}
                onMouseOver={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                onMouseOut={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.01)")}
              >
                <div>
                  <strong style={{ fontSize: "12px", color: "var(--strong)" }}>{t.symbol}</strong>
                  <div style={{ fontSize: "9px", color: "var(--muted)" }}>{t.name}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "11px", color: "var(--strong)" }}>${t.price}</div>
                  <div style={{ fontSize: "10px", color: "var(--green)", fontWeight: 600 }}>+{t.change}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Losers */}
        <div style={{
          background: "rgba(255,255,255,0.01)",
          border: "1px solid rgba(255,255,255,0.025)",
          borderRadius: "4px",
          padding: "16px"
        }}>
          <h4 style={{ margin: "0 0 12px", fontSize: "11px", color: "var(--red-hot)", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}>
            <TrendingDown size={14} /> TOP LOSERS
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {losers.slice(0, 4).map(t => (
              <div key={t.symbol}
                onClick={() => onSelectSymbol(t.symbol)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px",
                  background: "rgba(255,255,255,0.01)",
                  borderRadius: "2px",
                  cursor: "pointer",
                  transition: "background 0.2s"
                }}
                onMouseOver={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                onMouseOut={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.01)")}
              >
                <div>
                  <strong style={{ fontSize: "12px", color: "var(--strong)" }}>{t.symbol}</strong>
                  <div style={{ fontSize: "9px", color: "var(--muted)" }}>{t.name}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "11px", color: "var(--strong)" }}>${t.price}</div>
                  <div style={{ fontSize: "10px", color: "var(--red-hot)", fontWeight: 600 }}>{t.change}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Volume Leaders */}
        <div style={{
          background: "rgba(255,255,255,0.01)",
          border: "1px solid rgba(255,255,255,0.025)",
          borderRadius: "4px",
          padding: "16px"
        }}>
          <h4 style={{ margin: "0 0 12px", fontSize: "11px", color: "var(--strong)", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}>
            <BarChart2 size={14} /> VOLUME LEADERS
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {volumeLeaders.slice(0, 4).map(t => (
              <div key={t.symbol}
                onClick={() => onSelectSymbol(t.symbol)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px",
                  background: "rgba(255,255,255,0.01)",
                  borderRadius: "2px",
                  cursor: "pointer",
                  transition: "background 0.2s"
                }}
                onMouseOver={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                onMouseOut={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.01)")}
              >
                <div>
                  <strong style={{ fontSize: "12px", color: "var(--strong)" }}>{t.symbol}</strong>
                  <div style={{ fontSize: "9px", color: "var(--muted)" }}>24h Volume</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "11px", color: "var(--strong)" }}>${(t.volume / 1000000000).toFixed(2)}B</div>
                  <div style={{ fontSize: "10px", color: t.change >= 0 ? "var(--green)" : "var(--red-hot)" }}>
                    {t.change >= 0 ? "+" : ""}{t.change}%
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
