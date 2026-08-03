# Auction Profile Renderer

`AuctionProfileRenderer` owns six Pixi objects: a clip mask, heatmap geometry, histogram geometry, structural zones, key levels, and a pooled text container.

The renderer supports heatmap, histogram, profile columns, contour, node-only, structural-zone, and combined modes. Brightness uses a bounded perceptual alpha transform; it never changes calculations. Off-screen rows are clipped, while the full worker snapshot remains intact. Labels are pooled and only emitted for meaningful visible rows.
