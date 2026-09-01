use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm,
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use zeroize::Zeroizing;

#[cfg(test)]
use std::sync::OnceLock;

#[cfg(not(test))]
use crate::credential_vault::{get_internal_secret, set_internal_secret};

const LOCAL_DATA_KEY: &str = "internal:local-data-master:v1";
const ENVELOPE_PREFIX: &str = "btenc:v1:";

#[cfg(test)]
fn load_or_create_master_key() -> Result<Zeroizing<Vec<u8>>, String> {
    static TEST_KEY: OnceLock<Vec<u8>> = OnceLock::new();
    Ok(Zeroizing::new(
        TEST_KEY
            .get_or_init(|| Aes256Gcm::generate_key(&mut OsRng).to_vec())
            .clone(),
    ))
}

#[cfg(not(test))]
fn load_or_create_master_key() -> Result<Zeroizing<Vec<u8>>, String> {
    if let Some(encoded) = get_internal_secret(LOCAL_DATA_KEY)? {
        let decoded = STANDARD_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|_| "The encrypted local-data key is invalid".to_string())?;
        if decoded.len() != 32 {
            return Err("The encrypted local-data key has an invalid length".to_string());
        }
        return Ok(Zeroizing::new(decoded));
    }
    let key = Aes256Gcm::generate_key(&mut OsRng);
    set_internal_secret(LOCAL_DATA_KEY, &STANDARD_NO_PAD.encode(key.as_slice()))?;
    Ok(Zeroizing::new(key.to_vec()))
}

fn cipher_from_key(key: &[u8]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| "The local-data encryption key could not be initialized".to_string())
}

pub(crate) fn encrypt_local_text(purpose: &str, plaintext: &str) -> Result<String, String> {
    let key = load_or_create_master_key()?;
    let cipher = cipher_from_key(&key)?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: purpose.as_bytes(),
            },
        )
        .map_err(|_| "Local data could not be encrypted".to_string())?;
    let mut envelope = Vec::with_capacity(nonce.len() + ciphertext.len());
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(format!(
        "{ENVELOPE_PREFIX}{}",
        STANDARD_NO_PAD.encode(envelope)
    ))
}

pub(crate) fn decrypt_local_text(purpose: &str, stored: &str) -> Result<String, String> {
    let Some(encoded) = stored.strip_prefix(ENVELOPE_PREFIX) else {
        // Read-only compatibility for profile data created before field
        // encryption. The next successful write upgrades it in place.
        return Ok(stored.to_string());
    };
    let envelope = STANDARD_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| "An encrypted local-data envelope is invalid".to_string())?;
    if envelope.len() <= 12 {
        return Err("An encrypted local-data envelope is truncated".to_string());
    }
    let (nonce, ciphertext) = envelope.split_at(12);
    let key = load_or_create_master_key()?;
    let cipher = cipher_from_key(&key)?;
    let plaintext = cipher
        .decrypt(
            aes_gcm::Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: purpose.as_bytes(),
            },
        )
        .map_err(|_| "Encrypted local data failed authentication".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Encrypted local data is not valid UTF-8".to_string())
}
