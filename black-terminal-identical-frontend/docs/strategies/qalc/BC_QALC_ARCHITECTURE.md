# BC-QALC Architecture

```text
Bybit public linear WS (one QALC Research socket per symbol; temporary until the platform-wide raw-event bus exists)
  → canonical QALC event normalization
  → dedupe / event-time guard
  → atomic order-book reconstruction
  → rolling feature engine
  → direction + fill + adverse-selection models
  → account-fee / all-in cost gate
  → Shadow candidate OR conservative Paper broker
  → atomic telemetry state

Canonical events → hourly gzip NDJSON archive + SHA-256 manifest
PostgreSQL       → user configurations, run metadata, archive metadata, audit metadata
```

The Standard VPS baseline is Node 22 because measured internal p99 gates pass. Bybit MMWS/SBE remains a separately gated future deployment; ordinary-account access is never assumed.

The QALC worker contains no exchange order adapter. A future Live chapter must route through OMS → EMS → Black Cloud → provider and is not part of this implementation.

The repository audit found no lossless cross-process raw L2/trade fan-out contract. DOM Pro consumes derived depth memory and BCLIF owns a specialized collector. Consequently this Research capture does not yet satisfy the final platform-wide single-socket target; see `BC_QALC_IMPLEMENTATION_AUDIT.md`.
