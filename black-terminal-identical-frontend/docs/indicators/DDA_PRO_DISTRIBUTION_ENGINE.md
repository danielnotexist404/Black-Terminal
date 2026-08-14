# BC-RDA distribution engine

Native mode maintains an empirical rolling distribution of positive raw depth. Default quantiles use Hyndman–Fan type 7 linear interpolation; nearest-rank is optional. P05/P10/P25/P50/P75/P90/P95/P99 and percentile rank are produced. Classical standardization uses population mean/deviation; robust mode uses median and scaled MAD (`1.4826 × MAD`).

Sorted rolling windows are deterministic and causal. Theme, viewport, dashboard, zoom, and pane height are excluded from calculation hashes.
