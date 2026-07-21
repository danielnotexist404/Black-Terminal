# Broker Connection Architecture

Black Terminal clients are control surfaces. They never own unattended execution or persistent broker authentication. The Black Cloud worker owns cloud-delegated connections through server-only credentials, renewable database leases and fencing tokens.

## Lifecycle

`CREATED → VALIDATING → CONNECTED → HEALTHY`. Recoverable failures move through `DEGRADED → RECONNECTING`; terminal validation moves to `FAILED`; authorization removal moves irreversibly to `REVOKED`.

`control_state` is independent of connectivity:

- `ACTIVE`: new authorized commands may execute.
- `PAUSED`: new execution is blocked; streams and reconciliation continue.
- `EMERGENCY_STOP`: new execution is blocked and active mandates are paused; monitoring, existing positions and reconciliation remain intact.

## Ownership and Recovery

Workers discover `CLOUD_DELEGATED` and `HYBRID` records, acquire a per-connection lease and decrypt the credential only for a named operation. Lease takeover increments a fencing token, preventing a stale worker from completing a command. Startup, scheduled and private-event reconciliation restore state from the exchange, which remains authoritative.

Health snapshots record worker identity, latency, private-stream state, reconnect count, staleness and reconciliation status. The UI reads these records through an authenticated API; local React state is not authoritative.

## Security

Only trade/read credentials without withdrawal permission are accepted. AES-256-GCM ciphertext is stored in `broker_secret_vault`; client roles cannot read it. Credential access, connection transitions, controls and failures create redacted audit events.
