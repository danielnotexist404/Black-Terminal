use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Runtime, WindowEvent,
};

const PUBLIC_MARKET_HOSTS: &[&str] = &[
    "api.binance.com",
    "fapi.binance.com",
    "api.bybit.com",
    "www.okx.com",
];

#[tauri::command]
async fn public_market_get(url: String) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid market data URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err("Market data URL must use https".into());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Market data URL must include a host".to_string())?;
    if !PUBLIC_MARKET_HOSTS.contains(&host) {
        return Err(format!("Market data host is not allowed: {}", host));
    }

    let res = reqwest::Client::new()
        .get(parsed)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!("Market data request failed with status {}", status));
    }

    res.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_webhook(url: String, payload: Value) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Webhook URL must start with http:// or https://".into());
    }

    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .json(&payload)
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

#[tauri::command]
async fn send_ssh_alert(target: String, payload: Value) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("SSH target is required".into());
    }
    if target.chars().any(char::is_whitespace) {
        return Err("SSH target must be a single user@host value".into());
    }

    let mut child = Command::new("ssh")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg(target)
        .arg("mkdir -p ~/.black-terminal && cat >> ~/.black-terminal/alerts.jsonl")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start ssh: {}", e))?;

    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, "{}", payload).map_err(|e| format!("Failed to write alert to ssh stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for ssh alert: {}", e))?;

    if output.status.success() {
        Ok("SSH alert delivered".into())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
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
        .plugin(tauri_plugin_opener::init())
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
        .invoke_handler(tauri::generate_handler![send_webhook, send_ssh_alert, public_market_get])
        .run(tauri::generate_context!())
        .expect("error while running Black-Terminal Pixi");
}
