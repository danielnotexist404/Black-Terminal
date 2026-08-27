# Auction Profile CVD LVN and HVN Detection

A CVD LVN is a local valley in the selected CVD-derived source, subject to percentile and prominence gates. A CVD HVN is a local peak. This is distinct from conventional volume-node detection.

Gap-aware LVN mode treats a contiguous run of low-activity price rows as one structural auction gap. It compares the complete valley with acceptance rows outside both boundaries, rather than averaging the low rows back into their own reference. `Maximum Valley Activity` limits valley activity relative to that surrounding acceptance, while `Require Acceptance Above + Below` prevents one-sided profile edges from being mislabeled as completed LVNs.

The detector supports percentile, local-minimum, prominence, z-score, adaptive-valley, kernel-smoothed, and hybrid configuration. Candidate rows can merge across a bounded gap. Every zone stores component rows, weighted center, width, raw/normalized score, prominence, creation time, profile version, and lifecycle status. Rendering exposes separate base and strong LVN fill intensities plus the prominence at which a gap receives the full configured color.

Initial Balance is session-defined structure. It is calculated and rendered only for `SESSION`; continuous Composite, Macro Composite, Rolling and anchored ranges do not synthesize an Initial Balance from their first loaded bar.

Directional HVNs are classified buy- or sell-dominant. Low-CVD/high-volume acceptance and high-CVD/low-price-progress interpretations remain analytical context, not deterministic trade signals.
