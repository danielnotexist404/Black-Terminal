# Member portfolio visibility

Members select one of three consent levels: group-originated data only, group positions plus account risk summary, or the full selected broker-account portfolio.

Managers always receive group-attributed positions, mandate state, effective allocated equity, risk-limit state, connection health and execution failures. Account-wide unrelated data is returned only for `FULL_SELECTED_ACCOUNT`. The EMS may use the minimum account-risk information required for server-side validation even when the manager UI receives a narrower view.

No response includes API keys/secrets, secret references, wallet private material, withdrawal addresses, service-role keys or session tokens. RLS and server authorization enforce the boundary; frontend hiding is not considered authorization.
