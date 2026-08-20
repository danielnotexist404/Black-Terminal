# Security

- UFW defaults to deny; only SSH is open during staging. Production adds 80/443.
- Database, pooler, Supabase admin surfaces, monitoring and storage are not public.
- Containers run read-only where possible, drop Linux capabilities, use `no-new-privileges`, bounded logs and non-root application users.
- Server secrets are held in mode-600 environment files outside Git. Browser bundles contain only the public Supabase URL and anonymous key.
- Existing credential-wrapping and intent-signing keys are migrated byte-for-byte. Rotating them during import would make encrypted broker material unreadable.
- Withdrawals/transfers remain prohibited. Migration tests never place, modify or cancel real orders.
- Caddy sets HSTS in production, frame denial, MIME sniffing protection, restrictive permissions policy and a same-origin CSP.
- The analytics and real-funds workers are separate Compose profiles. Staging forces all execution flags false and both Event Alpha kill switches true.
- Admin dashboards are loopback/private only.

Do not place Docker daemon access, database credentials, Supabase service-role credentials or exchange credentials on the future IMM node.
