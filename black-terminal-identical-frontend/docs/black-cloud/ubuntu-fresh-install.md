# Black Terminal Ubuntu Fresh-Server Installation

`infra/black-cloud/install-ubuntu-server.sh` is the single entry point for a new Docker-only Black Terminal server. It installs and verifies:

- the frontend, central Black Cloud API, and Caddy edge;
- pinned self-hosted Supabase/PostgreSQL, Auth, REST, Realtime, and Storage;
- every ordered SQL migration currently present under `supabase/migrations`;
- Event Alpha, the IMM market-depth worker, BCLIF persistent liquidation collection, and BC-QALC research capture;
- paper strategy automation;
- Prometheus, Grafana, host/container/PostgreSQL exporters;
- encrypted PostgreSQL and Supabase Storage backups.

The installer follows Docker's official Ubuntu apt-repository method and preserves the repository's certified Supabase pin (`self-hosted/v0.7.2`, commit `549db119c44c25167461812041ba198bde2b31a4`). Updating that pin is a separate compatibility project, not an installation side effect.

## Boundaries

This is a fresh-host schema installer, not a database-data migration tool. It applies all Black Terminal SQL but does not copy users, positions, broker credentials, historical BCLIF tiles, or other records from an old database. Use the export/restore runbook for those records and preserve the original encryption/signing keys byte-for-byte.

The installer never:

- changes DNS, UFW, nftables, iptables, or cloud firewall rules;
- prints or commits secret values;
- publishes PostgreSQL, Redis, Storage, Prometheus, or Grafana publicly;
- submits, modifies, or cancels an order during verification;
- starts demo or real-funds workers under default options;
- deletes an existing release, container volume, or database.

Production enables the authenticated Bybit mainnet validation gate so manual broker connectivity, balances, positions, orders, TP/SL, leverage, and reconciliation can operate. That read/management plane is separate from autonomous Black Cloud execution. Withdrawal-enabled or transfer-enabled API keys remain rejected, and the autonomous real-funds worker remains stopped unless both live-execution flags are supplied. The account-ID-bound legacy private-stream profile is installed but not started globally; starting one without an explicit account identity would create a restart loop.

Docker-published ports have their own packet-filter behavior and may bypass some UFW expectations. Review the provider firewall independently; only Caddy ports 80/443 are published in production.

The pinned upstream Supabase bundle normally publishes Supavisor ports. Black Terminal replaces that list with loopback-only `127.0.0.1:15432` and `127.0.0.1:16543` bindings using Compose's `!override` tag; therefore Docker Compose 2.24.4 or newer is mandatory. PostgreSQL itself remains on the internal data network.

## Server requirements

- Ubuntu Server 22.04, 24.04, or 26.04, amd64 or arm64;
- at least 16 GiB RAM and 60 GiB free disk;
- root/sudo access, working outbound HTTPS, and a synchronized clock;
- for production, DNS already resolving the selected domain to the server;
- for production, an off-host Restic repository and required provider/OAuth credentials.

Production installation refuses `--without-backup`; same-host-only backup is not accepted as production disaster recovery.

## Inspect the plan

Run this without root; it changes nothing:

```bash
./infra/black-cloud/install-ubuntu-server.sh --dry-run
```

## Private staging installation

Staging binds Caddy only to `127.0.0.1:18080`. No private env is required for a genuinely fresh test installation:

```bash
sudo ./infra/black-cloud/install-ubuntu-server.sh --mode staging
```

The default worker-region label is `ap-southeast-1`; override it with `--region` when the server is elsewhere.

Reach it from an operator workstation through an SSH tunnel:

```bash
ssh -L 18080:127.0.0.1:18080 operator@server
```

Then open `http://127.0.0.1:18080`.

## Production installation

Create a secret file outside Git from `infra/black-cloud/secrets/ubuntu-installer.private.env.example`, populate it, and keep it mode 600:

```bash
install -m 600 infra/black-cloud/secrets/ubuntu-installer.private.env.example /root/black-cloud.private.env
```

After DNS points to the server and ports 80/443 are allowed at the provider boundary:

```bash
sudo ./infra/black-cloud/install-ubuntu-server.sh \
  --mode production \
  --domain terminal.example.com \
  --tls-email operations@example.com \
  --private-env /root/black-cloud.private.env
```

When `RESTIC_REPOSITORY` uses the `rclone:` backend, also pass a separate mode-600 `--rclone-config /root/rclone.conf`; the installer copies it into the protected shared-secret directory without printing it.

Bybit Demo execution is an explicit addition:

```bash
sudo ./infra/black-cloud/install-ubuntu-server.sh \
  --mode production \
  --domain terminal.example.com \
  --tls-email operations@example.com \
  --private-env /root/black-cloud.private.env \
  --enable-demo-execution
```

Real-funds execution requires two explicit flags. This only starts the isolated execution service; application authorization, ownership, mandate, credential, idempotency, and server validation remain enforced:

```bash
  --enable-live-execution --acknowledge-real-funds
```

Do not use those flags merely to install the software. Every image and schema needed by the execution plane is built without starting that plane.

## Filesystem layout

```text
/opt/black-cloud/releases/<git-sha>/   source and Compose release
/opt/black-cloud/current               verified-release symlink
/opt/black-cloud/vendor/supabase/      pinned Supabase Docker bundle and persistent JWT/Auth config
/opt/black-cloud/shared-secrets/       mode-600 runtime, backup, monitoring, and rclone config
/var/lib/black-cloud/supabase/         PostgreSQL and Storage state
/var/lib/black-cloud/qalc/             BC-QALC capture state
/var/lib/black-cloud/restic/           staging-only local Restic repository
/var/lib/black-cloud/installations/    non-secret success/failure evidence
```

## Migration guarantees

`scripts/apply-repository-migrations.sh` discovers migration files at runtime instead of relying on a manually truncated list. It validates filename/version uniqueness, serializes migration activity with a host lock, applies non-transactional files through an outer transaction, and records SHA-256, status, timestamps, and version in a private operational ledger. A failed or interrupted migration becomes fail-closed and requires inspection. Applied versions are mirrored into `supabase_migrations.schema_migrations` for tooling compatibility.

An existing Black Terminal schema without this checksum ledger is rejected. Import an existing database through the documented restore path; do not point this fresh installer at it.

## Completion evidence and rollback boundary

Success requires public readiness, security headers, all migration checksums, every requested container remaining up, completion of the first encrypted backup, and an empty execution-order table. The installer writes a non-secret report under `/var/lib/black-cloud/installations/` and only then creates `/opt/black-cloud/current`.

On failure it records the phase and stops. It does not delete volumes or roll back schema. A release rollback means stopping the affected Compose project and repointing `current` to a previously verified release while preserving database and Storage state; schema rollback requires its own reviewed forward correction or restore procedure.

A failed fresh installation retains an exact-commit resume marker. Rerunning the same committed installer can continue idempotent phases. Existing persistent state without that marker is rejected before Supabase configuration is touched.
