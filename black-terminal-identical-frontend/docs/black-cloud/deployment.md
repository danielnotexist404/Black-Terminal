# Deployment

All target services run in Docker. The Ubuntu host provides only Docker, SSH, firewalling, fail2ban and unattended security updates.

Staging:

```bash
export BLACK_CLOUD_SSH_TARGET='tony@<vps-address>'
export BLACK_CLOUD_SSH_IDENTITY='/absolute/path/to/the/dedicated-ssh-key'
infra/black-cloud/scripts/sync-release-to-vps.sh <exact-git-sha>

# On the VPS:
cd /opt/black-cloud/releases/<exact-git-sha>
infra/black-cloud/scripts/preflight.sh staging
infra/black-cloud/scripts/deploy-staging.sh
# Restore and verify data before application startup.
infra/black-cloud/scripts/start-application-staging.sh
```

The release synchronizer creates a new immutable release directory and refuses to overwrite an existing one. It never transfers Git metadata, build output, Docker vendor sources, runtime secrets or encrypted migration artifacts. It performs no remote deletion and restarts no service. A dirty working tree is rejected unless `BLACK_CLOUD_ALLOW_DIRTY=true` is explicitly set for a non-production staging rehearsal.

PostgreSQL and Storage state live under `/var/lib/black-cloud/supabase`, outside every immutable release. For the one-time transition from a release-local official Supabase bundle, stop the Supabase database, run `migrate-supabase-state-root.sh`, then start the bundle with `black-cloud.override.yml` and complete the authenticated smoke test. The migration is copy-only, preserves file ownership and extended attributes required by the Storage file backend, and retains the original release-local state for rollback.

Staging publishes Caddy only on `127.0.0.1:18080`; use an SSH tunnel for browser testing. Supabase Kong and Supavisor are loopback-only. No database, Storage, Grafana or Prometheus port is public.

Production uses `docker-compose.production.yml` and `Caddyfile.production`. It publishes only HTTP/HTTPS, obtains TLS after the domain points to the host, and must not be started until the cutover checklist is approved. Images are tagged by exact Git SHA; floating `latest` tags are forbidden.

Never start `--profile live-execution` as part of an ordinary frontend/API deployment. That profile requires a separate real-funds readiness decision.
