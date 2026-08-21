# BC-TERA Operational Runbook

## Start and inspect

1. Run `npm run dev`.
2. Open the indicator library and enable **BC-TERA — Terminal Exhaustion & Reversal Architecture**.
3. Use a chart timeframe at or below the configured BC-TERA decision timeframe.
4. Open the BC-TERA indicator settings from the chart legend.
5. Confirm the status, worker mode, model version, current state, confidence, and unavailable-source list.

Phase I normally shows `DATA_DEGRADED` because only verified partial chart candles are connected. This is expected and safe. Do not lower the confidence gate merely to manufacture a signal.

## Pane interpretation

- blood red: top hazard;
- bright white: bottom hazard;
- amber: data confidence/change-point diagnostic;
- dark crimson: leverage fragility;
- muted gray: unavailable/developing evidence;
- red confirmed marker: confirmed top reversal;
- white confirmed marker: confirmed bottom reversal;
- amber marker: data degradation.

`EXTREME` is not `EXHAUSTED`; `EXHAUSTED` is not `REVERSED`; `REVERSED` is not a safe trade.

## Alert operation

Create a BC-TERA alert in Alert Center and select a specific event or any confirmed event. New/edited alerts arm at the latest already-known event, so historical markers are not replayed. Every alert derives from a plotted confirmed event ID. No provisional event can alert.

## Failure states

- `INSUFFICIENT_DATA`: wait for enough closed decision bars or load longer history.
- `DATA_DEGRADED`: inspect the named unavailable/stale/conflicting families; confirmations are blocked.
- `UNAVAILABLE`: chart resolution is coarser than the selected decision timeframe, candle history is missing, or worker calculation failed.
- Worker fallback `INLINE`: calculation remains bounded but investigate browser worker/CSP support before certification.

On connectivity loss, treat the latest state as stale and non-actionable. Recompute only after a fresh source cutoff/revision arrives.

## Verification

```text
npm run typecheck
npm run test:bc-tera-unit
npm run test:bc-tera-feature
npm run test:bc-tera-provenance
npm run test:bc-tera-change-point
npm run test:bc-tera-hazard
npm run test:bc-tera-state-machine
npm run test:bc-tera-alert-parity
npm run test:bc-tera-prefix
npm run test:bc-tera-settings
npm run test:bc-tera-worker
npm run test:bc-tera-security
npm run benchmark:bc-tera
npm run security:contracts
npm run build
git diff --check
```

Never report a historical/calibration gate as passing until its certified dataset exists and the command actually runs.

