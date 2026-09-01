use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroizing;

const VAULT_SERVICE: &str = "com.blacktriangle.blackterminal";
const CREDENTIAL_INDEX_FILE: &str = "credential-index-v1.json";
static CREDENTIAL_INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExchangeCredentialInput {
    account_id: String,
    exchange: String,
    api_key: String,
    api_secret: String,
    passphrase: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCredentialReference {
    account_id: String,
    exchange: String,
    vault_key: String,
    stored_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialIndex {
    schema_version: u8,
    credentials: Vec<StoredCredentialReference>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretEnvelope<'a> {
    schema_version: u8,
    account_id: &'a str,
    exchange: &'a str,
    api_key: &'a str,
    api_secret: &'a str,
    passphrase: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSecretEnvelope {
    schema_version: u8,
    account_id: String,
    exchange: String,
    api_key: String,
    api_secret: String,
    passphrase: Option<String>,
}

pub(crate) struct ExchangeCredentialSecret {
    pub(crate) account_id: String,
    pub(crate) exchange: String,
    pub(crate) api_key: Zeroizing<String>,
    pub(crate) api_secret: Zeroizing<String>,
    pub(crate) passphrase: Option<Zeroizing<String>>,
}

fn normalize_component(value: &str, label: &str, max_len: usize) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized.len() > max_len {
        return Err(format!("{label} is invalid"));
    }
    if !normalized.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
    }) {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(normalized)
}

fn expected_vault_key(credentials: &ExchangeCredentialInput) -> Result<String, String> {
    let exchange = normalize_component(&credentials.exchange, "Exchange", 32)?;
    let account_id = normalize_component(&credentials.account_id, "Account identifier", 128)?;
    Ok(format!("exchange:{exchange}:{account_id}"))
}

fn validate_secret(value: &str, label: &str) -> Result<(), String> {
    let length = value.trim().len();
    if !(8..=512).contains(&length) {
        return Err(format!("{label} must contain between 8 and 512 characters"));
    }
    Ok(())
}

fn vault_entry(vault_key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(VAULT_SERVICE, vault_key)
        .map_err(|_| "The operating-system credential vault is unavailable".to_string())
}

fn credential_index_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CREDENTIAL_INDEX_FILE))
        .map_err(|_| "The Black Terminal application-data directory is unavailable".to_string())
}

fn read_index(path: &Path) -> Result<CredentialIndex, String> {
    let backup = path.with_extension("json.bak");
    let candidates = [path, backup.as_path()];
    let mut found = false;
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        found = true;
        let Ok(bytes) = fs::read(candidate) else {
            continue;
        };
        let Ok(index) = serde_json::from_slice::<CredentialIndex>(&bytes) else {
            continue;
        };
        if index.schema_version == 1 {
            return Ok(index);
        }
    }
    if found {
        Err("The credential reference index and recovery copy are invalid".to_string())
    } else {
        Ok(CredentialIndex {
            schema_version: 1,
            credentials: Vec::new(),
        })
    }
}

fn write_index(path: &Path, index: &CredentialIndex) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The credential index path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "The credential reference directory could not be created".to_string())?;
    let temporary = parent.join(format!(".{CREDENTIAL_INDEX_FILE}.tmp"));
    let bytes = serde_json::to_vec(index)
        .map_err(|_| "The credential reference index could not be encoded".to_string())?;
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "The credential reference index could not be written".to_string())?;
    file.write_all(&bytes)
        .map_err(|_| "The credential reference index could not be written".to_string())?;
    file.sync_all()
        .map_err(|_| "The credential reference index could not be synchronized".to_string())?;
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            "The stale credential index recovery copy could not be removed".to_string()
        })?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|_| {
            "The previous credential reference index could not be protected".to_string()
        })?;
    }
    if fs::rename(&temporary, path).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err("The credential reference index could not be committed".to_string());
    }
    restrict_owner_only(path)?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            "The previous credential index recovery copy could not be removed".to_string()
        })?;
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "The credential reference permissions could not be restricted".to_string())
}

#[cfg(not(unix))]
fn restrict_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn store<R: Runtime>(
    app: &AppHandle<R>,
    supplied_vault_key: String,
    credentials: ExchangeCredentialInput,
) -> Result<StoredCredentialReference, String> {
    let _index_guard = CREDENTIAL_INDEX_LOCK
        .lock()
        .map_err(|_| "The credential reference index is unavailable".to_string())?;
    validate_secret(&credentials.api_key, "API key")?;
    validate_secret(&credentials.api_secret, "API secret")?;
    if let Some(passphrase) = credentials.passphrase.as_deref() {
        if !passphrase.is_empty() {
            validate_secret(passphrase, "API passphrase")?;
        }
    }
    let vault_key = expected_vault_key(&credentials)?;
    if supplied_vault_key.trim().to_ascii_lowercase() != vault_key {
        return Err("The credential vault reference does not match the account".to_string());
    }

    let secret = Zeroizing::new(
        serde_json::to_string(&SecretEnvelope {
            schema_version: 1,
            account_id: credentials.account_id.trim(),
            exchange: credentials.exchange.trim(),
            api_key: credentials.api_key.trim(),
            api_secret: credentials.api_secret.trim(),
            passphrase: credentials
                .passphrase
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        })
        .map_err(|_| "The broker credential envelope could not be encoded".to_string())?,
    );
    let entry = vault_entry(&vault_key)?;
    let previous_secret = match entry.get_password() {
        Ok(value) => Some(Zeroizing::new(value)),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err(
            "The operating-system credential vault could not read the existing broker credential"
                .to_string(),
        ),
    };
    entry.set_password(&secret).map_err(|_| {
        "The operating-system credential vault refused the broker credential".to_string()
    })?;

    let reference = StoredCredentialReference {
        account_id: credentials.account_id.trim().to_string(),
        exchange: credentials.exchange.trim().to_ascii_lowercase(),
        vault_key: vault_key.clone(),
        stored_at: unix_millis(),
    };
    let path = credential_index_path(app)?;
    let mut index = read_index(&path)?;
    index
        .credentials
        .retain(|item| item.vault_key != vault_key && item.account_id != reference.account_id);
    index.credentials.push(reference.clone());
    if let Err(error) = write_index(&path, &index) {
        if let Some(previous) = previous_secret {
            let _ = entry.set_password(&previous);
        } else {
            let _ = entry.delete_credential();
        }
        return Err(error);
    }
    Ok(reference)
}

