# BCLIF confidence-gate contract

Renderer schema V7 uses independent gates.

| Gate | Default | Effect |
| --- | ---: | --- |
| Context Visibility Floor | 25% | Allows estimated OI context to remain visible. |
| Cluster Label Floor | 60% | Controls operational labels and cluster summaries only. |
| High-Authority Color Floor | 75% | Permits green/yellow authority only when evidence rules also pass. |
| Strict Hide-Below | disabled (60%) | Explicit destructive filter; when empty, HUD explains the result. |

At 50–52% Browser Fallback confidence, verified OI context is faint purple/blue, labels are absent by default, and yellow eligibility is exactly zero. Low confidence is never promoted to confirmed color authority. Historical and live-calibrated channels have independent enable switches.

The old minimumConfidence field migrates only to Cluster Label Floor. It no longer controls context visibility or high-authority color. Model, exposure and cohort hashes do not include these presentation controls.
