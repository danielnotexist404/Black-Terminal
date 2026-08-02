# Broker Credential Vault

## Envelope format

Each v2 credential gets a random 256-bit data-encryption key (DEK). The credential is encrypted with
AES-256-GCM and a unique 96-bit IV. Canonical associated data binds the ciphertext to the user,
connection, provider, scope, and envelope version. A versioned server master key separately wraps the
DEK with AES-256-GCM.

Stored material contains ciphertext, both IVs, both authentication tags, the wrapped DEK, associated-
data hash, master-key version, and redacted credential metadata. Plaintext credentials and plaintext
DEKs are never persisted or returned to React.

## Runtime rules

- Only the service role may call the v2 vault RPC.
- The RPC validates tenant/connection ownership and rejects withdrawal-enabled material.
- Decryption requires the expected user, connection, provider, and purpose.
- Associated-data hashes are compared with a timing-safe operation before decryption.
- Temporary plaintext and key buffers are overwritten where the Node runtime permits.
- Audit events record creation, rotation, use, and revocation without secrets.

`BLACK_CLOUD_MASTER_KEY_VERSION` selects `BLACK_CLOUD_SECRET_MASTER_KEY_V<n>`. Legacy v1 envelopes
remain decryptable for controlled migration, but all new writes are v2. Rotation activates a new
credential version atomically and marks prior versions rotated.

## Operator prohibition

Never put a master key, exchange secret, agent key, signature, or decrypted vault value in browser
environment variables, client logs, error metadata, screenshots, or support exports.
