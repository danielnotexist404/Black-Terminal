# Rollback Runbook

Rollback triggers include Auth failures, integrity mismatch, critical API/Realtime/Storage outage, order or position inconsistency, sustained unacceptable errors, or evidence of data loss.

1. Enter maintenance and stop Black Cloud writers/workers.
2. Record database LSN/time, release SHA, logs and affected job/command IDs.
3. Prevent split-brain by proving all Black Cloud leases and schedulers are stopped.
4. Repoint DNS/routing to the intact legacy deployment.
5. Re-enable legacy workers only after their fences are authoritative.
6. Reconcile writes accepted after cutover before normal operation resumes.
7. Preserve Black Cloud database, volumes and logs for investigation.
8. Write an incident timeline and decide whether to retry or restore.

Application containers may be rolled back to a prior immutable SHA. Database rollback is never automatic when a migration is not reversibly certified.
