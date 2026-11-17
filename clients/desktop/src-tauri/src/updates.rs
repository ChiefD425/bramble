//! Installing an update: the plugin's check and download, then the public-log check, then install.
//!
//! This replaces the plugin's own download-and-install, which the webview can no longer reach
//! (capabilities/default.json grants it `check` only), so nothing skips `update_log`.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri_plugin_updater::UpdaterExt;

use crate::update_log;

/// The plugin's progress events, in the same shape, so the webview's handler is unchanged.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// Downloads, verifies and installs the latest update. False when there is none. The caller
/// relaunches; on Windows the installer has already taken over and this does not return.
#[tauri::command]
pub async fn updates_install(
    app: tauri::AppHandle,
    on_event: Channel<DownloadEvent>,
) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = update_log::verify_logged(&bytes, &update.raw_json) {
        log::error!("update {} refused: {e}", update.version);
        return Err(e);
    }
    update.install(bytes).map_err(|e| e.to_string())?;
    Ok(true)
}
