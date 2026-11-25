//! The agent's Tauri commands. Only the vault window may call them: commands this crate defines
//! aren't limited by Tauri's per-window capabilities, and the quick-access panel must not be able
//! to switch the agent on or approve a request.

#[cfg(test)]
use std::fs;
use std::{io, path::Path, sync::Mutex};

use serde::Serialize;
use tauri::Window;

use super::{
    agent, listener,
    ssh_config::{self, Setup, VaultKey},
    store::{self, Ask, KeyInput, Prepared, Store, UnusableKey},
    Agent, ASK_EACH_USE, ENABLED, ONLY_THEIR_HOSTS,
};

/// Every write to the key lists and `~/.ssh/bramble` holds this, so a sequence check and the
/// files it guards can't interleave with another save.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// A host left out of the ssh config, for Settings.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftOutHost {
    pub entry_id: String,
    pub name: String,
    pub host: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentStatus {
    pub enabled: bool,
    pub ask_each_use: bool,
    pub only_their_hosts: bool,
    pub setup: Setup,
    pub can_add_line: bool,
    pub include_line: &'static str,
    /// "path-too-long", "bind-failed" or "config-failed".
    pub error: Option<&'static str>,
    pub unusable: Vec<UnusableKey>,
    pub left_out: Vec<LeftOutHost>,
}

pub(super) struct Paths<'a> {
    pub root: &'a Path,
    pub home: Option<&'a Path>,
    pub agent_address: Option<&'a str>,
    pub only_their_hosts: bool,
}

