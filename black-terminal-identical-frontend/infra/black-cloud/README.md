# Black Cloud Docker Platform

This directory contains the Docker-only central Black Terminal platform. Start with the runbooks under `docs/black-cloud/`; current measured staging evidence is in `docs/black-cloud/staging-certification.md`.

Generated `.env`, `secrets/`, `vendor/` and `artifacts/` content is ignored by Git. Copy examples, set mode 600, and run `scripts/preflight.sh staging` before any deployment. Staging is loopback-only. Production and live execution require separate explicit approvals.

Never source the official Supabase `.env` as a shell script; Docker Compose parses values that may contain spaces. Never print Compose configuration containing resolved secrets.

For a genuinely fresh Ubuntu Server, use the single audited entry point:

```bash
./infra/black-cloud/install-ubuntu-server.sh --dry-run
sudo ./infra/black-cloud/install-ubuntu-server.sh --mode staging
```

The complete staging/production contract, private environment template, component inventory, migration guarantees, and rollback boundary are documented in `docs/black-cloud/ubuntu-fresh-install.md`. The installer is deliberately fresh-host only; existing Supabase data must use the export/restore workflow.
