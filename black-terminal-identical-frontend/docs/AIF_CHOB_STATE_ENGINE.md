# A.I.F. CHoB State Engine

CHoB means Change of Behavior. It is an explicit state machine, not a label attached to any second touch.

Lifecycle:

`UNTESTED -> FIRST_TEST -> FIRST_REJECTION -> INTERMEDIATE_SWING -> RETEST -> SECOND_REJECTION -> CHOB_CANDIDATE -> CHOB_CONFIRMED`

Terminal and exception states include `ACCEPTED`, `BROKEN`, `INVALIDATED`, `EXPIRED`, `INSUFFICIENT_SWING`, and `SECOND_TEST_FAILED`.

A candidate requires a qualified second rejection after an intermediate excursion. Confirmation additionally requires interaction with the recorded swing reference. Candidate and confirmed events are marked experimental in the timeline because candle-range input cannot reconstruct intrabar path exactly.
