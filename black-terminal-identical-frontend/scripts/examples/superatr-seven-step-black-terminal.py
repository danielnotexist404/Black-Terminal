# SuperATR 7-Step Profit - Strategy [presentTrading]
# Complete Black Script v3 conversion of the supplied Pine Script v5 strategy.
#
# Runtime contract:
# - Calculations use finalized, append-only chart candles.
# - Saving/running this file in Script Editor performs deterministic simulation only.
# - After it is saved as a Strategy, Strategy Lab recognizes this exact source as
#   the certified native SuperATR 7-Step runtime for Paper, Bybit and Investment
#   Group execution. Broker sizing/leverage remain controlled by Execution Desk.
# - The original Pine strategy does not define a stop loss. This conversion does
#   not invent one.

strategy(
    initial_capital=10000,
    default_qty_type=strategy.percent_of_equity,
    default_qty_value=10,
    commission_type=strategy.commission.percent,
    commission_value=0.1,
    slippage=1,
    pyramiding=1,
    process_orders_on_close=True
)

# -----------------------------------------------------------------------------
# Inputs - Pine defaults preserved exactly
# -----------------------------------------------------------------------------

short_period = input.int(3, "Short Period", minval=1, step=1, group="Signal Engine")
long_period = input.int(7, "Long Period", minval=1, step=1, group="Signal Engine")
momentum_period = input.int(7, "Momentum Period", minval=1, step=1, group="Signal Engine")
atr_sma_period = input.int(7, "ATR SMA Period for Confirmation", minval=1, step=1, group="Signal Engine")
trend_strength_threshold = input.float(1.618, "Trend Strength Threshold", minval=0.0, step=0.1, group="Signal Engine")

useMultiStepTP = input.bool(True, "Enable Multi-Step Take Profit", group="Seven-Step Take Profit")
atrLengthTP = input.int(14, "ATR Length for Take Profit", minval=1, step=1, group="Seven-Step Take Profit")
atrMultiplierTP1 = input.float(2.618, "ATR Multiplier for TP Level 1", minval=0.1, step=0.1, group="Seven-Step Take Profit")
atrMultiplierTP2 = input.float(5.0, "ATR Multiplier for TP Level 2", minval=0.1, step=0.1, group="Seven-Step Take Profit")
atrMultiplierTP3 = input.float(10.0, "ATR Multiplier for TP Level 3", minval=0.1, step=0.1, group="Seven-Step Take Profit")
atrMultiplierTP4 = input.float(13.82, "ATR Multiplier for TP Level 4", minval=0.1, step=0.1, group="Seven-Step Take Profit")
tp_level_percent1 = input.float(3.0, "Fixed TP Level 1 (%)", minval=0.1, step=0.1, group="Seven-Step Take Profit")
tp_level_percent2 = input.float(8.0, "Fixed TP Level 2 (%)", minval=0.1, step=0.1, group="Seven-Step Take Profit")
tp_level_percent3 = input.float(17.0, "Fixed TP Level 3 (%)", minval=0.1, step=0.1, group="Seven-Step Take Profit")
tp_percent_atr = input.float(10.0, "Percentage to Exit at Each ATR TP Level", minval=0.1, maxval=100.0, step=0.1, group="Seven-Step Take Profit")
tp_percent_fixed = input.float(10.0, "Percentage to Exit at Each Fixed TP Level", minval=0.1, maxval=100.0, step=0.1, group="Seven-Step Take Profit")

# -----------------------------------------------------------------------------
# Indicator calculations
# -----------------------------------------------------------------------------

# Pine calculate_true_range(): max(high-low, abs(high-prev_close), abs(low-prev_close))
prev_close = close[1]
tr1 = high - low
tr2 = math.abs(high - prev_close)
tr3 = math.abs(low - prev_close)
true_range = math.max(tr1, math.max(tr2, tr3))

# Pine momentum normalization. nz() is used only to make the warm-up behavior
# explicit in Black Script; valid post-warm-up values are mathematically equal.
momentum = close - close[momentum_period]
stdev_close = ta.stdev(close, momentum_period)
stdev_close_safe = nz(stdev_close, 0)
normalized_momentum = select(stdev_close_safe != 0, momentum / stdev_close_safe, 0)
momentum_factor = math.abs(normalized_momentum)

# The signal ATRs intentionally use SMA, matching the Pine source.
short_atr = ta.sma(true_range, short_period)
long_atr = ta.sma(true_range, long_period)
adaptive_atr = (short_atr * momentum_factor + long_atr) / (1 + momentum_factor)

price_change = close - close[momentum_period]
adaptive_atr_safe = nz(adaptive_atr, 0)
atr_multiple = select(adaptive_atr_safe != 0, price_change / adaptive_atr_safe, 0)
trend_strength = ta.sma(atr_multiple, momentum_period)

short_ma = ta.sma(close, short_period)
long_ma = ta.sma(close, long_period)

bullish_trend = short_ma > long_ma and trend_strength > trend_strength_threshold
bearish_trend = short_ma < long_ma and trend_strength < -trend_strength_threshold
trend_signal = select(bullish_trend, 1, select(bearish_trend, -1, 0))

