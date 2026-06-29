import type { AIStrategyReview, CodeSuggestion } from "../types/ai.types";

function suggestion(id: string, patch: Omit<CodeSuggestion, "id" | "status">): CodeSuggestion {
  return { id, status: "open", ...patch };
}

export function buildCodeSuggestions(review: AIStrategyReview): CodeSuggestion[] {
  const suggestions: CodeSuggestion[] = [];

  if (review.weaknesses.some((item) => item.toLowerCase().includes("drawdown"))) {
    suggestions.push(suggestion("risk-daily-loss", {
      title: "Add daily loss circuit breaker",
      reason: "The result shows drawdown pressure that should be capped before live deployment.",
      expectedImpact: "Lower tail risk and reduce losing-day clusters.",
      risk: "May stop trading before valid recovery signals.",
      patchType: "risk",
      confidence: 0.78,
      pseudoCode: `if daily_pnl <= -max_daily_loss:\n    disable_entries_until_next_session()\n\nif account_drawdown_pct > max_drawdown_pct:\n    flatten_position()\n    pause_strategy()`
    }));
  }

  if (review.failurePatterns.some((item) => item.toLowerCase().includes("chop"))) {
    suggestions.push(suggestion("filter-chop", {
      title: "Add trend regime filter",
      reason: "Losses cluster in non-trending regimes.",
      expectedImpact: "Fewer low-quality EMA crosses during sideways price action.",
      risk: "Can skip early trend transitions.",
      patchType: "filter",
      confidence: 0.72,
      pseudoCode: `adx = ta.adx(14)\nrange_pct = (highest(high, 34) - lowest(low, 34)) / close\n\nif adx < 18 or range_pct < 0.008:\n    block_entry(\"low trend quality\")`
    }));
  }

  if (review.failurePatterns.some((item) => item.toLowerCase().includes("session"))) {
    suggestions.push(suggestion("filter-session", {
      title: "Add session filter",
      reason: "Session-level performance is uneven.",
      expectedImpact: "Avoid weaker liquidity windows and improve expectancy.",
      risk: "Lower trade count and possible missed outlier moves.",
      patchType: "session",
      confidence: 0.69,
      pseudoCode: `hour = time.utc_hour\nallowed = hour >= session_start and hour < session_end\n\nif not allowed:\n    block_entry(\"outside approved session\")`
    }));
  }

  if (review.parameterSuggestions.some((item) => String(item.parameter).toLowerCase().includes("stop"))) {
    suggestions.push(suggestion("exit-atr-stop", {
      title: "Replace fixed stop with ATR stop",
      reason: "Fixed stop behavior appears sensitive to volatility.",
      expectedImpact: "Stops adapt to high-volatility candles and reduce premature exits.",
      risk: "ATR stops can increase average loss if position sizing is not adjusted.",
      patchType: "exit",
      confidence: 0.74,
      pseudoCode: `atr = ta.atr(atr_length)\nstop_distance = atr * atr_multiplier\nqty = risk_usd / stop_distance\nstop_loss = entry_price - stop_distance if long else entry_price + stop_distance`
    }));
  }

  if (suggestions.length === 0) {
    suggestions.push(suggestion("risk-spread-filter", {
      title: "Add spread and liquidity guard",
      reason: "Execution realism should be protected before forward testing.",
      expectedImpact: "Avoid entries when market quality is poor.",
      risk: "Requires reliable bid/ask and order book feed quality.",
      patchType: "filter",
      confidence: 0.62,
      pseudoCode: `spread_bps = (ask - bid) / mid * 10000\nif spread_bps > max_spread_bps or top_book_usd < min_liquidity:\n    block_entry(\"execution quality\")`
    }));
  }

  return suggestions;
}
