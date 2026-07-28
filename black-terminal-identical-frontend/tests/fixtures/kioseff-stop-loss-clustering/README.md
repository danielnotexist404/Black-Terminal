# Kioseff Stop Loss Clustering fixtures

Fixtures in this directory are calculation inputs, not screenshots. Every fixture must conform to
`schema.json` and must identify its certification level:

- `structural`: authored to test deterministic invariants and edge cases;
- `provisional`: captured market data without approved TradingView expected output;
- `tradingview-certified`: contains approved TradingView canonical snapshots.

An unavailable TradingView reference is represented explicitly:

```json
{
  "status": "unavailable",
  "provider": null,
  "exportedAt": null,
  "snapshots": [],
  "currentBarRevisions": [],
  "notes": ["Parity certification pending reference export"]
}
```

Never populate expected snapshots from the Black Terminal engine itself and call them TradingView
reference data. Structural expected results must be labeled as structural invariants.

Time values normalized for calculation are integer Unix seconds. `originalTime` preserves the exact
source representation. Prices and volumes remain numeric fixture observations; authoritative
`tickSize` remains a decimal string.

