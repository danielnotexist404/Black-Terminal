# BC-QALC Queue Estimation

Initial queue-ahead is `visible quantity at quote price × 1.10`. The 10% buffer is deliberately conservative for hidden/uncertain priority.

Observed cancellations at the exact quote level reduce queue-ahead by only 25% because the feed cannot identify whether cancelled quantity was ahead of or behind the simulated order. Adds do not improve priority.

Queue confidence begins at 0.55 when the quote joins a visible level and 0.25 at a previously empty level. Relevant cancellation ambiguity reduces confidence. Excessive uncertainty is intended to become a no-quote gate during calibration.

This is an estimate, never a claim of actual exchange queue position.
