# Black-Terminal Strategy Lab reference script
# Adaptive Swing Reversal: trend-aligned swing entries with one active trade at a time.
#
# This mirrors the built-in TypeScript model in adapters/signalAdapter.ts.
# TODO: wire Python strategy scripts into Strategy Lab through pythonStrategyAdapter.ts.

ema_regime_length = input.int(200, "Regime EMA")
swing_lookback = input.int(36, "Swing Lookback")
atr_length = input.int(21, "ATR Length")
rsi_length = input.int(14, "RSI Length")
rsi_oversold = input.float(42, "RSI Pullback Floor")
rsi_overbought = input.float(58, "RSI Pullback Ceiling")
atr_stop_multiplier = input.float(1.55, "ATR Stop Multiplier")
take_profit_ratio = input.float(2.1, "Take Profit R")
min_trend_quality = input.float(0.16, "Min Trend Quality")
max_chop_ratio = input.float(0.24, "Max Chop Ratio")
min_volume_mult = input.float(0.5, "Min Volume X")

fast_trend_length = max(12, round(swing_lookback / 2))
mid_trend_length = max(24, swing_lookback * 2)
cooldown_bars = max(12, round(swing_lookback / 2))

ema_regime = ta.ema(close, ema_regime_length)
ema_fast_trend = ta.ema(close, fast_trend_length)
ema_mid_trend = ta.ema(close, mid_trend_length)
atr_value = ta.atr(atr_length)
rsi_value = ta.rsi(close, rsi_length)
avg_volume = ta.sma(volume, 50)

prior_low = ta.lowest(low[1], swing_lookback)
prior_high = ta.highest(high[1], swing_lookback)
range_high = ta.highest(high[1], swing_lookback * 3)
range_low = ta.lowest(low[1], swing_lookback * 3)

range_size = max(range_high - range_low, atr_value)
net_move = abs(close - close[swing_lookback * 3])
efficiency = net_move / range_size
trend_slope = (ema_regime - ema_regime[swing_lookback * 2]) / max(atr_value, close * 0.0001)
compression_ratio = range_size / max(atr_value * swing_lookback * 1.3, close * 0.0001)
trend_quality = min(1, (abs(trend_slope) / 2.6) * 0.55 + efficiency * 0.45)
slope_threshold = max(0.04, min_trend_quality * 0.5)

is_chop = trend_quality < min_trend_quality or compression_ratio < max_chop_ratio or atr_value / close < 0.0012
volume_ok = volume >= avg_volume * min_volume_mult

up_regime = (
    close > ema_regime
    and ema_fast_trend > ema_regime
    and trend_slope > slope_threshold
) or (
    close > ema_regime
    and trend_slope > slope_threshold * 1.8
)
down_regime = (
    close < ema_regime
    and ema_fast_trend < ema_regime
    and trend_slope < -slope_threshold
) or (
    close < ema_regime
    and trend_slope < -slope_threshold * 1.8
)

swept_low = low <= prior_low + atr_value * 0.8 and close > prior_low
swept_high = high >= prior_high - atr_value * 0.8 and close < prior_high
pullback_long = low <= ema_mid_trend + atr_value * 1.35 and close > ema_fast_trend and close > close[1]
pullback_short = high >= ema_mid_trend - atr_value * 1.35 and close < ema_fast_trend and close < close[1]
bullish_reclaim = close > open and rsi_value > rsi_value[1] and close > ema_fast_trend
bearish_rejection = close < open and rsi_value < rsi_value[1] and close < ema_fast_trend

flat = strategy.position_size == 0
cooldown_ok = barssince(strategy.closed_trade) >= cooldown_bars

bottom_setup = (
    flat
    and cooldown_ok
    and up_regime
    and (swept_low or pullback_long)
    and bullish_reclaim
    and rsi_value <= rsi_oversold + 16
    and not is_chop
    and volume_ok
)
top_setup = (
    flat
    and cooldown_ok
    and down_regime
    and (swept_high or pullback_short)
    and bearish_rejection
    and rsi_value >= rsi_overbought - 16
    and not is_chop
    and volume_ok
)

if bottom_setup:
    stop_distance = max(atr_value * atr_stop_multiplier, close * 0.0085)
    strategy.entry(
        direction="long",
        signal_name="Trend Swing Bottom",
        stop_loss=close - stop_distance,
        take_profit=close + stop_distance * take_profit_ratio,
        confidence=min(1, 0.35 + trend_quality * 0.45 + min(0.2, max(0, (rsi_oversold + 16 - rsi_value) / 100))),
        reason="Trend-aligned pullback or liquidity sweep reclaimed above fast trend EMA",
    )

if top_setup:
    stop_distance = max(atr_value * atr_stop_multiplier, close * 0.0085)
    strategy.entry(
        direction="short",
        signal_name="Trend Swing Top",
        stop_loss=close + stop_distance,
        take_profit=close - stop_distance * take_profit_ratio,
        confidence=min(1, 0.35 + trend_quality * 0.45 + min(0.2, max(0, (rsi_value - (rsi_overbought - 16)) / 100))),
        reason="Trend-aligned relief rally or liquidity sweep rejected below fast trend EMA",
    )

plot(ema_regime, color="silver", width=1)
plot(ema_fast_trend, color="red", width=1)
plot(prior_low, color="green", width=1)
plot(prior_high, color="red", width=1)
