# BCLIF Visual Certification

`scripts/bclif-visual-regression.js` is the repository-owned Playwright path. It uses a deterministic fixture, fixed clock/camera/palette, and viewports 1920×1080, 2560×1440, and 3840×2160. It must record actual screenshots and comparison evidence; absent Playwright/browser/goldens is a truthful `SKIPPED`, never an invented pass.

The harness checks a continuous texture without cell borders or histogram plates, reference thermal distribution, crisp candles above the field, correct pan/zoom attachment, explicit gap texture, and compact always-visible authority. Golden updates require an explicit environment flag. Actual screenshots and comparison artifacts live under `tests/.artifacts/bclif`; approved baselines and their manifest live under `tests/golden/bclif`.

Live manual evidence must record symbol, timeframe, horizon, terminal timestamp, authority/node, coverage, model/tile versions, palette, renderer settings, and screenshot. Secrets and raw private object paths are prohibited.

Current Chapter III-C result: `BLOCKED / NOT RUN AFTER V2_HIRES CHANGE`. Headless Brave launch was unavailable because the Codex account usage limit rejected the required launch approval. The 1920×1080, 2560×1440, and 3840×2160 baselines are explicitly marked `STALE_REGENERATION_REQUIRED`; screenshot, SSIM, and perceptual-delta certification are therefore not claimed. A normal comparison invocation returns a structured `SKIP` until an explicitly reviewed golden regeneration succeeds.
