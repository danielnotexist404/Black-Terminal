use serde_json::Value;
use std::{net::SocketAddr, time::Duration};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Runtime, WindowEvent,
};

mod network_security;
use network_security::{is_local_hostname, is_public_ip};

const PUBLIC_MARKET_HOSTS: &[&str] = &[
    "api.binance.com",
    "fapi.binance.com",
    "api.bybit.com",
    "www.okx.com",
];
const MAX_MARKET_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_WEBHOOK_PAYLOAD_BYTES: usize = 64 * 1024;

#[tauri::command]
async fn public_market_get(url: String) -> Result<Value, String> {
    let parsed = validate_https_url(&url, "Market data")?;
    let host = parsed.host_str().expect("validated URL host");
    if !PUBLIC_MARKET_HOSTS.contains(&host) {
        return Err(format!("Market data host is not allowed: {}", host));
    }

    let client = restricted_client(&parsed).await?;
    let mut res = client.get(parsed).send().await.map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!("Market data request failed with status {}", status));
    }

    if res.content_length().unwrap_or(0) > MAX_MARKET_RESPONSE_BYTES as u64 {
        return Err("Market data response is too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if body.len().saturating_add(chunk.len()) > MAX_MARKET_RESPONSE_BYTES {
            return Err("Market data response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_webhook(url: String, payload: Value) -> Result<String, String> {
    let parsed = validate_https_url(&url, "Webhook")?;
    let host = parsed.host_str().expect("validated URL host");
    if is_local_hostname(host) {
        return Err("Private-network webhook targets are blocked".into());
    }
    let payload =
        serde_json::to_vec(&payload).map_err(|_| "Webhook payload is invalid".to_string())?;
    if payload.len() > MAX_WEBHOOK_PAYLOAD_BYTES {
        return Err("Webhook payload is too large".into());
    }

    let client = restricted_client(&parsed).await?;
    let res = client
        .post(parsed)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if status.is_success() {
        Ok(format!("{} OK", status.as_u16()))
    } else {
        Err(format!("Webhook failed with status {}", status))
    }
}

fn validate_https_url(url: &str, label: &str) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| format!("Invalid {} URL", label.to_lowercase()))?;
    if parsed.scheme() != "https" {
        return Err(format!("{} URL must use https", label));
    }
    if parsed.host_str().is_none() {
        return Err(format!("{} URL must include a host", label));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{} URL cannot contain embedded credentials", label));
    }
    if parsed.port().is_some_and(|port| port != 443) {
        return Err(format!("{} URL must use the standard HTTPS port", label));
    }
    Ok(parsed)
}

async fn restricted_client(url: &reqwest::Url) -> Result<reqwest::Client, String> {
    let host = url.host_str().expect("validated URL host");
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "Target hostname could not be resolved".to_string())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("Private or special-use network targets are blocked".into());
    }
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| "Restricted HTTP client could not be initialized".to_string())
}

fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Black Terminal", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let exit = MenuItem::with_id(app, "exit", "Exit Black Terminal", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &settings, &separator, &exit])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Black Terminal alerts running")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "settings" => {
                        show_main_window(app);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("bt-open-settings", ());
                        }
                    }
                    "exit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(tray.app_handle()),
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let window_to_hide = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_to_hide.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_webhook, public_market_get])
        .run(tauri::generate_context!())
        .expect("error while running Black-Terminal Pixi");
}
