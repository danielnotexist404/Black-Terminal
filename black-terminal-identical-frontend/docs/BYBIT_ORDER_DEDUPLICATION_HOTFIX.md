# Bybit Order Deduplication Hotfix

## Root cause

The account-wide `/v5/order/realtime` reader appended every page into an array without tracking processed cursors or venue identities. A repeated cursor/page could therefore publish the same order more than once. Downstream identity implementations also omitted either venue or connection, creating inconsistent boundaries.

## Correction

- REST pagination tracks every cursor and stops on repetition.
- Each page is merged into a category/order-ID map using venue update time.
- The account snapshot performs a second cross-result canonical merge.
- Reconciliation assigns the complete canonical key and source/version metadata.
- Portfolio API, Black Core store, Orders table and chart use the same key.
- Older REST data cannot overwrite a newer private-stream update.
- Diagnostics expose raw, unique, duplicate, stale-update and repeated-cursor counts.

Verified-empty safety is unchanged: an incomplete category snapshot cannot erase the last verified account state.

