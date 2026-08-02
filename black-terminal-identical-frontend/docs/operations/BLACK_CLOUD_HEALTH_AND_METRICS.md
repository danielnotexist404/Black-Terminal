# Black Cloud Health and Metrics

Endpoints are bound through Docker to `127.0.0.1` by default.

- `/health/live`: process responsiveness only; one broken connection does not fail liveness.
- `/health/ready`: Supabase, node identity, crypto self-test, schema, vault, lease, queue, safe clock, fresh loop and non-draining state.
- `/metrics`: Prometheus text, localhost/private access only.

The persistent node row is considered stale after 45 seconds. The authenticated frontend status route changes a stale historical `READY` record to `OFFLINE`; it does not expose hostname, IP, service credentials, vault keys or raw crypto state.

Key metrics include worker uptime/readiness, node heartbeat age, clock drift/safety, in-flight commands, active/ready/degraded connections, private-stream age, reconnects, active strategies, queue depth/age, command success/failure, lease contention and unknown submission outcomes. Metrics do not contain credentials, signed requests or authorization headers.

Checks:

```bash
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/metrics
```

`CLOCK_UNSAFE` is critical: new broker submissions stop, readiness becomes false, the node becomes degraded, and an audit event is emitted. Reconciliation remains active. If no external paging integration exists, alerts remain visible only inside Black Terminal and logs; do not describe that as 24/7 paging.

Resource and capacity baselines must be measured on the real VPS under idle, connection, reconciliation, controlled strategy and restart workloads. Until measured, capacity is `UNKNOWN`, not institutional scale.
