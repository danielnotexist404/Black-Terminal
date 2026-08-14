# BC-RDA Python engine

The auditable reference package is `python/black_core_indicators/dda_pro`. `engine.py` implements compatibility/native source kernels; `__main__.py` provides a JSON test interface. The production browser currently executes the deterministic TypeScript mirror in `src/modules/dda-pro/core` through a Web Worker; no server Python sidecar deployment is claimed.

The automated parity gate compares raw drawdown, smoothed drawdown, positive depth, percentile rank, and P95 with `1e-8` tolerance. Full cross-language parity for every expanded performance metric remains a completion limitation and is not silently claimed.
