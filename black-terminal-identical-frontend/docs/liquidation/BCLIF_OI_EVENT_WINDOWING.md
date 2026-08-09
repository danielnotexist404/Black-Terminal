# BCLIF OI event windowing

V5 created a paired cohort family for every independently material positive
five-minute OI point. That was deterministic but fragmented one position
opening episode into a ladder of short shelves.

V6 uses a canonical causal event window shared by browser and collector code:

| Parameter | Default |
| --- | ---: |
| Maximum event window | 15 minutes |
| Continuation floor | 35% of current materiality threshold |
| Termination floor | 25% of current materiality threshold |
| Quiet hysteresis | 2 OI intervals |

A material positive point starts the event. Related positive points extend it
and add delta-weighted entry observations. The event closes on the maximum
window, two terminating observations, or before a material contraction. One
event creates one long and one short gross hypothesis. A contraction only
removes mass; it never creates a shelf.

Pending window state is JSON-safe and part of the shared cohort checkpoint.
Bounded replay may explicitly flush its causal prefix; live collection normally
lets timeout/hysteresis close it. The maximum observation list is 256.

The regression fixture proves three related positive observations produce one
family (two side hypotheses), not six cohorts.
