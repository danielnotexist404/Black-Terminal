# Auction Profile Shape Restoration

## Corrected product boundary

The Auction Profile is a **range × price** distribution. For every price row `p` in the selected scope `R`, Black Core aggregates the selected metric across the complete range and emits one horizontal row:

```text
profile[p] = aggregate(metric(event), event.price ∈ p, event.time ∈ R)
```

It is not a candle-by-candle matrix. The previously deployed time × price cells are preserved as the separate **CVD Footprint** renderer and replace the old synthetic Volume Footprint chart type.

## Default topology

The default is Auction Profile → Bidirectional Delta → Right → Net CVD. Negative rows grow left from a stable centerline in blood red. Positive rows grow right in silver/white. Neutral rows remain dark gray. The default is one unified profile; time segmentation is optional.

Supported geometries are Bidirectional Delta, Absolute Width with Directional Color, Positive/Negative Split, Mirrored, Single-Sided Right, Single-Sided Left, and Centered. Placement supports Right, Left, Overlay, Inside Range, and a detached right profile rail.

## Scope semantics

- Session: one developing/finalized profile per session.
- Fixed Start: one profile from the selected start through the developing edge.
- Rolling/Visible/Manual: one profile for that selected range.
- Composite/Periodic/Macro: one unified profile per resolved composite range.

Camera movement does not alter calculation data except when Visible Range or Visible Pixel Adaptive is explicitly selected.

## Structure and live behavior

POC, VAH, VAL, IB, LVN, and HVN are constrained to the profile boundary. Minimal defaults cap LVN and HVN context at three each. Classified live trades update their price row through the existing incremental worker path; finalized history remains frozen.

## Renderer isolation

`AuctionProfileRenderer` consumes aggregate `snapshot.rows` and has renderer contract `RANGE_PRICE_PROFILE`. `CvdFootprintRenderer` consumes `snapshot.matrix.cells` and has renderer contract `TIME_PRICE_FOOTPRINT`. Neither renderer delegates drawing to the other.

## Certification

`npm run test:auction-profile` certifies aggregate shape, signed geometry, time-segment opt-in, renderer separation, conservation, stable history, worker incrementality, and exact/mixed provenance. `npm run benchmark:auction-profile` covers 100 through 20,000 bars and up to 2,029 deterministic rows.
