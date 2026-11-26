//! Bramble as an SSH agent: `ssh`, `git` and friends sign with the SSH keys in the vault, and the
//! private keys never leave this process. See docs/ssh-agent.md.

pub mod commands;
pub mod keys;
pub mod listener;
pub mod protocol;
pub mod ssh_config;
pub mod step_back;
pub mod store;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::{lifetime, storage::ops};
use commands::LeftOutHost;
use step_back::{Before, Raised};
use store::{Ask, Hooks, Store};

/// The settings, in the app's meta like the Quick Access shortcut: they must be readable at
/// launch, before any window exists.
const ENABLED: &str = "ssh-agent.enabled";
const ASK_EACH_USE: &str = "ssh-agent.askEachUse";
const ONLY_THEIR_HOSTS: &str = "ssh-agent.onlyTheirHosts";

const REQUEST_EVENT: &str = "ssh-agent://request";
const DONE_EVENT: &str = "ssh-agent://done";

/// How long nothing has to be asking before the window goes back.
const SETTLE: Duration = Duration::from_millis(400);

pub(crate) struct Agent {
    root: PathBuf,
    home: Option<PathBuf>,
    store: Arc<Store>,
    hooks: Arc<AppHooks>,
    state: Mutex<AgentState>,
}

#[derive(Default)]
struct AgentState {
    address: Option<String>,
    error: Option<&'static str>,
    left_out: Vec<LeftOutHost>,
}

static AGENT: OnceLock<Agent> = OnceLock::new();

fn agent() -> Result<&'static Agent, String> {
    AGENT.get().ok_or_else(|| "ssh agent not started".into())
}

impl Agent {
    fn state(&self) -> MutexGuard<'_, AgentState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn meta_flag(&self, key: &str) -> bool {
        meta_flag(&self.root, key)
    }

    fn set_meta_flag(&self, key: &str, on: bool) -> Result<(), String> {
        ops::set_meta(&self.root, key.to_string(), Value::Bool(on))
    }

    /// Listen, and record the address or why not.
    fn start_listening(&self) {
        let hooks: Arc<dyn Hooks> = self.hooks.clone();
        let result = listener::listen(&self.root, self.home.clone(), self.store.clone(), hooks);
        let mut state = self.state();
        match result {
            Ok(address) => {
                state.address = Some(address);
                state.error = None;
            }
            Err(listener::ListenError::PathTooLong) => {
                log::warn!("ssh agent not listening: the socket path is too long");
                state.address = None;
                state.error = Some("path-too-long");
            }
            Err(listener::ListenError::Bind(reason)) => {
                log::warn!("ssh agent not listening: {reason}");
                state.address = None;
                state.error = Some("bind-failed");
            }
        }
        drop(state);
        if let Err(e) = self.write_main() {
            log::warn!("ssh agent config not written: {e}");
            self.state().error = Some("config-failed");
        }
    }

    fn write_main(&self) -> std::io::Result<()> {
        let address = self.state().address.clone();
        match (&self.home, address) {
            (Some(home), Some(address)) => {
                ssh_config::write_main(home, &address, self.meta_flag(ONLY_THEIR_HOSTS))
            }
            _ => Ok(()),
        }
    }
}

fn meta_flag(root: &Path, key: &str) -> bool {
    matches!(ops::get_meta(root, key), Ok(Some(Value::Bool(true))))
}

/// At launch: the lists from disk, the settings, and the socket if the agent is on. When it is
/// off, whatever a crash mid-switch-off left behind is cleared.
pub fn start(app: AppHandle, root: &Path) {
    let enabled = meta_flag(root, ENABLED);
    let home = ssh_config::home();
    if !enabled {
        let _ = store::delete_all(root);
        if let Some(home) = &home {
            let _ = ssh_config::delete_all(home);
        }
    }
    let lists = if enabled {
        store::read_lists(root)
    } else {
        Vec::new()
    };
    let agent = Agent {
        root: root.to_path_buf(),
        home,
        store: Arc::new(Store::new(lists, enabled, meta_flag(root, ASK_EACH_USE))),
        hooks: Arc::new(AppHooks {
            app,
            raised: Arc::default(),
        }),
        state: Mutex::new(AgentState::default()),
    };
    if AGENT.set(agent).is_err() {
        return;
    }
    if enabled {
        if let Ok(agent) = self::agent() {
            agent.start_listening();
        }
    }
}

/// Lock: the keys leave memory. Called wherever the vault locks in this process.
pub fn forget_keys() {
    if let Some(agent) = AGENT.get() {
        agent.store.forget_keys();
    }
}

/// The user closed the window showing the requests: each fails, as its Cancel would.
pub fn cancel_waiting() {
    if let Some(agent) = AGENT.get() {
        agent.store.cancel_all();
    }
}

struct AppHooks {
    app: AppHandle,
    raised: Arc<Mutex<Raised>>,
}

impl Hooks for AppHooks {
    fn locked(&self) -> bool {
        vault_crypto::is_locked()
    }

    fn ask(&self, ask: &Ask) {
        // Read before taking the lock: the getters wait on the main thread, which takes the lock
        // to settle.
        let before = window_now(&self.app);
        lock(&self.raised).ask(&ask.id, before);
        if let Err(e) = self.app.emit(REQUEST_EVENT, ask) {
            log::warn!("ssh agent request not delivered: {e}");
        }
        let app = self.app.clone();
        let _ = self
            .app
            .run_on_main_thread(move || lifetime::show_main(&app));
    }

    fn raise(&self, _ask: &Ask) {
        let app = self.app.clone();
        let _ = self
            .app
            .run_on_main_thread(move || lifetime::show_main(&app));
    }

    fn done(&self, id: &str) {
        let _ = self.app.emit(DONE_EVENT, serde_json::json!({ "id": id }));
        let Some(epoch) = lock(&self.raised).done(id) else {
            return;
        };
        let app = self.app.clone();
        let raised = self.raised.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SETTLE);
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let before = lock(&raised).settle(epoch);
                if let Some(before) = before {
                    step_back(&handle, before);
                }
            });
        });
    }
}

fn lock(raised: &Mutex<Raised>) -> MutexGuard<'_, Raised> {
    raised.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the vault window is doing now.
fn window_now(app: &AppHandle) -> Before {
    let Some(window) = app.get_webview_window(lifetime::MAIN) else {
        return Before::Hidden;
    };
    if !window.is_visible().unwrap_or(false) {
        Before::Hidden
    } else if window.is_minimized().unwrap_or(false) {
        Before::Minimized
    } else if window.is_focused().unwrap_or(false) {
        Before::InUse
    } else {
        Before::Background
    }
}

/// Put the window back where a request found it. On the main thread.
fn step_back(app: &AppHandle, before: Before) {
    match before {
        Before::InUse => {}
        Before::Hidden => lifetime::hide_main(app),
        Before::Background | Before::Minimized => {
            // Hiding the app is how macOS hands focus back to the app before it; elsewhere,
            // minimising the window does.
            if before == Before::Minimized || cfg!(not(target_os = "macos")) {
                if let Some(window) = app.get_webview_window(lifetime::MAIN) {
                    let _ = window.minimize();
                }
            }
            #[cfg(target_os = "macos")]
            let _ = app.hide();
        }
    }
}
