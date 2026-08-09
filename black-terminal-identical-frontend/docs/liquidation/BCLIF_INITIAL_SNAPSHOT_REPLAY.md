# BCLIF initial snapshot replay

InMemoryBclifSnapshotStore retains exactly one compatible completed V6 snapshot.

- subscribe() registers the handler and synchronously replays the latest snapshot;
- publish() rejects incompatible model versions and stale generated/cutoff order;
- publish() assigns monotonic model/exposure generations;
- clear() is scoped to indicator identity changes or an authoritative empty result;
- model-first and renderer-first initialization produce the same exposure hash.

PixiBlackChart subscribes immediately after the chart engine is initialized. It also checks the retained snapshot before starting a replacement controller. The renderer therefore does not depend on a future trade, OI update or one-shot worker event.

Generation diagnostics expose latest model generation, latest rendered generation and lag. Steady-state lag is zero.