pub(super) fn main_only(label: &str) -> Result<(), String> {
    if label == crate::lifetime::MAIN {
        Ok(())
    } else {
        Err("main window only".into())
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Put a save's keys in place and write their files, unless a later save for the vault already
/// did. `None` when nothing was applied.
pub(super) fn save(
    store: &Store,
    paths: &Paths,
    seq: u64,
    vault_id: &str,
    vault_name: &str,
    listed: &[String],
    prepared: Prepared,
    locked: &dyn Fn() -> bool,
) -> io::Result<Option<Vec<LeftOutHost>>> {
    let _write = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(applied) = store.apply(seq, vault_id, vault_name, prepared, locked()) else {
        return Ok(None);
    };
    store::write_list(paths.root, &applied.list)?;
    store.prune(listed);
    store::prune_lists(paths.root, listed)?;
    let mut left_out = Vec::new();
    if let Some(home) = paths.home {
        if let Some(address) = paths.agent_address {
            if !home.join(".ssh/bramble/config").exists() {
                ssh_config::write_main(home, address, paths.only_their_hosts)?;
            }
        }
        let keys: Vec<(String, VaultKey)> = applied
            .hosted
            .iter()
            .map(|(id, blob, hosts)| {
                let key = VaultKey {
                    blob: blob.clone(),
                    hosts: hosts.clone(),
                };
                (id.clone(), key)
            })
            .collect();
        for out in ssh_config::write_vault(home, vault_id, &keys)? {
            let name = applied
                .list
                .keys
                .iter()
                .find(|k| k.entry_id == out.entry_id)
                .map(|k| k.name.clone())
                .unwrap_or_default();
            left_out.push(LeftOutHost {
                entry_id: out.entry_id,
                name,
                host: out.host,
            });
        }
        ssh_config::prune_vaults(home, listed)?;
    }
    Ok(Some(left_out))
}

fn status(agent: &Agent) -> SshAgentStatus {
    let state = agent.state();
    let home = agent.home.as_deref();
    SshAgentStatus {
        enabled: agent.store.enabled(),
        ask_each_use: agent.store.ask_each_use(),
        only_their_hosts: agent.meta_flag(ONLY_THEIR_HOSTS),
        setup: home.map_or(Setup::NotAdded, ssh_config::setup),
        can_add_line: home.is_some_and(ssh_config::can_add_line),
        include_line: ssh_config::INCLUDE_LINE,
        error: state.error,
        unusable: agent.store.unusable(),
        left_out: state.left_out.clone(),
    }
}

#[tauri::command]
pub fn ssh_agent_status(window: Window) -> Result<SshAgentStatus, String> {
    main_only(window.label())?;
    Ok(status(agent()?))
}

#[tauri::command]
pub fn ssh_agent_set(
    window: Window,
    enabled: Option<bool>,
    ask_each_use: Option<bool>,
    only_their_hosts: Option<bool>,
) -> Result<SshAgentStatus, String> {
    main_only(window.label())?;
    let agent = agent()?;
    let _write = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(on) = ask_each_use {
        agent.set_meta_flag(ASK_EACH_USE, on)?;
        agent.store.set_ask_each_use(on);
    }
    if let Some(on) = only_their_hosts {
        agent.set_meta_flag(ONLY_THEIR_HOSTS, on)?;
    }
    match enabled {
        Some(true) if !agent.store.enabled() => {
            agent.set_meta_flag(ENABLED, true)?;
            agent.store.set_enabled(true);
            agent.start_listening();
        }
        Some(false) if agent.store.enabled() => {
            listener::stop(&agent.root);
            agent.store.set_enabled(false);
            agent.set_meta_flag(ENABLED, false)?;
            store::delete_all(&agent.root).map_err(err)?;
            if let Some(home) = &agent.home {
                ssh_config::delete_all(home).map_err(err)?;
            }
            let mut state = agent.state();
            state.address = None;
            state.error = None;
            state.left_out.clear();
        }
        _ => {
            if only_their_hosts.is_some() && agent.store.enabled() {
                agent.write_main().map_err(err)?;
            }
        }
    }
    Ok(status(agent))
}

#[tauri::command]
pub fn ssh_agent_add_include(window: Window) -> Result<SshAgentStatus, String> {
    main_only(window.label())?;
    let agent = agent()?;
    let home = agent.home.as_deref().ok_or("no home folder")?;
    ssh_config::add_line(home).map_err(err)?;
    Ok(status(agent))
}

#[tauri::command]
pub async fn ssh_agent_set_keys(
    window: Window,
    vault_id: String,
    vault_name: String,
    listed_vault_ids: Vec<String>,
    keys: Vec<KeyInput>,
) -> Result<(), String> {
    main_only(window.label())?;
    let agent = agent()?;
    if !agent.store.enabled() {
        return Ok(());
    }
    let seq = agent.store.claim(&vault_id);
    let store = agent.store.clone();
    // Off the main thread: an encrypted key is deliberately slow to open.
    let prepared = tauri::async_runtime::spawn_blocking(move || store.prepare(keys))
        .await
        .map_err(err)?;
    let address = agent.state().address.clone();
    let paths = Paths {
        root: &agent.root,
        home: agent.home.as_deref(),
        agent_address: address.as_deref(),
        only_their_hosts: agent.meta_flag(ONLY_THEIR_HOSTS),
    };
    let saved = save(
        &agent.store,
        &paths,
        seq,
        &vault_id,
        &vault_name,
        &listed_vault_ids,
        prepared,
        &vault_crypto::is_locked,
    );
    match saved {
        Ok(Some(left_out)) => {
            let mut state = agent.state();
            state.left_out = left_out;
            if state.error == Some("config-failed") {
                state.error = None;
            }
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(e) => {
            // Settings says so: otherwise it would read "Added to ~/.ssh/config" while ssh never
            // reaches Bramble (say, a file called ~/.ssh/bramble already there).
            agent.state().error = Some("config-failed");
            Err(err(e))
        }
    }
}

/// The questions waiting for the user, for a window that opened after they were asked.
#[tauri::command]
pub fn ssh_agent_pending(window: Window) -> Result<Vec<Ask>, String> {
    main_only(window.label())?;
    Ok(agent()?.store.pending_asks())
}

#[tauri::command]
pub fn ssh_agent_forget_vault(window: Window, vault_id: String) -> Result<(), String> {
    main_only(window.label())?;
    let agent = agent()?;
    let _write = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    agent.store.forget_vault(&vault_id);
    store::delete_list(&agent.root, &vault_id).map_err(err)?;
    if let Some(home) = &agent.home {
        ssh_config::delete_vault(home, &vault_id).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_agent_answer(window: Window, request_id: String, approve: bool) -> Result<(), String> {
    main_only(window.label())?;
    agent()?.store.answer(&request_id, approve);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_agent::store::KeyInput;

    const ED: &str = include_str!("fixtures/ed25519");
    const ECDSA: &str = include_str!("fixtures/ecdsa256");

    fn key(id: &str, pem: &str, host: &str) -> KeyInput {
        KeyInput {
            id: id.into(),
            name: format!("key {id}"),
            private_key: pem.into(),
            passphrase: None,
            hosts: vec![host.into()],
        }
    }

    struct Dirs {
        root: tempfile::TempDir,
        home: tempfile::TempDir,
    }

    impl Dirs {
        fn new() -> Self {
            Self {
                root: tempfile::tempdir().unwrap(),
                home: tempfile::tempdir().unwrap(),
            }
        }
        fn paths(&self) -> Paths<'_> {
            Paths {
                root: self.root.path(),
                home: Some(self.home.path()),
                agent_address: Some("/tmp/agent.sock"),
                only_their_hosts: false,
            }
        }
        fn conf(&self) -> String {
            fs::read_to_string(self.home.path().join(".ssh/bramble/vaults/A.conf"))
                .unwrap_or_default()
        }
    }

    fn save_one(
        store: &Store,
        dirs: &Dirs,
        seq: u64,
        keys: Vec<KeyInput>,
    ) -> Option<Vec<LeftOutHost>> {
        let prepared = store.prepare(keys);
        save(
            store,
            &dirs.paths(),
            seq,
            "A",
            "Personal",
            &["A".to_string()],
            prepared,
            &|| false,
        )
        .unwrap()
    }

    #[test]
    fn commands_refuse_other_windows() {
        assert!(main_only("main").is_ok());
        assert!(main_only("spotlight").is_err());
    }

    #[test]
    fn an_older_save_never_overwrites_newer_files() {
        let store = Store::new(vec![], true, false);
        let dirs = Dirs::new();
        let (first, second) = (store.claim("A"), store.claim("A"));
        assert!(save_one(&store, &dirs, second, vec![key("2", ECDSA, "new.example")]).is_some());
        assert!(save_one(&store, &dirs, first, vec![key("1", ED, "old.example")]).is_none());
        assert!(dirs.conf().contains("new.example"), "{}", dirs.conf());
        let lists = store::read_lists(dirs.root.path());
        assert_eq!(lists[0].keys[0].entry_id, "2");
    }

    #[test]
    fn a_deleted_bramble_folder_comes_back_on_the_next_save() {
        let store = Store::new(vec![], true, false);
        let dirs = Dirs::new();
        let seq = store.claim("A");
        save_one(&store, &dirs, seq, vec![key("1", ED, "h.example")]).unwrap();
        fs::remove_dir_all(dirs.home.path().join(".ssh/bramble")).unwrap();
        let seq = store.claim("A");
        save_one(&store, &dirs, seq, vec![key("1", ED, "h.example")]).unwrap();
        assert!(dirs.home.path().join(".ssh/bramble/config").exists());
        assert!(dirs.conf().contains("h.example"));
    }

    #[test]
    fn a_save_while_disabled_writes_nothing() {
        let store = Store::new(vec![], false, false);
        let dirs = Dirs::new();
        let seq = store.claim("A");
        assert!(save_one(&store, &dirs, seq, vec![key("1", ED, "h.example")]).is_none());
        assert!(!dirs.home.path().join(".ssh").exists());
        assert!(store::read_lists(dirs.root.path()).is_empty());
    }

    #[test]
    fn left_out_hosts_name_their_key() {
        let store = Store::new(vec![], true, false);
        let dirs = Dirs::new();
        let seq = store.claim("A");
        let left = save_one(&store, &dirs, seq, vec![key("1", ED, "bad host")]).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(
            (left[0].name.as_str(), left[0].host.as_str()),
            ("key 1", "bad host")
        );
    }
}
