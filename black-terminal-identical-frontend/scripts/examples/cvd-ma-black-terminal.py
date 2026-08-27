# CVD MA — Black Terminal vector-runtime conversion
# Converted from the supplied Pine v6 source with the divergence subsystem omitted.
# IMPORTANT: this preserves the source formula. It estimates signed volume from OHLCV
# candle direction/range; it is not exchange-classified aggressive buy/sell CVD.
# Every signal is evaluated causally from the current and completed earlier bars.

# Timeframe-adaptive moving-average lengths
ma_parameters_mode = input.string("Custom", "MA Parameters Mode")
use_long = input.bool(True, "Use Long Settings")
use_short = input.bool(True, "Use Short Settings")
length_long_custom = input.int(55, "Long MA Length")
ma_type_long = input.string("EMA", "Long MA Type")
length_short_custom = input.int(34, "Short MA Length")
ma_type_short = input.string("EMA", "Short MA Type")
length_long2_custom = input.int(89, "Second Long MA Length")
ma_type_long2 = input.string("WMA", "Second Long MA Type")
length_short2_custom = input.int(21, "Second Short MA Length")
ma_type_short2 = input.string("WMA", "Second Short MA Type")

weekly_or_higher = timeframe_seconds >= 604800
daily_only = timeframe_seconds >= 86400 and timeframe_seconds < 604800
four_hour_only = timeframe_seconds >= 14400 and timeframe_seconds < 86400
one_hour_only = timeframe_seconds >= 3600 and timeframe_seconds < 14400
sub_hour = timeframe_seconds < 3600
auto_long1 = 21 * weekly_or_higher + 55 * daily_only + 144 * four_hour_only + 233 * one_hour_only + 55 * sub_hour
auto_long2 = 34 * weekly_or_higher + 89 * daily_only + 233 * four_hour_only + 377 * one_hour_only + 89 * sub_hour
auto_short1 = 13 * weekly_or_higher + 34 * daily_only + 89 * four_hour_only + 144 * one_hour_only + 34 * sub_hour
auto_short2 = 8 * weekly_or_higher + 21 * daily_only + 55 * four_hour_only + 89 * one_hour_only + 21 * sub_hour
use_auto_lengths = ma_parameters_mode == "Auto"
length_long = select(use_auto_lengths, auto_long1, length_long_custom)
length_long2 = select(use_auto_lengths, auto_long2, length_long2_custom)
length_short = select(use_auto_lengths, auto_short1, length_short_custom)
length_short2 = select(use_auto_lengths, auto_short2, length_short2_custom)

# CVD inputs and cumulative series
use_volume_integration = input.bool(False, "Use Volume Integration in CVD")
safe_range = math.max(high - low, 0.000000000001)
normalized_volume_delta = volume * (close - open) / safe_range
integrated_volume_delta = volume * (close - open)
volume_delta = select(use_volume_integration, integrated_volume_delta, normalized_volume_delta)
cvd = ta.cum(nz(volume_delta, 0))
simple_cvd = ta.cum(close - open)

# All five supported MA families are computed causally, then the selected family is used
long_sma = ta.sma(cvd, length_long)
long_ema = ta.ema(cvd, length_long)
long_wma = ta.wma(cvd, length_long)
long_rma = ta.rma(cvd, length_long)
long_hma = ta.hma(cvd, length_long)
short_sma = ta.sma(cvd, length_short)
short_ema = ta.ema(cvd, length_short)
short_wma = ta.wma(cvd, length_short)
short_rma = ta.rma(cvd, length_short)
short_hma = ta.hma(cvd, length_short)
long2_sma = ta.sma(cvd, length_long2)
long2_ema = ta.ema(cvd, length_long2)
long2_wma = ta.wma(cvd, length_long2)
long2_rma = ta.rma(cvd, length_long2)
long2_hma = ta.hma(cvd, length_long2)
short2_sma = ta.sma(cvd, length_short2)
short2_ema = ta.ema(cvd, length_short2)
short2_wma = ta.wma(cvd, length_short2)
short2_rma = ta.rma(cvd, length_short2)
short2_hma = ta.hma(cvd, length_short2)
cvd_ma_long = select(ma_type_long == "SMA", long_sma, select(ma_type_long == "WMA", long_wma, select(ma_type_long == "RMA", long_rma, select(ma_type_long == "HMA", long_hma, long_ema))))
cvd_ma_short = select(ma_type_short == "SMA", short_sma, select(ma_type_short == "WMA", short_wma, select(ma_type_short == "RMA", short_rma, select(ma_type_short == "HMA", short_hma, short_ema))))
cvd_ma_long2 = select(ma_type_long2 == "SMA", long2_sma, select(ma_type_long2 == "EMA", long2_ema, select(ma_type_long2 == "RMA", long2_rma, select(ma_type_long2 == "HMA", long2_hma, long2_wma))))
cvd_ma_short2 = select(ma_type_short2 == "SMA", short2_sma, select(ma_type_short2 == "EMA", short2_ema, select(ma_type_short2 == "RMA", short2_rma, select(ma_type_short2 == "HMA", short2_hma, short2_wma))))

