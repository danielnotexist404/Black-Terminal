# BCLIF Cascade Engine

Forward cascade risk compares the nearest surviving vulnerable cluster with observed same-direction order-book absorption. It reports trigger range, next cluster, forced notional, absorption, estimated slippage, probability, confidence and state. When depth is unavailable, probability is zero and state remains dormant; historical current-book substitution is prohibited.

Status remains `EXPERIMENTAL`/calibration scaffolding. It cannot become `CERTIFIED` until sufficient observed samples, chronological no-lookahead replay, measured precision/recall, absorption accuracy, and stable output evidence exist.
