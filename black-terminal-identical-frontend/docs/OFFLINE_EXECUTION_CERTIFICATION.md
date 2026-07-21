# Offline Execution Certification

Status: **NOT YET PRODUCTION-CERTIFIED**.

The implementation and deterministic suites pass, but certification requires a continuously hosted worker and a controlled trade-only Bybit account. Vercel functions are the control plane; they cannot substitute for a persistent WebSocket worker.

## Required Environment

- always-on container built from `Dockerfile.black-cloud`;
- Supabase URL and service-role key;
- `EXCHANGE_CREDENTIAL_MASTER_KEY`;
- `BLACK_CLOUD_INTENT_SIGNING_KEY` with at least 32 bytes;
- `BLACK_CLOUD_EXECUTION_ENABLED=true`;
- `INVESTMENT_GROUP_EXECUTION_ENABLED=true`;
- `BYBIT_CLOUD_EXECUTION_ENABLED=true`;
- `BLACK_CLOUD_NETWORK=testnet` initially;
- Vercel `CLOUD_EXECUTION_CONTROL_PLANE_ENABLED=true` only after `/ready` is healthy.

## Certification Procedure

1. Activate a withdrawal-disabled Bybit testnet connection and verify capability discovery.
2. Accept a bounded test mandate and create a signed intent.
3. Close every Black Terminal browser and shut down the operator PC.
4. Confirm the hosted worker retains its lease/private stream and executes the proportional follower order.
5. Reopen the terminal and verify position, order, plan, audit and reconciliation history.
6. Disconnect the private stream and prove automatic reconnect plus exchange-authoritative repair.
7. Repeat an ambiguous submission and prove deterministic adoption without duplication.
8. Pause and emergency-stop; prove new orders stop while monitoring/reconciliation continue.
9. Revoke the credential; prove connection revocation and mandate pause.

Store timestamps, worker ID, connection ID, intent/plan/command IDs and redacted venue IDs. Mainnet remains disabled until every testnet step passes and a separately bounded mainnet certification is approved.

Run `npm run certify:offline-execution` with the server-only variables in `.env.black-cloud.example`, `BLACK_CLOUD_WORKER_URL`, `BLACK_CLOUD_CERT_CONNECTION_ID`, `BLACK_CLOUD_CERT_INTENT_ID`, the ISO `BLACK_CLOUD_CERT_STARTED_AT`, and exact `BLACK_CLOUD_OFFLINE_OPERATOR_CONFIRMATION="BROWSER CLOSED AND DEVICE OFFLINE"`. The collector is read-only: it verifies fresh worker/lease/private-stream/reconciliation/plan/order/audit evidence and prints the redacted certification decision.
