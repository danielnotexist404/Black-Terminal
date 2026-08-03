# Auction Profile Renderer

`AuctionProfileRenderer` owns six Pixi layers: a clip mask, heatmap geometry, histogram geometry, structural zones, key levels, and a keyed pooled-text container. Stable cell, row, node, and key-level identities prevent unchanged label textures from being rebuilt during live updates.

The renderer supports heatmap, histogram, profile columns, contour, node-only, structural-zone, and combined modes. Brightness uses a bounded perceptual alpha transform; it never changes calculations. Off-screen rows are clipped, while the full worker snapshot remains intact. Labels are pooled and only emitted for meaningful visible rows.

## Dynamic matrix renderer

The heatmap layer now draws sparse time-by-price cells using the chart's shared time and price projections. Historical sessions are appended into the same batch. Display-only row/column strides enforce visible budgets while conserving signed additive values.

Presentation layers are independent:

1. dynamic cell geometry;
2. optional aggregate histogram;
3. optional ranked LVN/HVN zones;
4. restrained POC/VAH/VAL/IB/MID levels;
5. pooled cell and level text;
6. hover inspection.

Hover uses the rendered-cell hit cache and does not create React elements. Macro Structure is the optional aggregate structural view; it no longer forces dynamic cells or full-chart zones into the default.
