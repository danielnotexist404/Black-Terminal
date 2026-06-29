# Black-Terminal Identical Frontend Starter

This version removes TradingView Lightweight Charts and uses a custom GPU-rendered chart engine built on PixiJS.

## Workspace docs

- `docs/PROJECT_BRIEF.md` - product direction and principles
- `docs/ARCHITECTURE.md` - current structure and target architecture
- `docs/EXCHANGE_AUTOMATION.md` - exchange data, trading, and webhook strategy plan
- `docs/WORKSPACE.md` - local setup, commands, and directory guide
- `docs/PYTHON_INDICATORS.md` - draft Python indicator contract
- `docs/ROADMAP.md` - suggested milestone sequence

## Why this version

- React is only the UI shell.
- The chart itself is custom rendered through PixiJS.
- Candles, grid, volume, indicators, heatmap, watermark, axes, and crosshair are separate draw layers.
- This is a better foundation for a Quantower / Bookmap style terminal than a prebuilt chart widget.

## Install

```bash
npm install
npm run dev
```

## Run Tauri desktop shell

```bash
npm run tauri:dev
```

## Check workspace

```bash
npm run check
```

## Build Windows EXE

```bash
npm run tauri:build
```

## Included custom engine files

```text
src/chart-engine/BlackChartEngine.ts
src/chart-engine/types.ts
src/chart-engine/data/CandleBuffer.ts
src/components/PixiBlackChart.tsx
```

## Controls

- Mouse drag: pan chart
- Mouse wheel: horizontal scroll
- Ctrl + mouse wheel: zoom candle width
- Move mouse: crosshair

## Webhooks

Set a webhook URL:

```js
localStorage.setItem("bt_webhook_url", "https://your-webhook-url.com/alert")
```

The mock feed randomly triggers alert events and sends them through the Tauri Rust command.

## Next upgrades

1. Replace mock feed with Binance/Bybit/OKX WebSocket stream.
2. Add worker/Rust-side candle aggregation.
3. Add typed-array buffers for millions of points.
4. Add WebGL geometry batching for candles.
5. Add orderbook heatmap and replay.
6. Add footprint / volume delta layer.
7. Add indicator plugin loader.
8. Add alert condition builder.


## v0.3 concept-matching update

This package is closer to the AI concept mockup:

- richer price axis and USDT label
- bottom time axis labels
- current price label
- crosshair price/time badges
- heatmap level labels: Strong High, Weak Low, Strong Low
- bottom chart range controls
- BT chart badge
- floating indicator toolbar
- more polished shadows, dividers, hover rows, and panel spacing

It still is not a pixel-perfect clone of the image because the image was an AI-generated mockup, but this is the closest practical coded frontend foundation.