fn delete<R: Runtime>(app: &AppHandle<R>, account_id: &str) -> Result<(), String> {
    let _index_guard = CREDENTIAL_INDEX_LOCK
        .lock()
        .map_err(|_| "The credential reference index is unavailable".to_string())?;
    let normalized = normalize_component(account_id, "Account identifier", 128)?;
    let path = credential_index_path(app)?;
    let mut index = read_index(&path)?;
    let matching: Vec<_> = index
        .credentials
        .iter()
        .filter(|item| item.account_id.trim().to_ascii_lowercase() == normalized)
        .cloned()
        .collect();
    for reference in &matching {
        let entry = vault_entry(&reference.vault_key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                return Err("The operating-system credential vault refused deletion".to_string())
            }
        }
    }
    index
        .credentials
        .retain(|item| item.account_id.trim().to_ascii_lowercase() != normalized);
    write_index(&path, &index)
}

fn list<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<StoredCredentialReference>, String> {
    let _index_guard = CREDENTIAL_INDEX_LOCK
        .lock()
        .map_err(|_| "The credential reference index is unavailable".to_string())?;
    Ok(read_index(&credential_index_path(app)?)?.credentials)
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn set_internal_secret(vault_key: &str, value: &str) -> Result<(), String> {
    vault_entry(vault_key)?
        .set_password(value)
        .map_err(|_| "The operating-system credential vault refused the local identity".to_string())
}

pub(crate) fn get_internal_secret(vault_key: &str) -> Result<Option<Zeroizing<String>>, String> {
    match vault_entry(vault_key)?.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(
            "The operating-system credential vault could not unlock the local identity".to_string(),
        ),
    }
}

pub(crate) fn read_exchange_credentials<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
) -> Result<ExchangeCredentialSecret, String> {
    let normalized = normalize_component(account_id, "Account identifier", 128)?;
    let index = read_index(&credential_index_path(app)?)?;
    let references: Vec<_> = index
        .credentials
        .iter()
        .filter(|reference| reference.account_id.trim().to_ascii_lowercase() == normalized)
        .collect();
    if references.len() != 1 {
        return Err(if references.is_empty() {
            "The broker credential was not found in the operating-system vault".to_string()
        } else {
            "The broker credential reference is ambiguous".to_string()
        });
    }
    let encoded = vault_entry(&references[0].vault_key)?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|_| {
            "The operating-system credential vault could not unlock the broker credential"
                .to_string()
        })?;
    let decoded: StoredSecretEnvelope = serde_json::from_str(&encoded)
        .map_err(|_| "The broker credential envelope is invalid".to_string())?;
    if decoded.schema_version != 1 || decoded.account_id.trim().to_ascii_lowercase() != normalized {
        return Err(
            "The broker credential envelope does not match the requested account".to_string(),
        );
    }
    Ok(ExchangeCredentialSecret {
        account_id: decoded.account_id,
        exchange: decoded.exchange.to_ascii_lowercase(),
        api_key: Zeroizing::new(decoded.api_key),
        api_secret: Zeroizing::new(decoded.api_secret),
        passphrase: decoded
            .passphrase
            .filter(|value| !value.is_empty())
            .map(Zeroizing::new),
    })
}

#[tauri::command]
pub(crate) async fn secure_store_exchange_credentials<R: Runtime>(
    app: AppHandle<R>,
    vault_key: String,
    credentials: ExchangeCredentialInput,
) -> Result<StoredCredentialReference, String> {
    tauri::async_runtime::spawn_blocking(move || store(&app, vault_key, credentials))
        .await
        .map_err(|_| "The credential vault task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn secure_delete_exchange_credentials<R: Runtime>(
    app: AppHandle<R>,
    account_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete(&app, &account_id))
        .await
        .map_err(|_| "The credential vault task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn secure_list_exchange_credentials<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<StoredCredentialReference>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&app))
        .await
        .map_err(|_| "The credential vault task stopped unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_reference_is_derived_from_the_account() {
        let credentials = ExchangeCredentialInput {
            account_id: "Account-01".into(),
            exchange: "Bybit".into(),
            api_key: "12345678".into(),
            api_secret: "abcdefgh".into(),
            passphrase: None,
        };
        assert_eq!(
            expected_vault_key(&credentials).unwrap(),
            "exchange:bybit:account-01"
        );
    }

    #[test]
    fn secrets_are_not_part_of_the_reference_index() {
        let reference = StoredCredentialReference {
            account_id: "account-01".into(),
            exchange: "bybit".into(),
            vault_key: "exchange:bybit:account-01".into(),
            stored_at: 1,
        };
        let encoded = serde_json::to_string(&CredentialIndex {
            schema_version: 1,
            credentials: vec![reference],
        })
        .unwrap();
        assert!(!encoded.contains("apiSecret"));
        assert!(!encoded.contains("apiKey"));
    }
}
