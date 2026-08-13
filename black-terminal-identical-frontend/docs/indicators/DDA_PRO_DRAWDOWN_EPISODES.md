# DDA Pro drawdown episodes

An episode begins when positive raw depth reaches the configured minimum. The engine records start, deepest trough, duration, recovery duration, area under water (sum of per-bar depth), and recovery. Recovery is confirmed when depth falls below 5% of the episode threshold. Completed episodes are immutable under future appends; active episodes remain developing.

Time Under Water counts confirmed bars since the latest peak. Recovery progress measures the reduction from the active episode’s maximum depth and is separate from the Pine rolling-low recovery formula.
