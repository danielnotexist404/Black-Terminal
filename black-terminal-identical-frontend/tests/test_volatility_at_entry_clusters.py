from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "builtin-python-indicators" / "volatility_at_entry_clusters.py"
SPEC = importlib.util.spec_from_file_location("volatility_at_entry_clusters", MODULE_PATH)
vae = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = vae
assert SPEC.loader is not None
SPEC.loader.exec_module(vae)


def cluster(price: float, volume: float):
    return vae.ClusterBucket(
        price=price,
        volume=volume,
        created_at=1,
        updated_at=1,
        last_touched_at=None,
        source_count=1,
        zone_low=price - 0.05,
        zone_high=price + 0.05,
        delta=-volume,
        aggressive_buy_volume=100.0,
        aggressive_sell_volume=200.0,
    )


class VolatilityAtEntryClusterTests(unittest.TestCase):
    def test_pine_compatible_signed_volume(self):
        self.assertEqual(vae.pine_signed_volume(100, 11, 10), -100)
        self.assertEqual(vae.pine_signed_volume(100, 9, 10), 100)
        self.assertEqual(vae.pine_signed_volume(100, 10, 10), 0)

    def test_projection_factors_have_original_grid(self):
        factors = vae.projection_factors(1)
        self.assertEqual(len(factors), 18)
        self.assertEqual(factors[:3], [1.0, 1.5, 2.0])
        self.assertAlmostEqual(factors[-1], (240 ** 0.5) * 2.0)

    def test_projected_level_uses_hlc3_atr_factor_and_signed_direction(self):
        self.assertEqual(vae.projected_level(100, 2, 1.5, -50), 97)
        self.assertEqual(vae.projected_level(100, 2, 1.5, 50), 103)

    def test_volume_distribution_across_eighteen_projected_buckets(self):
        engine = vae.VolatilityAtEntryClusters(
            vae.IndicatorConfig(
                tick_size=0.0001,
                grid_mode="tick",
                use_bid_ask_enhancement=False,
                require_intrabar_for_strong=False,
                required_lookback_bars=0,
            )
        )
        engine.state.previous_close = 100
        engine.state.previous_ltf_close = 100
        bar = {"time": 1, "open": 100, "high": 101, "low": 99, "close": 101, "volume": 1800, "atr_14": 1}
        engine.update(bar, [bar])
        volumes = [bucket.volume for bucket in engine.state.active_clusters.values()]
        self.assertAlmostEqual(sum(volumes), -1800)
        self.assertTrue(all(abs(volume / -100 - round(volume / -100)) < 1e-6 for volume in volumes))
        self.assertLessEqual(len(volumes), 18)

    def test_cluster_removal_counts_negative_volume_as_buy_stops_hit(self):
        engine = vae.VolatilityAtEntryClusters(
            vae.IndicatorConfig(use_bid_ask_enhancement=False, required_lookback_bars=0, require_intrabar_for_strong=False)
        )
        engine.state.active_clusters[100] = cluster(100, -90)
        out = engine.update({"time": 2, "open": 99.5, "high": 100.2, "low": 99.8, "close": 100.1, "volume": 0, "atr_14": 1}, [])
        self.assertEqual(out["buy_stops_hit"], -90)
        self.assertEqual(out["removed_buy_stop_liquidity"], -90)

    def test_cluster_removal_counts_positive_volume_as_sell_stops_hit(self):
        engine = vae.VolatilityAtEntryClusters(
            vae.IndicatorConfig(use_bid_ask_enhancement=False, required_lookback_bars=0, require_intrabar_for_strong=False)
        )
        engine.state.active_clusters[100] = cluster(100, 75)
        out = engine.update({"time": 2, "open": 99.5, "high": 100.2, "low": 99.8, "close": 100.1, "volume": 0, "atr_14": 1}, [])
        self.assertEqual(out["sell_stops_hit"], 75)
        self.assertEqual(out["removed_sell_stop_liquidity"], 75)

    def test_raw_trigger_threshold_matches_pine_inequalities(self):
        engine = vae.VolatilityAtEntryClusters(
            vae.IndicatorConfig(use_bid_ask_enhancement=False, required_lookback_bars=0, require_intrabar_for_strong=False)
        )
        engine.state.buy_stops_history = [0] * 49
        engine.state.sell_stops_history = [0] * 49
        engine.state.active_clusters[100] = cluster(100, -50)
        engine.state.active_clusters[101] = cluster(101, 60)
        out = engine.update({"time": 2, "open": 100, "high": 101.2, "low": 99.8, "close": 100.5, "volume": 0, "atr_14": 1}, [])
        self.assertTrue(out["buy_cluster_trigger_raw"])
        self.assertTrue(out["sell_cluster_trigger_raw"])
        self.assertEqual(out["buy_stops_avg_50"], -1)
        self.assertEqual(out["sell_stops_avg_50"], 1.2)

    def test_nearest_cluster_selection_uses_strong_below_and_above_price(self):
        engine = vae.VolatilityAtEntryClusters(vae.IndicatorConfig(max_zones_per_side=5))
        engine.state.active_clusters[90] = cluster(90, -100)
        engine.state.active_clusters[110] = cluster(110, 100)
        zones = engine._strong_active_zones(engine._merged_active_zones(100, 0.01))
        self.assertEqual(vae.nearest_zone(zones, 100, "buy")["price"], 90)
        self.assertEqual(vae.nearest_zone(zones, 100, "sell")["price"], 110)

    def test_bid_ask_enhanced_mode_uses_negative_delta_as_signed_volume(self):
        engine = vae.VolatilityAtEntryClusters(vae.IndicatorConfig(use_bid_ask_enhancement=True))
        signed, bid_ask = engine._signed_volume(
            {"ask_traded_volume": 140, "bid_traded_volume": 40},
            volume=180,
            close=100,
            previous_close=99,
        )
        self.assertEqual(bid_ask["delta"], 100)
        self.assertEqual(signed, -100)

    def test_strong_delta_plus_cluster_can_emit_strong_signal(self):
        engine = self._primed_enhanced_engine()
        engine.state.active_clusters[99] = cluster(99, -500)
        engine.state.active_clusters[120] = cluster(120, 100)
        intrabar = {
            "time": 50,
            "open": 99.5,
            "high": 100.4,
            "low": 98.8,
            "close": 99.8,
            "volume": 350,
            "atr_14": 1,
            "ask_traded_volume": 20,
            "bid_traded_volume": 180,
            "spread": 0.01,
        }
        out = engine.update({**intrabar, "time": 50}, [intrabar])
        self.assertTrue(out["strong_buy_cluster_trigger"])

    def test_weak_delta_does_not_emit_strong_signal(self):
        engine = self._primed_enhanced_engine()
        engine.state.active_clusters[99] = cluster(99, -500)
        engine.state.active_clusters[120] = cluster(120, 100)
        intrabar = {
            "time": 50,
            "open": 99.5,
            "high": 100.4,
            "low": 98.8,
            "close": 99.8,
            "volume": 350,
            "atr_14": 1,
            "ask_traded_volume": 95,
            "bid_traded_volume": 105,
            "spread": 0.01,
        }
        out = engine.update({**intrabar, "time": 50}, [intrabar])
        self.assertFalse(out["strong_buy_cluster_trigger"])

    def test_cooldown_suppresses_repeated_same_side_signal(self):
        engine = vae.VolatilityAtEntryClusters(vae.IndicatorConfig(signal_cooldown_bars=3))
        self.assertTrue(engine._passes_cooldown("buy", 80))
        engine.state.bar_index += 1
        self.assertFalse(engine._passes_cooldown("buy", 90))
        self.assertTrue(engine._passes_cooldown("buy", 130))

    def test_gap_through_range_triggers_clusters_inside_gap(self):
        engine = vae.VolatilityAtEntryClusters(
            vae.IndicatorConfig(use_bid_ask_enhancement=False, required_lookback_bars=0, require_intrabar_for_strong=False)
        )
        engine.state.previous_high = 100
        engine.state.previous_low = 90
        engine.state.previous_close = 95
        engine.state.active_clusters[102] = cluster(102, -40)
        out = engine.update({"time": 2, "open": 105, "high": 106, "low": 104, "close": 105.5, "volume": 0, "atr_14": 1}, [])
        self.assertEqual(out["buy_stops_hit"], -40)

    def test_noisy_wide_spread_suppresses_strong_signal(self):
        engine = self._primed_enhanced_engine()
        engine.state.active_clusters[99] = cluster(99, -500)
        engine.state.active_clusters[120] = cluster(120, 100)
        intrabar = {
            "time": 50,
            "open": 99.5,
            "high": 100.4,
            "low": 98.8,
            "close": 99.8,
            "volume": 350,
            "atr_14": 1,
            "ask_traded_volume": 20,
            "bid_traded_volume": 180,
            "spread": 0.2,
        }
        out = engine.update({**intrabar, "time": 50}, [intrabar])
        self.assertFalse(out["strong_buy_cluster_trigger"])

    def _primed_enhanced_engine(self):
        engine = vae.VolatilityAtEntryClusters(
            vae.IndicatorConfig(
                use_bid_ask_enhancement=True,
                required_lookback_bars=20,
                require_intrabar_for_strong=True,
                min_strength_to_draw=70,
                min_delta_ratio=0.20,
                tick_size=0.01,
            )
        )
        engine.state.buy_stops_history = [0] * 20
        engine.state.sell_stops_history = [0] * 20
        engine.state.trigger_abs_history = [10] * 20
        engine.state.volume_history = [100] * 20
        engine.state.abs_delta_history = [10] * 20
        engine.state.atr_history = [1] * 20
        engine.state.previous_close = 99.5
        engine.state.previous_ltf_close = 99.5
        return engine


if __name__ == "__main__":
    unittest.main()
