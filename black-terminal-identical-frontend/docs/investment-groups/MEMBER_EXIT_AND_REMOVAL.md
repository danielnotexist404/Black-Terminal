# Member exit and removal

Pause and leave never require manager approval. The atomic leave function first revokes future-entry authority, cancels queued follower entry plans/commands and records an audit event. Protective orders are not canceled.

Exit choices are detach (default), close now, or leave when flat. Detach immediately removes manager authority while positions remain in the member-owned PositionManager ledger. Leave-when-flat remains `LEAVING` after entry revocation and is finalized automatically when the final attributed PositionManager position closes. Close-now requires a second UI confirmation; when attributable positions exist, the service returns `EXIT_CLOSE_PLAN_REQUIRED` after revocation so a dedicated OMS/EMS close plan can be created rather than calling a broker directly.

Manager removal also revokes future entries, cancels queued entries and detaches open positions. It never force-closes positions and never deletes membership, policy, audit or removal evidence. Removal and group emergency stop require a recent authenticated session.
