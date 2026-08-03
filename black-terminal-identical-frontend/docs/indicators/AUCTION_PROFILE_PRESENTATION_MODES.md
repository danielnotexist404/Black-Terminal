# Auction Profile Presentation Modes

Scope selects the calculated data. Presentation selects how that data is drawn. They are independent.

| Presentation | Matrix | Aggregate | Nodes | Key levels |
| --- | ---: | ---: | ---: | ---: |
| Dynamic Blocks | yes | no | no | no |
| Aggregate Histogram | no | yes | no | yes |
| Structural Nodes | no | no | opt-in | no |
| Dynamic Blocks + Key Levels | yes | no | opt-in | yes |
| Dynamic Blocks + Aggregate | yes | yes | opt-in | yes |
| Macro Structure | no | yes | opt-in | yes |

The default is Dynamic Blocks + Key Levels. Node overlays remain absent until LVN/HVN visibility is explicitly enabled.

## Presets

- Original Pine: Pine Compatibility, Session, CVD Pine Compatible, Dynamic Blocks, values always on.
- Black Terminal CVD Session: Native, Session, Real CVD, Dynamic Blocks + Key Levels.
- CVD Macro Matrix: Native, 5,000-bar Macro Composite, adaptive blocks, Dynamic + minimal LVN/HVN structure.
- Auction Macro Structure: Native, 20,000-bar Macro Composite, optional aggregate structural presentation.
- TPO Session: Session TPO using the same block renderer.

## Session

All sessions in the selected lookback are retained as independent snapshots with independent matrix, POC, value area, and IB. Completed sessions are frozen; the current session retains one developing final column.

## Composite and macro

Rolling, Composite, and Macro Composite can all use Dynamic Blocks. Aggregate is never implied by scope. Adaptive block resolution bounds column count deterministically while retaining block semantics.