# Dynamic MA clouds
base_cloud_distance = input.float(0.01, "Base Cloud Distance")
use_dynamic_cloud = input.bool(True, "Use Dynamic Cloud Distance")
volatility_period = input.int(14, "Volatility Period")
volatility_lookback = input.int(100, "Volatility Lookback")
cloud_atr_length = input.int(40, "Cloud ATR Length")
current_volatility = ta.atr(volatility_period)
average_volatility = ta.sma(current_volatility, volatility_lookback)
volatility_ratio = current_volatility / nz(average_volatility, current_volatility)
volatility_multiplier = math.max(nz(volatility_ratio, 1), 1)
dynamic_cloud_distance = select(use_dynamic_cloud, base_cloud_distance * volatility_multiplier, base_cloud_distance)
cloud_atr = ta.atr(cloud_atr_length)
upper_cloud_long = cvd_ma_long + dynamic_cloud_distance * cloud_atr
lower_cloud_long = cvd_ma_long - dynamic_cloud_distance * cloud_atr
upper_cloud_short = cvd_ma_short + dynamic_cloud_distance * cloud_atr
lower_cloud_short = cvd_ma_short - dynamic_cloud_distance * cloud_atr

# Rolling CVD channel
show_channel = input.bool(False, "Show Rolling Channel")
channel_method = input.string("Highest/Lowest of CVD", "Channel Method")
channel_window = input.int(200, "Channel Window")
channel_anchor = input.string("Long MA", "Channel Anchor")
stdev_multiplier = input.float(1.0, "Channel Stdev Multiplier")
percentile_value = input.float(95.0, "Channel Percentile")
channel_ma = select(channel_anchor == "Short MA", cvd_ma_short, cvd_ma_long)
cvd_max = ta.highest(cvd, channel_window)
cvd_min = ta.lowest(cvd, channel_window)
channel_half_cvd = math.max(cvd_max - channel_ma, channel_ma - cvd_min)
delta_max = ta.highest(math.abs(volume_delta), channel_window)
channel_half_delta = delta_max * math.sqrt(channel_window)
channel_half_stdev = ta.stdev(cvd, channel_window) * stdev_multiplier
cvd_high_percentile = ta.percentile_linear_interpolation(cvd, channel_window, percentile_value)
cvd_low_percentile = ta.percentile_linear_interpolation(cvd, channel_window, 100 - percentile_value)
channel_half_percentile = math.max(cvd_high_percentile - channel_ma, channel_ma - cvd_low_percentile)
channel_half = select(channel_method == "Highest/Lowest of Delta", channel_half_delta, select(channel_method == "Stdev", channel_half_stdev, select(channel_method == "Percentile", channel_half_percentile, channel_half_cvd)))
upper_level_1 = channel_ma + channel_half * 0.30
upper_level_2 = channel_ma + channel_half * 0.50
upper_level_3 = channel_ma + channel_half * 0.70
lower_level_1 = channel_ma - channel_half * 0.30
lower_level_2 = channel_ma - channel_half * 0.50
lower_level_3 = channel_ma - channel_half * 0.70

# Supertrend-style price-state engine from the source
long_multiplier = input.float(1.5, "Long Multiplier")
long_band_length = input.int(40, "Long Band Length")
short_multiplier = input.float(1.5, "Short Multiplier")
short_band_length = input.int(40, "Short Band Length")
use_dynamic_multiplier = input.bool(True, "Use Dynamic Multiplier")
long_atr = ta.atr(long_band_length)
short_atr = ta.atr(short_band_length)
long_atr_lag = ta.shift(long_atr, 20)
short_atr_lag = ta.shift(short_atr, 20)
long_volatility_factor = long_atr / nz(long_atr_lag, long_atr)
short_volatility_factor = short_atr / nz(short_atr_lag, short_atr)
long_adjusted_multiplier = long_multiplier * math.sqrt(nz(long_volatility_factor, 1))
short_adjusted_multiplier = short_multiplier * math.sqrt(nz(short_volatility_factor, 1))
dynamic_multiplier_long = select(use_dynamic_multiplier, math.min(math.max(long_adjusted_multiplier, long_multiplier * 0.5), long_multiplier * 2), long_multiplier)
dynamic_multiplier_short = select(use_dynamic_multiplier, math.min(math.max(short_adjusted_multiplier, short_multiplier * 0.5), short_multiplier * 2), short_multiplier)
long_band_midpoint = ta.sma(close, long_band_length)
short_band_midpoint = ta.sma(close, short_band_length)
upper_band_long = long_band_midpoint + dynamic_multiplier_long * long_atr
lower_band_long = long_band_midpoint - dynamic_multiplier_long * long_atr
upper_band_short = short_band_midpoint + dynamic_multiplier_short * short_atr
lower_band_short = short_band_midpoint - dynamic_multiplier_short * short_atr
trend_up_long = close > upper_band_long
trend_down_long = close < lower_band_long
trend_up_short = close > upper_band_short
trend_down_short = close < lower_band_short

