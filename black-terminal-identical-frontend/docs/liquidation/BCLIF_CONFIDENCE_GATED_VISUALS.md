# BCLIF Confidence-Gated Visuals

Thermal authority is a conjunction of exposure rank, confidence, continuity, and source composition. The default transformation uses gamma 1.55, a 50th-percentile low anchor, 99.8th-percentile high anchor, confidence weighting, and hybrid global/visible normalization.

Valid low exposure stays visible at a dark purple floor. Missing exposure uses a separate hatch. Cyan/teal/green are progressively stronger valid levels. Yellow is not an ordinary high value: it requires at least 75% cell confidence, valid continuity, at least two meaningful evidence channels when the default gate is active, and membership in the configured extreme 0.1–0.5% tail (0.3% default). Values that fail yellow eligibility are capped below the extreme endpoint.

Historical OI-only context is capped and uses historical opacity. Exact trades, confirmed liquidation calibration, or verified book support can increase live opacity and evidence class. A 50% OI-only field cannot generate yellow under default settings. A fully supported 90% fixture does produce a rare yellow tail; the deterministic contract measured 0.0977% yellow-eligible cells.

Confidence also changes display uncertainty. High-confidence shelves retain precise kernels and narrow operational ranges. Lower-confidence estimates remain wider but fainter. This is a display treatment of existing model uncertainty; it does not mutate the cohort liquidation distribution.
