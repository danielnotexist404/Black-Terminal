# Auction Profile CVD LVN and HVN Detection

A CVD LVN is a local valley in the selected CVD-derived source, subject to percentile and prominence gates. A CVD HVN is a local peak. This is distinct from conventional volume-node detection.

The detector supports percentile, local-minimum, prominence, z-score, adaptive-valley, kernel-smoothed, and hybrid configuration. Candidate rows can merge across a bounded gap. Every zone stores component rows, weighted center, width, raw/normalized score, prominence, creation time, profile version, and lifecycle status.

Directional HVNs are classified buy- or sell-dominant. Low-CVD/high-volume acceptance and high-CVD/low-price-progress interpretations remain analytical context, not deterministic trade signals.
