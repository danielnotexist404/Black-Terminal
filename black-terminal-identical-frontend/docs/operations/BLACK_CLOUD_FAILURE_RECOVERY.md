# Black Cloud Failure Recovery

## Container or VPS failure

`restart: always` restores the container after process, Docker and host restarts. New entries and server-simulated exits are unavailable while the single VPS is down. Broker-native stop loss, take profit, trailing stop and reduce-only protection remain at Bybit. This is not high availability.

## Private-stream failure

Expected state: `READY → DEGRADED → RECONNECTING → RESYNCHRONIZING → READY`. New automated entries remain blocked until authentication, required subscription acknowledgements and full reconciliation complete. A socket alone is not ready.

## Supabase failure

Do not enter local-only execution mode. Stop new submissions, preserve broker-native protection, degrade health, recover connectivity, then reconcile durable OMS/EMS state before queue consumption resumes.

## Clock unsafe

Confirm `timedatectl`, NTP service health and network reachability to Bybit public time. New signed submissions remain blocked. Never increase the drift threshold merely to hide a broken host clock.

## Lease loss

The stale worker must stop active ownership and fail the pre-broker-call fencing check. Takeover is allowed only after expiry/new fencing generation. Reconcile before resuming. Never update `worker_leases` manually to force a generation.

## Ambiguous submission

Do not retry blindly. Resolve the deterministic client order ID through open orders, order history, executions and private events. Persist `SUBMISSION_OUTCOME_UNKNOWN` until the venue state is known.

## Credential revocation or permission change

Bound reconnects, mark the connection invalid, suspend strategies, preserve audit/history, and ask the user to connect a correctly scoped trade/read credential. Withdrawal or transfer authority remains forbidden.

Every recovery drill must record timestamps, node and instance IDs, lease generations, reconciliation results, duplicate-prevention result and protection state without storing secrets.
