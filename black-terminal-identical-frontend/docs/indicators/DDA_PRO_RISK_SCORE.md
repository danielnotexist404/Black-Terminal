# BC-RDA risk score

Native score components are independently normalized to 0–100:

- depth percentile: 45%
- duration percentile: 20%
- worsening-velocity percentile: 15%
- VADD percentile: 10%
- depth severity relative to rolling CDaR95: 10%

Advanced settings expose every weight; the calculation normalizes their sum and defaults total exactly 1. States are Low `<50`, Moderate `50–<75`, High `75–<90`, Extreme `≥90`. Configurable hysteresis (default 2) affects state transitions only. Confidence is displayed separately and never scales the risk score.
