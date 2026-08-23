# BC-RDA Legacy Repainting Limitations

`BC_RDA_LEGACY_REPAINTING` exists only to preserve visual research continuity and reproduce prior behavior.

It must not be used for:

- alerts or notifications;
- backtest entries/exits or performance metrics;
- Paper or Bybit Demo orders;
- real-funds execution;
- investment-group/copy-trading decisions;
- claims about historical signal availability.

Why: a still-active episode owns one mutable trough. A future deeper drawdown changes the trough index, so the earlier dot disappears and a later historical dot replaces it. The plotted time is selected with future information relative to the displaced bar.

The chart labels this version `LEGACY REPAINTING · RESEARCH ONLY`. Its snapshot integrity fields report failed drift/parity states and `INVALIDATED_REPAINTING_SOURCE`. The alert source returns an empty stream. Strategy Lab omits it, the server rejects crafted definitions, Event Alpha blocks its tactical gate, and the strategy worker degrades any persisted definition that bypassed older controls.

Removing the warning or relabeling the model does not make its historical results valid.
