# Bybit Mainnet Certification Report

Date: 2026-07-11T18:33:22.541Z

Certification Run ID: bybit-cert-1783794802541-016ed8

Status: BLOCKED

Decision: BLOCKED_EXTERNAL_CONFIGURATION

Adapter Version: phase-iii-chapter-xii-c

Account: not-configured

Symbol: BTCUSDT

Products Validated: Perpetual derivatives, where all steps pass.

## Environment Health

| Check | Status | Result |
| --- | --- | --- |
| env:SUPABASE_URL | FAIL | SUPABASE_URL or VITE_SUPABASE_URL is required. |
| env:BYBIT_MAINNET_VALIDATION_ENABLED | FAIL | BYBIT_MAINNET_VALIDATION_ENABLED is required. |
| env:EXCHANGE_CREDENTIAL_MASTER_KEY | FAIL | EXCHANGE_CREDENTIAL_MASTER_KEY is required. |
| env:SUPABASE_SERVICE_ROLE_KEY | FAIL | SUPABASE_SERVICE_ROLE_KEY is required. |
| env:BYBIT_MAINNET_ALLOWED_CONNECTIONS | FAIL | BYBIT_MAINNET_ALLOWED_CONNECTIONS is required. |
| env:BYBIT_MAINNET_ALLOWED_SYMBOLS | FAIL | BYBIT_MAINNET_ALLOWED_SYMBOLS is required. |
| env:BYBIT_MAINNET_MAX_NOTIONAL_USD | FAIL | BYBIT_MAINNET_MAX_NOTIONAL_USD is required. |
| env:BYBIT_CERTIFY_API_BASE_URL | FAIL | BYBIT_CERTIFY_API_BASE_URL is required. |
| env:BYBIT_CERTIFY_USER_TOKEN | FAIL | BYBIT_CERTIFY_USER_TOKEN is required. |
| env:BYBIT_MAINNET_VALIDATION_ENABLED | FAIL | BYBIT_MAINNET_VALIDATION_ENABLED must be true. |
| account:operator-selection | FAIL | BYBIT_CERTIFY_ACCOUNT_ID or BYBIT_STREAM_ACCOUNT_ID is required. |
| env:BYBIT_CERTIFY_API_BASE_URL | FAIL | BYBIT_CERTIFY_API_BASE_URL is required. |
| env:BYBIT_CERTIFY_USER_TOKEN | FAIL | BYBIT_CERTIFY_USER_TOKEN is required. |
| allowlist:connection | FAIL | Certification account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS. |
| allowlist:symbol | FAIL | Certification symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS. |
| risk:max-notional | FAIL | BYBIT_MAINNET_MAX_NOTIONAL_USD must be a positive number. |

## Test Sequence

| Step | Status | Result | Timestamp |
| --- | --- | --- | --- |
| none | BLOCKED | No validation steps completed. | 2026-07-11T18:33:22.546Z |

## Evidence References

- No evidence recorded.

Detailed evidence is persisted in `mainnet_validation_records` and `execution_audit_logs` when the runner reaches live steps.

## Known Limitations

- None recorded.

## Unresolved Defects

- SUPABASE_URL or VITE_SUPABASE_URL is required.
- BYBIT_MAINNET_VALIDATION_ENABLED is required.
- EXCHANGE_CREDENTIAL_MASTER_KEY is required.
- SUPABASE_SERVICE_ROLE_KEY is required.
- BYBIT_MAINNET_ALLOWED_CONNECTIONS is required.
- BYBIT_MAINNET_ALLOWED_SYMBOLS is required.
- BYBIT_MAINNET_MAX_NOTIONAL_USD is required.
- BYBIT_CERTIFY_API_BASE_URL is required.
- BYBIT_CERTIFY_USER_TOKEN is required.
- BYBIT_MAINNET_VALIDATION_ENABLED must be true.
- BYBIT_CERTIFY_ACCOUNT_ID or BYBIT_STREAM_ACCOUNT_ID is required.
- BYBIT_CERTIFY_API_BASE_URL is required.
- BYBIT_CERTIFY_USER_TOKEN is required.
- Certification account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.
- Certification symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS.
- BYBIT_MAINNET_MAX_NOTIONAL_USD must be a positive number.

## Certification Status

Bybit must remain PARTIAL / BLOCKED. Do not mark production-certified until every required step has passed with persisted evidence.
