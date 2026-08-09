# BCLIF normalization audit

## Finding

V5 used a causal but short 64-column rolling quantile. It did not literally
normalize every column independently, but it repeatedly forgot older context.
Each local generation could therefore promote its own strongest shelf toward
yellow. The default display then mixed 32% viewport-relative contrast into that
rolling value.

## Corrected policy

V6 uses an expanding causal histogram. Column N is normalized only against
evidence from columns 0..N; older strong context never rolls out. This remains
append-stable and avoids lookahead. Default HYBRID display authority is now:

- 88% expanding model normalization;
- 12% bounded visible-range detail.

`VISIBLE_FOCUS` remains an explicit research option, not the operational
default. `FIXED_ABSOLUTE` remains available. Per-column percentile is computed
only in the 20-cell audit and has no rendering authority.

Browser historical OI-only cells are explicitly ineligible for yellow even if
they are local maxima. Yellow also still requires >=75% cell confidence,
>=80% continuity, a top-tail raw value, and at least two evidence channels.
