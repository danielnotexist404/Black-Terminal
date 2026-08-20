# Operations

Daily checks:

- all required containers healthy and restart count stable;
- Auth/REST/Storage and API readiness responding;
- database connections, disk, WAL and table growth within bounds;
- worker heartbeat, queue age, failed/retried job counts and lease health;
- Event Alpha processing/rejection state and both live-execution kill switches;
- backup age, Restic integrity and off-host reachability;
- TLS expiry and Caddy errors.

Prometheus, Grafana, cAdvisor, node exporter and Postgres exporter are defined in `docker-compose.monitoring.yml`. Their host bindings remain loopback/private. Alert rules cover service availability, restarts, CPU, memory, disk and backup age; application-specific metrics should be expanded as each worker exposes its stable metric contract.

After a database restore, password rotation or Supabase reinitialization, synchronize the private exporter credential before recreating the exporter:

```bash
infra/black-cloud/scripts/synchronize-monitoring-database-secret.sh
docker compose --env-file infra/black-cloud/.env \
  -f infra/black-cloud/docker-compose.monitoring.yml \
  up -d --force-recreate postgres-exporter
```

The synchronizer updates the mode-600 monitoring environment atomically and never prints the password. Verify both the exporter target and `pg_up`—an HTTP-up exporter with `pg_up == 0` is a database-monitoring failure and must remain alerting.

For incidents, capture `docker compose ps`, bounded service logs, host listeners, disk/memory, release SHA and current feature gates. Redact tokens and never paste environment files into tickets.

The VPS is not host-level HA. Off-host backups and a rehearsed replacement-host restore are the recovery mechanism.
