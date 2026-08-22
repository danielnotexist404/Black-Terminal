# Active Indicator Selection

Strategy Lab builds a manifest from chart-visible indicator instances, current settings and configured chart alerts. A binding pins indicator ID, instance ID, version, settings hash, alert-manifest version, runtime version, warmup bars and confirmed-bar semantics.

Built-in strategy templates are deliberately separate from active indicators. Selecting a template never makes it appear to be a chart instance.

Owned custom indicators stored by Script Editor appear as `CUSTOM`, including alert-condition names that can be parsed from their source. They remain `REQUIRES_CERTIFICATION`; a browser-authored marker cannot self-certify a VPS runtime. Publishing fails closed until a server-controlled runtime and manifest are certified.

Removing an indicator from the current chart affects only the next editable selection list. A published Paper runtime continues from its pinned immutable definition. Changing the chart timeframe likewise does not change the strategy timeframe.
