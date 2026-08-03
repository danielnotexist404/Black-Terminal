# Original CVD Profile Pine Audit

Source: `reference/pine/cvd-profile-v6.pine` (Pine v6, retained unchanged).

The script requests lower-timeframe volume multiplied by close-to-close direction, accumulates it as CVD, distributes each signed lower-timeframe observation uniformly from low row to high row, and uses total distributed absolute volume for POC/value area. Regular mode gates to the current day; Fixed Start begins at the selected timestamp. It renders block history, POC, VAH/VAL, midpoint, initial balance, and CVD delta/acceleration.

Material anomalies are documented in `AUCTION_PROFILE_PINE_COMPATIBILITY.md`. They are isolated to compatibility mode. Black Core Native replaces neither the source file nor its named behavior; it is a separate, versioned implementation.
