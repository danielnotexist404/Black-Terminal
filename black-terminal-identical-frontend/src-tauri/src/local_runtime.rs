use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use libp2p::identity::Keypair;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, Runtime};

use crate::credential_vault::{get_internal_secret, set_internal_secret};

const LOCAL_RUNTIME_FILE: &str = "local-runtime-v1.json";
const P2P_IDENTITY_VAULT_KEY: &str = "internal:p2p-identity:v1";
const WEBVIEW_STALE_MILLIS: u64 = 120_000;
const WATCHDOG_RELOAD_COOLDOWN_MILLIS: u64 = 180_000;
static WEBVIEW_HEARTBEAT_AT: AtomicU64 = AtomicU64::new(0);
static WATCHDOG_RELOADED_AT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum RuntimeMode {
    LocalOnly,
    Hybrid,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalOwnerProfile {
    email: String,
    display_name: String,
    username: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalRuntimeConfig {
    schema_version: u8,
    mode: RuntimeMode,
    background_execution: bool,
    p2p_enabled: bool,
    peer_id: String,
    profile: LocalOwnerProfile,
    initialized_at: u64,
    updated_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializeLocalRuntimeRequest {
    mode: RuntimeMode,
    background_execution: bool,
    p2p_enabled: bool,
    email: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateLocalRuntimeRequest {
    background_execution: bool,
    p2p_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalRuntimeStatus {
    available: bool,
    initialized: bool,
    vault_ready: bool,
    config: Option<LocalRuntimeConfig>,
    platform: &'static str,
    persistent_background_supported: bool,
    background_limitation: Option<&'static str>,
    webview_heartbeat_at: Option<u64>,
    execution_worker_heartbeat_at: Option<u64>,
    background_health: String,
}

fn runtime_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(LOCAL_RUNTIME_FILE))
        .map_err(|_| "The Black Terminal application-data directory is unavailable".to_string())
}

fn read_config(path: &Path) -> Result<Option<LocalRuntimeConfig>, String> {
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
        let Ok(config) = serde_json::from_slice::<LocalRuntimeConfig>(&bytes) else {
            continue;
        };
        if config.schema_version == 1 {
            return Ok(Some(config));
        }
    }
    if found {
        Err("The local runtime configuration and recovery copy are invalid".to_string())
    } else {
        Ok(None)
    }
}

fn write_config(path: &Path, config: &LocalRuntimeConfig) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The local runtime configuration path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "The local runtime directory could not be created".to_string())?;
    let temporary = parent.join(format!(".{LOCAL_RUNTIME_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|_| "The local runtime configuration could not be encoded".to_string())?;
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "The local runtime configuration could not be written".to_string())?;
    file.write_all(&bytes)
        .map_err(|_| "The local runtime configuration could not be written".to_string())?;
    file.sync_all()
        .map_err(|_| "The local runtime configuration could not be synchronized".to_string())?;
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            "The stale local runtime recovery copy could not be removed".to_string()
        })?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|_| {
            "The previous local runtime configuration could not be protected".to_string()
        })?;
    }
    if fs::rename(&temporary, path).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err("The local runtime configuration could not be committed".to_string());
    }
    restrict_owner_only(path)?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            "The previous local runtime recovery copy could not be removed".to_string()
        })?;
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| {
        "The local runtime configuration permissions could not be restricted".to_string()
    })
}

#[cfg(not(unix))]
fn restrict_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) fn load_or_create_local_identity() -> Result<Keypair, String> {
    if let Some(encoded) = get_internal_secret(P2P_IDENTITY_VAULT_KEY)? {
        let bytes = STANDARD_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|_| "The encrypted local peer identity is invalid".to_string())?;
        let keypair = Keypair::from_protobuf_encoding(&bytes)
            .map_err(|_| "The encrypted local peer identity is invalid".to_string())?;
        return Ok(keypair);
    }
    let keypair = Keypair::generate_ed25519();
    let encoded = keypair
        .to_protobuf_encoding()
        .map_err(|_| "The local peer identity could not be encoded".to_string())?;
    set_internal_secret(P2P_IDENTITY_VAULT_KEY, &STANDARD_NO_PAD.encode(encoded))?;
    Ok(keypair)
}

