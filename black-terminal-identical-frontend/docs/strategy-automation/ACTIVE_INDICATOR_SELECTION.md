# Active Indicator Selection

Strategy Lab builds a manifest from chart-visible indicator instances, current settings and configured chart alerts. A binding pins indicator ID, instance ID, version, settings hash, alert-manifest version, runtime version, warmup bars and confirmed-bar semantics.

Built-in strategy templates are deliberately separate from active indicators. Selecting a template never makes it appear to be a chart instance.

Owned custom indicators and unsupported strategies stored by Script Editor appear as `CUSTOM` and remain `REQUIRES_CERTIFICATION`. An owned strategy using the supported Black Script v3 surface may appear eligible in the wizard, but the VPS independently recompiles the pinned source, verifies its source/settings identity and rejects unsupported constructs before a command can be committed. A browser-authored marker alone can never authorize broker execution.

Removing an indicator from the current chart affects only the next editable selection list. A published Paper runtime continues from its pinned immutable definition. Changing the chart timeframe likewise does not change the strategy timeframe.
