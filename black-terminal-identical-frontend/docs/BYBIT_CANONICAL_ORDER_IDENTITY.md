# Bybit Canonical Order Identity

One venue order is identified by:

`network : connectionId : venue : category : venueOrderId`

For example: `mainnet:connection-uuid:bybit:linear:177000123456789`.

`venueOrderId` is authoritative. `orderLinkId`, source type, timestamps, symbol and price are attributes, never identity. Account and network remain part of the key so separate connections cannot contaminate each other.

The browser order store is a `Map` keyed by this value. Snapshot, private-stream and manual-refresh records are UPSERTs. An update replaces current state only when its venue version is newer, or when equal-version lifecycle precedence is not older. Presentation arrays are derived from the map and receive a final safety deduplication.

Terminal orders leave active state only after a canonical venue terminal event or a verified replacement snapshot. A cancel request is not itself a terminal event.