fn local_identity() -> Result<(String, bool), String> {
    let keypair = load_or_create_local_identity()?;
    Ok((keypair.public().to_peer_id().to_string(), true))
}

pub(crate) fn p2p_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    Ok(read_config(&runtime_path(app)?)?.is_some_and(|config| config.p2p_enabled))
}

pub(crate) fn background_execution_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    runtime_path(app)
        .ok()
        .and_then(|path| read_config(&path).ok().flatten())
        .is_some_and(|config| config.background_execution)
}

fn optional_timestamp(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

fn background_health(
    config: Option<&LocalRuntimeConfig>,
    now: u64,
    webview_at: u64,
    worker_at: u64,
) -> String {
    let Some(config) = config else {
        return "NOT_CONFIGURED".into();
    };
    if !config.background_execution {
        return "DISABLED".into();
    }
    if worker_at == 0 || now.saturating_sub(worker_at) > 5_000 {
        return "EXECUTION_WORKER_DEGRADED".into();
    }
    if webview_at == 0 || now.saturating_sub(webview_at) > WEBVIEW_STALE_MILLIS {
        return "STRATEGY_HOST_DEGRADED".into();
    }
    "HEALTHY".into()
}

fn normalized_email(value: &str) -> Result<String, String> {
    let email = value.trim().to_ascii_lowercase();
    if email.len() > 254 || !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err("Enter a valid local owner email address".to_string());
    }
    Ok(email)
}

fn normalized_display_name(value: &str) -> Result<String, String> {
    let display_name = value.trim();
    if display_name.len() < 2 || display_name.len() > 80 {
        return Err("Display name must contain between 2 and 80 characters".to_string());
    }
    Ok(display_name.to_string())
}

fn platform_status() -> (&'static str, bool, Option<&'static str>) {
    #[cfg(target_os = "ios")]
    {
        return ("ios", false, Some("iOS may suspend or terminate background networking; this device cannot be certified as an always-on trading host."));
    }
    #[cfg(target_os = "android")]
    {
        return ("android", false, Some("Android requires an explicit foreground service and persistent notification; OEM power management can still stop it."));
    }
    #[cfg(target_os = "windows")]
    {
        return ("windows", true, None);
    }
    #[cfg(target_os = "macos")]
    {
        return ("macos", true, None);
    }
    #[cfg(target_os = "linux")]
    {
        return ("linux", true, None);
    }
    #[allow(unreachable_code)]
    (
        "unknown",
        false,
        Some("Persistent background execution is not certified on this platform."),
    )
}

fn status<R: Runtime>(app: &AppHandle<R>) -> Result<LocalRuntimeStatus, String> {
    let config = read_config(&runtime_path(app)?)?;
    let vault_ready = config
        .as_ref()
        .map(|_| get_internal_secret(P2P_IDENTITY_VAULT_KEY).map(|value| value.is_some()))
        .transpose()?
        .unwrap_or(false);
    let (platform, persistent_background_supported, background_limitation) = platform_status();
    let now = unix_millis();
    let webview_at = WEBVIEW_HEARTBEAT_AT.load(Ordering::Relaxed);
    let worker_at = crate::local_execution::local_execution_worker_heartbeat();
    Ok(LocalRuntimeStatus {
        available: true,
        initialized: config.is_some() && vault_ready,
        vault_ready,
        config,
        platform,
        persistent_background_supported,
        background_limitation,
        webview_heartbeat_at: optional_timestamp(webview_at),
        execution_worker_heartbeat_at: optional_timestamp(worker_at),
        background_health: background_health(config.as_ref(), now, webview_at, worker_at),
    })
}