adaptive_atr_sma = ta.sma(adaptive_atr, atr_sma_period)
long_confirmed = trend_signal == 1 and close > short_ma and adaptive_atr > adaptive_atr_sma
short_confirmed = trend_signal == -1 and close < short_ma and adaptive_atr > adaptive_atr_sma
trend_confirmed = long_confirmed or short_confirmed

long_entry = trend_confirmed and trend_signal == 1
short_entry = trend_confirmed and trend_signal == -1
long_exit = strategy.position_size > 0 and short_entry
short_exit = strategy.position_size < 0 and long_entry

# -----------------------------------------------------------------------------
# Trading logic
# -----------------------------------------------------------------------------

strategy.entry("Long Entry", strategy.long, when=long_entry)
strategy.entry("Short Entry", strategy.short, when=short_entry)
strategy.close("Long Entry", when=long_exit)
strategy.close("Short Entry", when=short_exit)

# Pine ta.atr() is Wilder RMA ATR. Black Script ta.atr() has the same contract.
atrValueTP = ta.atr(atrLengthTP)

tp_priceATR1_long = strategy.position_avg_price + atrMultiplierTP1 * atrValueTP
tp_priceATR2_long = strategy.position_avg_price + atrMultiplierTP2 * atrValueTP
tp_priceATR3_long = strategy.position_avg_price + atrMultiplierTP3 * atrValueTP
tp_priceATR4_long = strategy.position_avg_price + atrMultiplierTP4 * atrValueTP
tp_pricePercent1_long = strategy.position_avg_price * (1 + tp_level_percent1 / 100)
tp_pricePercent2_long = strategy.position_avg_price * (1 + tp_level_percent2 / 100)
tp_pricePercent3_long = strategy.position_avg_price * (1 + tp_level_percent3 / 100)

tp_priceATR1_short = strategy.position_avg_price - atrMultiplierTP1 * atrValueTP
tp_priceATR2_short = strategy.position_avg_price - atrMultiplierTP2 * atrValueTP
tp_priceATR3_short = strategy.position_avg_price - atrMultiplierTP3 * atrValueTP
tp_priceATR4_short = strategy.position_avg_price - atrMultiplierTP4 * atrValueTP
tp_pricePercent1_short = strategy.position_avg_price * (1 - tp_level_percent1 / 100)
tp_pricePercent2_short = strategy.position_avg_price * (1 - tp_level_percent2 / 100)
tp_pricePercent3_short = strategy.position_avg_price * (1 - tp_level_percent3 / 100)

long_tp_active = useMultiStepTP and strategy.position_size > 0
short_tp_active = useMultiStepTP and strategy.position_size < 0

# Long TP1-TP7
strategy.exit("TP1 Long", "Long Entry", qty_percent=tp_percent_atr, limit=tp_priceATR1_long, when=long_tp_active)
strategy.exit("TP2 Long", "Long Entry", qty_percent=tp_percent_atr, limit=tp_priceATR2_long, when=long_tp_active)
strategy.exit("TP3 Long", "Long Entry", qty_percent=tp_percent_atr, limit=tp_priceATR3_long, when=long_tp_active)
strategy.exit("TP4 Long", "Long Entry", qty_percent=tp_percent_atr, limit=tp_priceATR4_long, when=long_tp_active)
strategy.exit("TP5 Long", "Long Entry", qty_percent=tp_percent_fixed, limit=tp_pricePercent1_long, when=long_tp_active)
strategy.exit("TP6 Long", "Long Entry", qty_percent=tp_percent_fixed, limit=tp_pricePercent2_long, when=long_tp_active)
strategy.exit("TP7 Long", "Long Entry", qty_percent=tp_percent_fixed, limit=tp_pricePercent3_long, when=long_tp_active)

# Short TP1-TP7
strategy.exit("TP1 Short", "Short Entry", qty_percent=tp_percent_atr, limit=tp_priceATR1_short, when=short_tp_active)
strategy.exit("TP2 Short", "Short Entry", qty_percent=tp_percent_atr, limit=tp_priceATR2_short, when=short_tp_active)
strategy.exit("TP3 Short", "Short Entry", qty_percent=tp_percent_atr, limit=tp_priceATR3_short, when=short_tp_active)
strategy.exit("TP4 Short", "Short Entry", qty_percent=tp_percent_atr, limit=tp_priceATR4_short, when=short_tp_active)
strategy.exit("TP5 Short", "Short Entry", qty_percent=tp_percent_fixed, limit=tp_pricePercent1_short, when=short_tp_active)
strategy.exit("TP6 Short", "Short Entry", qty_percent=tp_percent_fixed, limit=tp_pricePercent2_short, when=short_tp_active)
strategy.exit("TP7 Short", "Short Entry", qty_percent=tp_percent_fixed, limit=tp_pricePercent3_short, when=short_tp_active)

# -----------------------------------------------------------------------------
# Price-scale plots and confirmed alerts
# -----------------------------------------------------------------------------

plot(short_ma, title="Short MA", color="#f4f4f5", width=1)
plot(long_ma, title="Long MA", color="#ff174a", width=1)

alertcondition(long_entry, "SuperATR Long Entry", "Confirmed SuperATR LONG at {{price}}")
alertcondition(short_entry, "SuperATR Short Entry", "Confirmed SuperATR SHORT at {{price}}")
