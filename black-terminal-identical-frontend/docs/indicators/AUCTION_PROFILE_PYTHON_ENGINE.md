# Auction Profile Python Engine

`python/black_core_profiles` is the offline/research companion. It provides immutable request/trade/bar models, price grids, CVD, volume, TPO, realized/Parkinson estimators, value area, node detection, profile shape classification, composite assembly, compact float64 serialization, and validation.

Python is intended for 5K–20K historical rebuilds, archived exact trades, backtests, golden fixtures, and research. It is not required for each browser update and never blocks the Pixi render thread.

Run `python3 scripts/auction-profile-python-tests.py` for the standalone validation fixture.