fn initialize<R: Runtime>(
    app: &AppHandle<R>,
    request: InitializeLocalRuntimeRequest,
) -> Result<LocalRuntimeStatus, String> {
    let path = runtime_path(app)?;
    if read_config(&path)?.is_some() {
        return Err("Black Terminal local runtime is already initialized".to_string());
    }
    let email = normalized_email(&request.email)?;
    let display_name = normalized_display_name(&request.display_name)?;
    let (peer_id, _) = local_identity()?;
    let timestamp = unix_millis();
    let config = LocalRuntimeConfig {
        schema_version: 1,
        mode: request.mode,
        background_execution: request.background_execution,
        p2p_enabled: request.p2p_enabled,
        peer_id,
        profile: LocalOwnerProfile {
            username: email.clone(),
            email,
            display_name,
        },
        initialized_at: timestamp,
        updated_at: timestamp,
    };
    write_config(&path, &config)?;
    status(app)
}

fn update<R: Runtime>(
    app: &AppHandle<R>,
    request: UpdateLocalRuntimeRequest,
) -> Result<LocalRuntimeStatus, String> {
    let path = runtime_path(app)?;
    let mut config = read_config(&path)?
        .ok_or_else(|| "Black Terminal local runtime is not initialized".to_string())?;
    let (_, persistent_background_supported, _) = platform_status();
    if request.background_execution && !persistent_background_supported {
        return Err(
            "Persistent background execution is not supported on this platform".to_string(),
        );
    }
    config.background_execution = request.background_execution;
    config.p2p_enabled = request.p2p_enabled;
    config.updated_at = unix_millis();
    write_config(&path, &config)?;
    status(app)
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn start_local_runtime_watchdog<R: Runtime>(app: AppHandle<R>) {
    WEBVIEW_HEARTBEAT_AT.store(unix_millis(), Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if !background_execution_enabled(&app) {
                continue;
            }
            let now = unix_millis();
            let heartbeat = WEBVIEW_HEARTBEAT_AT.load(Ordering::Relaxed);
            let last_reload = WATCHDOG_RELOADED_AT.load(Ordering::Relaxed);
            if now.saturating_sub(heartbeat) <= WEBVIEW_STALE_MILLIS
                || now.saturating_sub(last_reload) <= WATCHDOG_RELOAD_COOLDOWN_MILLIS
            {
                continue;
            }
            WATCHDOG_RELOADED_AT.store(now, Ordering::Relaxed);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
    });
}

#[tauri::command]
pub(crate) async fn local_runtime_heartbeat<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LocalRuntimeStatus, String> {
    WEBVIEW_HEARTBEAT_AT.store(unix_millis(), Ordering::Relaxed);
    status(&app)
}

#[tauri::command]
pub(crate) async fn local_runtime_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LocalRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app))
        .await
        .map_err(|_| "The local runtime status task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn initialize_local_runtime<R: Runtime>(
    app: AppHandle<R>,
    request: InitializeLocalRuntimeRequest,
) -> Result<LocalRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || initialize(&app, request))
        .await
        .map_err(|_| "The local runtime initialization task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn update_local_runtime<R: Runtime>(
    app: AppHandle<R>,
    request: UpdateLocalRuntimeRequest,
) -> Result<LocalRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || update(&app, request))
        .await
        .map_err(|_| "The local runtime update task stopped unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_identity_is_normalized() {
        assert_eq!(
            normalized_email(" BlackTriangleGroup@proton.me ").unwrap(),
            "blacktrianglegroup@proton.me"
        );
        assert_eq!(
            normalized_display_name(" Black Triangle Group ").unwrap(),
            "Black Triangle Group"
        );
    }

    #[test]
    fn mobile_is_not_reported_as_an_unattended_host() {
        let (_, persistent, limitation) = platform_status();
        if cfg!(any(target_os = "ios", target_os = "android")) {
            assert!(!persistent);
            assert!(limitation.is_some());
        }
    }
}
