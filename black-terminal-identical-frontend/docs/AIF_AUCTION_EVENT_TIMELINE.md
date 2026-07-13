# A.I.F. Auction Event Timeline

The timeline is a compact explanation layer below the ordinary chart. Events are deterministic records with ID, time, price, source lens, direction, confidence, node identity, and details.

Supported events include profile calculation, node test/rejection/acceptance, node lifecycle changes, POC/value migration contracts, volatility structure, IMM confluence contracts, absorption candidates, and CHoB candidate/confirmation.

Touches are deduplicated by node and time session. Rejection considers displacement and close outside the zone. Acceptance considers persistence inside the zone. Events below the configured confidence threshold do not advance rejection/acceptance state. Research memory is bounded to 500 events per workspace/symbol and merged by stable event ID.

The timeline is analytical only. Selecting or observing an event cannot submit an order.
