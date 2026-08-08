# BCLIF High-Resolution Field

High resolution means specific model distributions on a stable lattice, not a large blurred texture.

The authoritative browser field is bounded by deterministic source history, tick-aware origin/step, and 512–1024 model price rows. Display projection selects adaptive targets up to 1024–2048 Trade Focus rows and 768–1536 Full Spectrum rows, with a 512-row constrained-device fallback. Projection never changes model or exposure identity.

Kernel bandwidth comes from entry dispersion, leverage dispersion, public risk-tier uncertainty, and margin mode. Isolated estimates receive the strongest default contribution (0.82); cross (0.12) and unknown (0.06) remain broader, fainter, and lower-confidence. A low-authority broad kernel cannot acquire a rare yellow core.

Model uncertainty and presentation smoothing are separate. Default display smoothing is 1.15 price rows and 0.55 time columns; `SHARP` bypasses field smoothing. A causal 64-column normalization window uses a fixed-domain rolling histogram, so later columns cannot repaint finalized history and every new segment is not independently promoted.

Projection and upload-ready RGBA creation run in a dedicated worker. The chart thread performs one Pixi `BufferImageSource` update rather than per-cell drawing.
