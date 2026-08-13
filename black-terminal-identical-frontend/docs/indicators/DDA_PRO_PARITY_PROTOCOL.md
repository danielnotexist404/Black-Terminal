# DDA Pro parity protocol

Deterministic test order:

1. retain and checksum the MPL Pine source;
2. run source-contract and compatibility fixtures;
3. compare independent Python and TypeScript core outputs at `1e-8` tolerance;
4. run future-append/no-lookahead comparisons;
5. test worker protocol and stale-generation rejection;
6. run statistical invariants and performance benchmarks;
7. compare supplied TradingView golden CSV/JSON and screenshots.

Steps 1–6 have local evidence, including stateful worker protocol transitions and stale-generation suppression. Step 7 is blocked because TradingView goldens were not supplied. Therefore exact Pine parity is `UNVERIFIED`, never inferred from internal agreement.
