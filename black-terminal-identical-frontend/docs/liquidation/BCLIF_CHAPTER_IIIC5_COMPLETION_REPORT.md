# BCLIF Chapter III-C5 completion report

Status: local implementation and repository certification complete; production publication and authenticated private-session acceptance pending.

- Starting commit: e9edaa11e85195e95480b95ba2949cc12318ae70
- Final commit: recorded as the immutable release SHA in the publication handoff (not embedded here to avoid a self-referential commit)
- Production code commit: 591461d1c09518f8c207f3b9c2b26e3ba0911ba3
- Production deployment: dpl_DCabsvGMHFB9tzqyzZ1JCrhUZKHy · Ready · black-terminal.live
- Production entry asset: assets/index-DwzfyNTc.js · SHA-256 30254903da80112b55cf5dc324c1834f6c5c5e6974b1edcb5ab006b3b802000c
- Production BCLIF worker: assets/displayProjectionWorker-BCHcAaKv.js · SHA-256 4b45e7d2e787c1f4b65e3c7ae71f4cb1d2186df287a1564a2fb43ee682ee90fe
- Exact root cause: healthy V6 exposure was compounded into an operationally transparent texture by legacy shared confidence/evidence/opacity gates; latest-snapshot replay was also absent.
- Original audit: 65,536 model cells, 36,730 non-zero raw cells, 131,072 projected cells, alpha 2/255, effective maximum composite alpha 0.35%.
- Corrected browser visual at 1920×1080: 349,074 raw non-zero and visible cells, alpha non-zero, yellow 0, labels 0, renderer ready.
- Deterministic contract fixture: 574,574 raw non-zero and visible cells; strict 60% filter yields visible 0 and explicit FILTERED_EMPTY.
- Defaults: context 25%, labels 60%, authority color 75%, strict filter disabled.
- Mount race: model-first and renderer-first exposure hashes identical.
- Settings: schema V7; legacy minimum confidence maps only to labels; opacity clamps to at least 10%; legacy giant panels migrate off.
- Checkpoint: public Browser Fallback only, checksum/identity/size/age validated, 24 h / 64 MiB record / 128 MiB total / 3 entries.
- WebGL: context loss/restore browser fixture PASS, replay does not require a new market event.
- HUD: one <=280×64 overlay by default; diagnostic and cluster panels hidden/collapsed.
- GPU preparation/upload: 9.7 ms in the certified 1920×1080 Browser Fallback capture; all 27 captures remained below the 16.7 ms upload threshold.
- Full deterministic fixture reload to visible field: 5.789 s at 1920×1080 (7.675 s at 2560×1440; 17.168 s at 3840×2160). This fixture bypasses IndexedDB and is not evidence of the 1–2 s compatible-checkpoint target.
- Model/exposure invariance: PASS in contract tests.
- Persistent collector: unchanged by this chapter; production deployment/certification remains a separate operational state.
- Execution systems, migrations, collector architecture and cohort mathematics: untouched.

Repository evidence: typecheck PASS; model, operational-clarity, authentic-exposure, live-pipeline, and cold-start contracts PASS; production build/security contracts/security audit PASS; 27/27 repository-owned Brave visual comparisons PASS across 1920×1080, 2560×1440, and 3840×2160. Production publication is complete. Remaining acceptance evidence is the authenticated private/incognito hard-refresh procedure. No production result is claimed prematurely.


## Post-deployment corrective release

A later authenticated production capture identified a separate Browser Fallback starvation path: the public live stream could invalidate every expensive first raster before publication and continuously postpone the debounced refresh. Production-origin network probes and exact bootstrap/model measurements confirmed healthy OI/candle inputs and a valid V6 field; the defect was confined to browser build scheduling.

The correction replaces generation-discard concurrency with a single-flight/coalescing build gate, changes live updates to a throttle, preserves the first completed snapshot, and prevents `LIVE_CALIBRATING` from appearing before a model has published. The focused regression blocks the first build, injects 1,000 live updates, and proves exactly two serial builds with publication order `[1, 2]`. This corrective release changes no exposure mathematics, cohorts, liquidation pricing, absolute grid, authority rules, or persistent collector behavior.


### Corrective production evidence

- Corrective code commit: `972a7fa134d9a8efd9a7451a22f275d4945e9be9`
- Production deployment: `dpl_9Pwm8Td8BwvBxMXNVTpoN2H4ZBup` (`READY`)
- Production URL: `https://black-terminal-gb2jrksew-danielnotexist404s-projects.vercel.app`
- Custom aliases: `https://www.black-terminal.live` and `https://black-terminal.live`
- Production entry: `assets/index-W5SUTd-A.js`; SHA-256 `7d85e902638260b4c15d040cc7844ab2b9f8ca1c9f696a87b1ec1f4424df71f8`
- Browser model worker: `assets/rasterWorker-JlVs_h9Q.js`; SHA-256 `b67c4efd714bbbc804010fc6c17b1386af47be67d83203f0a8081ad4f2d037bb`
- Display projection worker: `assets/displayProjectionWorker-BCHcAaKv.js`; SHA-256 `4b45e7d2e787c1f4b65e3c7ae71f4cb1d2186df287a1564a2fb43ee682ee90fe`
- Production bundle string audit confirms the corrected pre-publication initialization messages and first-raster lifecycle are present on the custom domain.

The custom domain publication and static artifact verification are complete. Final authenticated rendering confirmation remains a user-session acceptance check because production chart access is private.


## Label-only renderer corrective follow-up

The three crimson/white/grey accents reported after the first hotfix are valid operational liquidation-shelf markers, but labels without the thermal field are not an acceptable healthy state. The model snapshot was present; the asynchronous display-projection generation was being invalidated by newer live snapshots before GPU publication. A latest-only single-flight projection queue now publishes completed work, coalesces an arbitrary update flood to one newest follow-up, retains the last same-scope texture during replacement, and rejects stale responses after semantic scope changes.

Focused evidence: 1,000 queued projection updates start only the initial and newest request; a reset-scope response is rejected; the screenshot-scale wide 4H domain retains 566,366 visible cells; Browser Fallback 1920 x 1080 visual comparison is SSIM 1.0 with 349,074 visible cells and WebGL recovery PASS. Model mathematics and authority policy remain unchanged.