# Market-state engine
long_state = cvd > cvd_ma_long and cvd > cvd_ma_short
short_state = cvd < cvd_ma_long and cvd < cvd_ma_short
test_long_state = (cvd > cvd_ma_long and cvd < upper_cloud_long) or (cvd < cvd_ma_long and cvd > lower_cloud_long)
test_short_state = (cvd > cvd_ma_short and cvd < upper_cloud_short) or (cvd < cvd_ma_short and cvd > lower_cloud_short)
sideways_state = cvd > lower_level_1 and cvd < upper_level_1

# Black Terminal oscillator-pane plots
show_cvd = input.bool(True, "Show CVD")
show_cloud_boundaries = input.bool(True, "Show Cloud Boundaries")
plot(cvd, title="Cumulative Volume Delta", color="#f4f4f5", width=2, pane="oscillator", visible=show_cvd)
plot(cvd_ma_long, title="CVD MA Long", color="#f4f4f5", width=2, pane="oscillator", visible=use_long)
plot(cvd_ma_long2, title="CVD MA Long 2", color="#8d8d92", width=1, pane="oscillator", visible=use_long)
plot(cvd_ma_short, title="CVD MA Short", color="#c40024", width=2, pane="oscillator", visible=use_short)
plot(cvd_ma_short2, title="CVD MA Short 2", color="#730019", width=1, pane="oscillator", visible=use_short)
plot(upper_cloud_long, title="Upper Cloud Long", color="#d7d7da", width=1, pane="oscillator", visible=use_long and show_cloud_boundaries)
plot(lower_cloud_long, title="Lower Cloud Long", color="#6f6f75", width=1, pane="oscillator", visible=use_long and show_cloud_boundaries)
plot(upper_cloud_short, title="Upper Cloud Short", color="#c40024", width=1, pane="oscillator", visible=use_short and show_cloud_boundaries)
plot(lower_cloud_short, title="Lower Cloud Short", color="#730019", width=1, pane="oscillator", visible=use_short and show_cloud_boundaries)
plot(upper_level_1, title="Channel Up 30%", color="#8d8d92", width=1, pane="oscillator", visible=show_channel)
plot(upper_level_2, title="Channel Up 50%", color="#b8b8bc", width=1, pane="oscillator", visible=show_channel)
plot(upper_level_3, title="Channel Up 70%", color="#f4f4f5", width=1, pane="oscillator", visible=show_channel)
plot(lower_level_1, title="Channel Down 30%", color="#730019", width=1, pane="oscillator", visible=show_channel)
plot(lower_level_2, title="Channel Down 50%", color="#98001f", width=1, pane="oscillator", visible=show_channel)
plot(lower_level_3, title="Channel Down 70%", color="#c40024", width=1, pane="oscillator", visible=show_channel)

# Source-equivalent alerts, firing only on a false-to-true or true-to-false transition
alertcondition(use_long and ta.change(trend_up_long, 1) > 0, "Long Trend Up", "Long trend changed to Up at {{price}}")
alertcondition(use_long and ta.change(trend_down_long, 1) > 0, "Long Trend Down", "Long trend changed to Down at {{price}}")
alertcondition(use_short and ta.change(trend_up_short, 1) > 0, "Short Trend Up", "Short trend changed to Up at {{price}}")
alertcondition(use_short and ta.change(trend_down_short, 1) > 0, "Short Trend Down", "Short trend changed to Down at {{price}}")
alertcondition(ta.change(long_state, 1) > 0, "Enter Long State", "CVD entered Long state at {{price}}")
alertcondition(ta.change(short_state, 1) > 0, "Enter Short State", "CVD entered Short state at {{price}}")
alertcondition(ta.change(test_long_state, 1) > 0, "Enter Test Long State", "CVD is testing the Long cloud at {{price}}")
alertcondition(ta.change(test_short_state, 1) > 0, "Enter Test Short State", "CVD is testing the Short cloud at {{price}}")
alertcondition(ta.change(sideways_state, 1) > 0, "Enter Sideways State", "CVD entered the inner channel zone at {{price}}")
alertcondition(ta.change(long_state, 1) < 0, "Exit Long State", "CVD exited Long state at {{price}}")
alertcondition(ta.change(short_state, 1) < 0, "Exit Short State", "CVD exited Short state at {{price}}")
alertcondition(ta.change(test_long_state, 1) < 0, "Exit Test Long State", "CVD exited the Long cloud test at {{price}}")
alertcondition(ta.change(test_short_state, 1) < 0, "Exit Test Short State", "CVD exited the Short cloud test at {{price}}")
alertcondition(ta.change(sideways_state, 1) < 0, "Exit Sideways State", "CVD exited the inner channel zone at {{price}}")
