//! What the agent knows, and the one decision it makes for every request: sign, ask, or fail.
//!
//! The open vault's keys are held decrypted until lock. Every vault's public keys are kept in a
//! list (and on disk, see `write_list`) so they can be offered while locked. A request that needs
//! the user waits here for an answer, an unlock, or its timeout, and the decision is re-made on
//! every wake, so a lock while it waits can never sign with keys that are gone.

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::keys::{self, AgentKey, Unusable};
use super::protocol::{self, Purpose};

/// More distinct questions than this waiting at once is a flood, not a person at a terminal.
pub const MAX_PENDING: usize = 8;

/// One SSH key entry as the vault sends it. Wiped when dropped: it holds the private key text.
#[derive(Clone, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    pub id: String,
    pub name: String,
    pub private_key: String,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEntry {
    pub entry_id: String,
    pub name: String,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
}

/// One vault's keys, as listed while it is locked.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicList {
    pub vault_id: String,
    pub vault_name: String,
    pub keys: Vec<PublicEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusableKey {
    pub entry_id: String,
    pub name: String,
    pub reason: Unusable,
}

/// What the user is asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Bramble is locked: the key's vault's unlock screen.
    Unlock,
    /// Another vault is open: a card offering to open the key's vault.
    Switch,
    /// Ask before each use is on.
    Confirm,
    /// A server reached with `ssh -A` wants the keys.
    AllowServer,
}

/// A question for the window, sent as `ssh-agent://request`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub id: String,
    pub vault_id: Option<String>,
    pub vault_name: Option<String>,
    pub key_name: Option<String>,
    pub caller: String,
    pub purpose: Option<Purpose>,
    pub server: Option<String>,
    pub mode: Mode,
}

/// The connection a request came in on.
pub struct Conn {
    /// The calling program's name: a label for the user, never a security check.
    pub caller: String,
    /// The host key of the server this connection was forwarded to, if it was.
    pub forwarded_by: Option<Vec<u8>>,
    /// That server's name for the user.
    pub server: Option<String>,
}

/// What a request needs from the app. The app's wraps vault_crypto and Tauri; tests use their own.
pub trait Hooks: Send + Sync {
    fn locked(&self) -> bool;
    fn ask(&self, ask: &Ask);
    /// Another request joined `ask`: bring it forward again, wherever the user put the window.
    fn raise(&self, ask: &Ask);
    fn done(&self, id: &str);
}

/// Keys parsed outside the state lock, waiting for `apply`.
pub struct Prepared {
    generation: u64,
    items: Vec<(KeyInput, Result<Arc<AgentKey>, Unusable>)>,
}

/// What an `apply` put in place, for the files.
pub struct Applied {
    pub list: PublicList,
    /// Keys that name hosts: entry id, public key, hosts.
    pub hosted: Vec<(String, Vec<u8>, Vec<String>)>,
}

pub struct Store {
    state: Mutex<State>,
    changed: Condvar,
}

struct Open {
    vault_id: String,
    keys: Vec<(PublicEntry, Arc<AgentKey>)>,
}

struct Pending {
    ask: Ask,
    key: Option<Vec<u8>>,
    answer: Option<bool>,
    waiters: usize,
    /// When it was asked, for listing them in order.
    order: u64,
}

type CacheEntry = ([u8; 32], Result<Arc<AgentKey>, Unusable>);

#[derive(Default)]
struct State {
    enabled: bool,
    ask_each_use: bool,
    open: Option<Open>,
    lists: Vec<PublicList>,
    unusable: Vec<UnusableKey>,
    cache: HashMap<String, CacheEntry>,
    allowed_servers: HashSet<Vec<u8>>,
    pending: HashMap<String, Pending>,
    /// Bumped by every lock: work started before it is thrown away.
    generation: u64,
    claimed: HashMap<String, u64>,
    applied: HashMap<String, u64>,
    asked: u64,
}

/// What one request is after.
enum Target<'a> {
    List,
    Sign(&'a [u8]),
}

enum Decision {
    Proceed(Option<Arc<AgentKey>>),
    Ask {
        mode: Mode,
        vault: Option<(String, String)>,
        key_name: Option<String>,
    },
    Fail,
}

impl Store {
    pub fn new(lists: Vec<PublicList>, enabled: bool, ask_each_use: bool) -> Self {
        Self {
            state: Mutex::new(State {
                enabled,
                ask_each_use,
                lists,
                ..State::default()
            }),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The next sequence number for `vault_id`, taken before any work so a slow older save can be
    /// told from a newer one.
    pub fn claim(&self, vault_id: &str) -> u64 {
        let mut st = self.state();
        let seq = st.claimed.entry(vault_id.to_string()).or_insert(0);
        *seq += 1;
        *seq
    }

    /// Parse `keys`, through the cache, without holding the state lock while a key opens: an
    /// encrypted key is deliberately slow, and requests must not wait on it.
    pub fn prepare(&self, keys: Vec<KeyInput>) -> Prepared {
        let hashes: Vec<[u8; 32]> = keys.iter().map(cache_key).collect();
        let (generation, mut hits) = {
            let st = self.state();
            let hits: Vec<_> = keys
                .iter()
                .zip(&hashes)
                .map(|(k, h)| match st.cache.get(&k.id) {
                    Some((cached, result)) if cached == h => Some(result.clone()),
                    _ => None,
                })
                .collect();
            (st.generation, hits)
        };
        let items: Vec<_> = keys
            .into_iter()
            .zip(hits.iter_mut())
            .map(|(k, hit)| {
                let result = hit.take().unwrap_or_else(|| {
                    keys::parse(&k.private_key, k.passphrase.as_deref()).map(Arc::new)
                });
                (k, result)
            })
            .collect();
        let mut st = self.state();
        if st.generation == generation {
            for ((k, result), hash) in items.iter().zip(hashes) {
                st.cache.insert(k.id.clone(), (hash, result.clone()));
            }
        }
        Prepared { generation, items }
    }

    /// Put prepared keys in place as the open vault's. Nothing changes, and `None` comes back,
    /// when a later save for this vault already applied, a lock happened since `prepare`, or the
    /// agent is off.
    pub fn apply(
        &self,
        seq: u64,
        vault_id: &str,
        vault_name: &str,
        prepared: Prepared,
        locked: bool,
    ) -> Option<Applied> {
        let mut st = self.state();
        // Locked before the keys arrived (a later lock moves the generation instead). Their
        // parse went into the cache after the lock emptied it, so empty it again.
        if locked {
            st.cache.clear();
            return None;
        }
        if !st.enabled || prepared.generation != st.generation {
            return None;
        }
        if st.applied.get(vault_id).is_some_and(|done| *done >= seq) {
            return None;
        }
        st.applied.insert(vault_id.to_string(), seq);
        let mut open = Vec::new();
        let mut unusable = Vec::new();
        let mut hosted = Vec::new();
        for (input, result) in prepared.items {
            match result {
                Ok(key) => {
                    let blob = key.public_blob().to_vec();
                    if !input.hosts.is_empty() {
                        hosted.push((input.id.clone(), blob.clone(), input.hosts.clone()));
                    }
                    let entry = PublicEntry {
                        entry_id: input.id.clone(),
                        name: input.name.clone(),
                        public_key: blob,
                    };
                    open.push((entry, key));
                }
                Err(reason) => unusable.push(UnusableKey {
                    entry_id: input.id.clone(),
                    name: input.name.clone(),
                    reason,
                }),
            }
        }
        let list = PublicList {
            vault_id: vault_id.to_string(),
            vault_name: vault_name.to_string(),
            keys: open.iter().map(|(e, _)| e.clone()).collect(),
        };
        st.lists.retain(|l| l.vault_id != vault_id);
        st.lists.insert(0, list.clone());
        st.open = Some(Open {
            vault_id: vault_id.to_string(),
            keys: open,
        });
        st.unusable = unusable;
        drop(st);
        self.changed.notify_all();
        Some(Applied { list, hosted })
    }

    /// Lock: drop every decrypted key, the parse cache and the servers allowed with `ssh -A`.
    pub fn forget_keys(&self) {
        let mut st = self.state();
        forget(&mut st);
        drop(st);
        self.changed.notify_all();
    }

    /// A vault was deleted or left the picker.
    pub fn forget_vault(&self, vault_id: &str) {
        let mut st = self.state();
        st.lists.retain(|l| l.vault_id != vault_id);
        if st.open.as_ref().is_some_and(|o| o.vault_id == vault_id) {
            forget(&mut st);
        }
        drop(st);
        self.changed.notify_all();
    }

    pub fn set_enabled(&self, on: bool) {
        let mut st = self.state();
        st.enabled = on;
        if !on {
            forget(&mut st);
            st.lists.clear();
        }
        drop(st);
        self.changed.notify_all();
    }

    pub fn enabled(&self) -> bool {
        self.state().enabled
    }

    pub fn ask_each_use(&self) -> bool {
        self.state().ask_each_use
    }

    pub fn set_ask_each_use(&self, on: bool) {
        self.state().ask_each_use = on;
        self.changed.notify_all();
    }

    /// Drop the lists of vaults the picker no longer shows. Requests waiting on them fail now.
    pub fn prune(&self, listed: &[String]) {
        self.state().lists.retain(|l| listed.contains(&l.vault_id));
        self.changed.notify_all();
    }

    /// The questions waiting for an answer, oldest first, for a window that opens after they
    /// were sent.
    pub fn pending_asks(&self) -> Vec<Ask> {
        let st = self.state();
        let mut pending: Vec<_> = st.pending.values().collect();
        pending.sort_by_key(|p| p.order);
        pending.into_iter().map(|p| p.ask.clone()).collect()
    }

    pub fn unusable(&self) -> Vec<UnusableKey> {
        self.state().unusable.clone()
    }

    /// The keys to offer: the open vault's first, then every other vault's, each once.
    pub fn list(
        &self,
        conn: &Conn,
        hooks: &dyn Hooks,
        timeout: Duration,
    ) -> Vec<(Vec<u8>, String)> {
        match self.run(Target::List, None, conn, hooks, timeout) {
            Some(_) => identities(&self.state()),
            None => Vec::new(),
        }
    }

    /// A wire signature, or `None` for a failure.
    pub fn sign(
        &self,
        blob: &[u8],
        data: &[u8],
        flags: u32,
        conn: &Conn,
        hooks: &dyn Hooks,
        timeout: Duration,
    ) -> Option<Vec<u8>> {
        let purpose = protocol::purpose(data);
        let key = self.run(Target::Sign(blob), Some(purpose), conn, hooks, timeout)??;
        key.sign(data, flags).ok()
    }

    /// The user's answer to an ask.
    /// Fail every waiting request, as Cancel on each would: the user closed the window showing
    /// them.
    pub fn cancel_all(&self) {
        let mut st = self.state();
        for p in st.pending.values_mut() {
            p.answer.get_or_insert(false);
        }
        drop(st);
        self.changed.notify_all();
    }

    pub fn answer(&self, id: &str, approve: bool) {
        let mut st = self.state();
        if let Some(p) = st.pending.get_mut(id) {
            p.answer = Some(approve);
        }
        drop(st);
        self.changed.notify_all();
    }

    #[cfg(test)]
    pub(crate) fn cached(&self) -> usize {
        self.state().cache.len()
    }

    /// Decide, ask if needed, and wait until the decision is to proceed or fail. `Some(key)` to
    /// sign with (always `Some(None)` for a list), `None` to fail.
    ///
    /// A request waits on one ask at a time. When what it needs changes (an unlock answered for
    /// another vault becomes a switch, an unlock under Ask before each use becomes a confirm), it
    /// leaves that ask and asks again, so the window always shows what the request now needs.
    fn run(
        &self,
        target: Target,
        purpose: Option<Purpose>,
        conn: &Conn,
        hooks: &dyn Hooks,
        timeout: Duration,
    ) -> Option<Option<Arc<AgentKey>>> {
        let deadline = Instant::now() + timeout;
        // The ask this request waits on, and whether it made it.
        let mut mine: Option<(String, bool)> = None;
        let mut st = self.state();
        let outcome = loop {
            let locked = hooks.locked();
            let pending = mine.as_ref().and_then(|(id, _)| st.pending.get(id));
            let answer = pending.and_then(|p| p.answer);
            let asked = pending.map(|p| p.ask.mode);
            let created = mine.as_ref().is_some_and(|(_, c)| *c);
            if let Some(host_key) = &conn.forwarded_by {
                // A yes to the server card, or an unlock this request asked for, allows the server.
                let unlocked_for_it = asked == Some(Mode::Unlock) && !locked && st.open.is_some();
                if answer == Some(true) || unlocked_for_it {
                    st.allowed_servers.insert(host_key.clone());
                }
            }
            // A yes, or an unlock or switch the request waited on, approves it. Under Ask before
            // each use only the request that brought the card up counts it as its own yes.
            let approved = answer == Some(true)
                || (matches!(asked, Some(Mode::Unlock | Mode::Switch))
                    && (created || !st.ask_each_use));
            match decide(&st, &target, conn, locked, answer, approved) {
                Decision::Proceed(key) => break Some(key),
                Decision::Fail => break None,
                Decision::Ask {
                    mode,
                    vault,
                    key_name,
                } => {
                    let vault_id = vault.as_ref().map(|v| v.0.clone());
                    if let Some((id, _)) = mine.take() {
                        let same = st
                            .pending
                            .get(&id)
                            .is_some_and(|p| p.ask.mode == mode && p.ask.vault_id == vault_id);
                        if same {
                            mine = Some((id, created));
                        } else if let Some(ended) = leave(&mut st, &id) {
                            drop(st);
                            hooks.done(&ended);
                            st = self.state();
                            continue;
                        }
                    }
                    if mine.is_none() {
                        let blob = match &target {
                            Target::Sign(b) if mode == Mode::Confirm => Some(b.to_vec()),
                            _ => None,
                        };
                        // Never join a confirm: each use is its own yes. Never join one already
                        // answered: that answer was for the requests waiting then.
                        let joined = (mode != Mode::Confirm)
                            .then(|| {
                                st.pending.iter_mut().find(|(_, p)| {
                                    p.answer.is_none()
                                        && p.ask.mode == mode
                                        && p.ask.vault_id == vault_id
                                        && p.ask.server == conn.server
                                        && p.key == blob
                                })
                            })
                            .flatten();
                        if let Some((id, p)) = joined {
                            p.waiters += 1;
                            let ask = p.ask.clone();
                            mine = Some((id.clone(), false));
                            drop(st);
                            hooks.raise(&ask);
                            st = self.state();
                            continue;
                        } else if st.pending.len() >= MAX_PENDING {
                            break None;
                        } else {
                            st.asked += 1;
                            let ask = Ask {
                                id: request_id(),
                                vault_id,
                                vault_name: vault.map(|v| v.1),
                                key_name,
                                caller: conn.caller.clone(),
                                purpose,
                                server: conn.server.clone(),
                                mode,
                            };
                            let id = ask.id.clone();
                            let order = st.asked;
                            st.pending.insert(
                                id.clone(),
                                Pending {
                                    ask: ask.clone(),
                                    key: blob,
                                    answer: None,
                                    waiters: 1,
                                    order,
                                },
                            );
                            mine = Some((id, true));
                            drop(st);
                            hooks.ask(&ask);
                            st = self.state();
                            continue;
                        }
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        break None;
                    }
                    st = self
                        .changed
                        .wait_timeout(st, deadline - now)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
        };
        if let Some((id, _)) = mine {
            if let Some(ended) = leave(&mut st, &id) {
                drop(st);
                hooks.done(&ended);
            }
        }
        outcome
    }
}

/// Stop waiting on an ask; the id back when this was its last waiter, for `done`.
fn leave(st: &mut State, id: &str) -> Option<String> {
    let last = st.pending.get_mut(id).is_some_and(|p| {
        p.waiters -= 1;
        p.waiters == 0
    });
    if last {
        st.pending.remove(id);
        Some(id.to_string())
    } else {
        None
    }
}

fn forget(st: &mut State) {
    st.open = None;
    st.cache.clear();
    st.unusable.clear();
    st.allowed_servers.clear();
    st.generation += 1;
}

/// The one decision, re-made on every wake. `answer` and `approved` are this request's own.
fn decide(
    st: &State,
    target: &Target,
    conn: &Conn,
    locked: bool,
    answer: Option<bool>,
    approved: bool,
) -> Decision {
    if !st.enabled || answer == Some(false) {
        return Decision::Fail;
    }
    let blob = match target {
        Target::Sign(b) => Some(*b),
        Target::List => None,
    };
    let owner = blob.and_then(|b| owner_of(st, b));
    let open_key = blob.and_then(|b| {
        st.open
            .as_ref()
            .and_then(|o| o.keys.iter().find(|(e, _)| e.public_key == b))
    });
    let unlocked = !locked && st.open.is_some();
    if let Some(host_key) = &conn.forwarded_by {
        if !st.allowed_servers.contains(host_key) {
            let mode = if unlocked {
                Mode::AllowServer
            } else {
                Mode::Unlock
            };
            return Decision::Ask {
                mode,
                vault: owner.as_ref().map(|(v, ..)| v.clone()),
                key_name: owner.map(|(.., name)| name),
            };
        }
    }
    if blob.is_none() {
        return Decision::Proceed(None);
    }
    if let (Some((entry, key)), false) = (open_key, locked) {
        if st.ask_each_use && !approved {
            let vault = st.open.as_ref().map(|o| o.vault_id.clone());
            let name = st
                .lists
                .iter()
                .find(|l| Some(&l.vault_id) == vault.as_ref())
                .map(|l| l.vault_name.clone())
                .unwrap_or_default();
            return Decision::Ask {
                mode: Mode::Confirm,
                vault: vault.map(|v| (v, name)),
                key_name: Some(entry.name.clone()),
            };
        }
        return Decision::Proceed(Some(key.clone()));
    }
    let Some(((vault_id, vault_name), name)) = owner else {
        return Decision::Fail;
    };
    let mode = if unlocked { Mode::Switch } else { Mode::Unlock };
    Decision::Ask {
        mode,
        vault: Some((vault_id, vault_name)),
        key_name: Some(name),
    }
}

/// The vault (id, name) and key name a public key belongs to: the open vault if it holds it,
/// else the list written last.
fn owner_of(st: &State, blob: &[u8]) -> Option<((String, String), String)> {
    st.lists.iter().find_map(|l| {
        l.keys
            .iter()
            .find(|e| e.public_key == blob)
            .map(|e| ((l.vault_id.clone(), l.vault_name.clone()), e.name.clone()))
    })
}

fn identities(st: &State) -> Vec<(Vec<u8>, String)> {
    let mut seen = HashSet::new();
    let open = st.open.iter().flat_map(|o| o.keys.iter().map(|(e, _)| e));
    let rest = st
        .lists
        .iter()
        .filter(|l| st.open.as_ref().map(|o| &o.vault_id) != Some(&l.vault_id))
        .flat_map(|l| l.keys.iter());
    open.chain(rest)
        .filter(|e| seen.insert(e.public_key.clone()))
        .map(|e| (e.public_key.clone(), e.name.clone()))
        .collect()
}

fn cache_key(k: &KeyInput) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(k.private_key.as_bytes());
    h.update([0]);
    h.update(k.passphrase.as_deref().unwrap_or("").as_bytes());
    h.finalize().into()
}

fn request_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("os randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- the lists on disk ----

const LISTS_DIR: &str = "ssh-agent";

/// A vault id safe to put in a path: the ids are UUIDs, so anything else is refused.
pub fn valid_vault_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn list_path(root: &Path, vault_id: &str) -> io::Result<PathBuf> {
    if !valid_vault_id(vault_id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "vault id"));
    }
    Ok(root.join(LISTS_DIR).join(format!("{vault_id}.json")))
}

/// Every vault's list from `<root>/ssh-agent`, the one written last first. Unreadable files are
/// skipped: the next time their vault opens rewrites them.
pub fn read_lists(root: &Path) -> Vec<PublicList> {
    let Ok(entries) = fs::read_dir(root.join(LISTS_DIR)) else {
        return Vec::new();
    };
    let mut lists: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let modified = e.metadata().and_then(|m| m.modified()).ok()?;
            let list: PublicList = serde_json::from_slice(&fs::read(e.path()).ok()?).ok()?;
            valid_vault_id(&list.vault_id).then_some((modified, list))
        })
        .collect();
    lists.sort_by(|a, b| b.0.cmp(&a.0));
    lists.into_iter().map(|(_, l)| l).collect()
}

pub fn write_list(root: &Path, list: &PublicList) -> io::Result<()> {
    let path = list_path(root, &list.vault_id)?;
    let json = serde_json::to_vec(list).map_err(io::Error::other)?;
    write_private(&path, &json)
}

pub fn delete_list(root: &Path, vault_id: &str) -> io::Result<()> {
    match fs::remove_file(list_path(root, vault_id)?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn prune_lists(root: &Path, listed: &[String]) -> io::Result<()> {
    for list in read_lists(root) {
        if !listed.contains(&list.vault_id) {
            delete_list(root, &list.vault_id)?;
        }
    }
    Ok(())
}

pub fn delete_all(root: &Path) -> io::Result<()> {
    match fs::remove_dir_all(root.join(LISTS_DIR)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Write `bytes` to `path` through a temporary file and a rename, so a reader never sees half of
/// it: the folder owner-only, the file too.
pub(super) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent"))?;
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("no name"))?;
    let tmp = dir.join(format!(".{}.tmp", name.to_string_lossy()));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

mod b64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    const ED: &str = include_str!("fixtures/ed25519");
    const ED_ENC: &str = include_str!("fixtures/ed25519-enc");
    const ECDSA: &str = include_str!("fixtures/ecdsa256");
    const SHORT: Duration = Duration::from_millis(300);
    const LONG: Duration = Duration::from_secs(10);

    #[derive(Default)]
    struct TestHooks {
        locked: AtomicBool,
        asks: Mutex<Vec<Ask>>,
        raised: Mutex<Vec<String>>,
        done: Mutex<Vec<String>>,
    }

    impl Hooks for TestHooks {
        fn locked(&self) -> bool {
            self.locked.load(Ordering::SeqCst)
        }
        fn ask(&self, ask: &Ask) {
            self.asks.lock().unwrap().push(ask.clone());
        }
        fn raise(&self, ask: &Ask) {
            self.raised.lock().unwrap().push(ask.id.clone());
        }
        fn done(&self, id: &str) {
            self.done.lock().unwrap().push(id.to_string());
        }
    }

    impl TestHooks {
        fn locked() -> Arc<Self> {
            let h = Arc::new(Self::default());
            h.locked.store(true, Ordering::SeqCst);
            h
        }
        fn asks(&self) -> Vec<Ask> {
            self.asks.lock().unwrap().clone()
        }
        /// The first ask, once a request on another thread has made it.
        fn wait_ask(&self) -> Ask {
            for _ in 0..200 {
                if let Some(a) = self.asks().first() {
                    return a.clone();
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!("no ask arrived");
        }
    }

    fn key(id: &str, name: &str, pem: &str, pass: Option<&str>, hosts: &[&str]) -> KeyInput {
        KeyInput {
            id: id.into(),
            name: name.into(),
            private_key: pem.into(),
            passphrase: pass.map(Into::into),
            hosts: hosts.iter().map(|h| h.to_string()).collect(),
        }
    }

    fn open(store: &Store, vault: &str, keys: Vec<KeyInput>) -> Option<Applied> {
        let seq = store.claim(vault);
        let prepared = store.prepare(keys);
        store.apply(seq, vault, &format!("{vault} vault"), prepared, false)
    }

    fn blob(pem: &str) -> Vec<u8> {
        keys::parse(pem, None).unwrap().public_blob().to_vec()
    }

    fn list_of(vault: &str, entries: &[(&str, Vec<u8>)]) -> PublicList {
        PublicList {
            vault_id: vault.into(),
            vault_name: format!("{vault} vault"),
            keys: entries
                .iter()
                .map(|(name, b)| PublicEntry {
                    entry_id: format!("{vault}-{name}"),
                    name: (*name).into(),
                    public_key: b.clone(),
                })
                .collect(),
        }
    }

    fn local() -> Conn {
        Conn {
            caller: "ssh".into(),
            forwarded_by: None,
            server: None,
        }
    }

    fn forwarded(host_key: &[u8]) -> Conn {
        Conn {
            caller: "ssh".into(),
            forwarded_by: Some(host_key.to_vec()),
            server: Some("bastion".into()),
        }
    }

    fn unlocked() -> Arc<TestHooks> {
        Arc::new(TestHooks::default())
    }

    #[test]
    fn identities_put_the_open_vault_first() {
        let store = Store::new(vec![list_of("A", &[("Old", blob(ECDSA))])], true, false);
        open(&store, "B", vec![key("b1", "Deploy", ED, None, &[])]).unwrap();
        let ids = store.list(&local(), &*unlocked(), SHORT);
        assert_eq!(
            ids,
            vec![
                (blob(ED), "Deploy".to_string()),
                (blob(ECDSA), "Old".to_string())
            ]
        );
    }

    #[test]
    fn apply_lists_only_keys_that_sign() {
        let store = Store::new(vec![], true, false);
        let applied = open(
            &store,
            "A",
            vec![
                key("1", "Good", ED, None, &[]),
                key("2", "Locked", ED_ENC, Some("nope"), &[]),
            ],
        )
        .unwrap();
        assert_eq!(applied.list.keys.len(), 1);
        assert_eq!(store.list(&local(), &*unlocked(), SHORT).len(), 1);
        let unusable = store.unusable();
        assert_eq!(unusable.len(), 1);
        assert_eq!(unusable[0].entry_id, "2");
        assert_eq!(unusable[0].reason, Unusable::WrongPassphrase);
    }

    #[test]
    fn a_lock_during_prepare_keeps_nothing() {
        let store = Store::new(vec![], true, false);
        let seq = store.claim("A");
        let prepared = store.prepare(vec![key("1", "K", ED, None, &[])]);
        store.forget_keys();
        assert!(store.apply(seq, "A", "A vault", prepared, false).is_none());
        assert!(store.list(&local(), &*unlocked(), SHORT).is_empty());
        assert_eq!(store.cached(), 0);
    }

    #[test]
    fn an_older_apply_is_dropped() {
        let store = Store::new(vec![], true, false);
        let first = store.claim("A");
        let second = store.claim("A");
        let p1 = store.prepare(vec![key("1", "Old", ED, None, &[])]);
        let p2 = store.prepare(vec![key("2", "New", ECDSA, None, &[])]);
        assert!(store.apply(second, "A", "A vault", p2, false).is_some());
        assert!(store.apply(first, "A", "A vault", p1, false).is_none());
        let ids = store.list(&local(), &*unlocked(), SHORT);
        assert_eq!(ids, vec![(blob(ECDSA), "New".to_string())]);
    }

    #[test]
    fn prepare_does_not_block_requests() {
        let store = Arc::new(Store::new(vec![], true, false));
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        let finished = Arc::new(AtomicBool::new(false));
        let worker = {
            let (store, finished) = (store.clone(), finished.clone());
            thread::spawn(move || {
                let many = (0..10)
                    .map(|i| key(&format!("e{i}"), "E", ED_ENC, Some("correct horse"), &[]))
                    .collect();
                store.prepare(many);
                finished.store(true, Ordering::SeqCst);
            })
        };
        thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        assert_eq!(store.list(&local(), &*unlocked(), SHORT).len(), 1);
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "list waited on prepare"
        );
        assert!(
            !finished.load(Ordering::SeqCst),
            "prepare finished too soon to tell"
        );
        worker.join().unwrap();
    }

    #[test]
    fn applied_hosted_pairs_blobs_with_hosts() {
        let store = Store::new(vec![], true, false);
        let applied = open(
            &store,
            "A",
            vec![
                key("1", "Hosted", ED, None, &["github.com"]),
                key("2", "Plain", ECDSA, None, &[]),
            ],
        )
        .unwrap();
        assert_eq!(
            applied.hosted,
            vec![("1".to_string(), blob(ED), vec!["github.com".to_string()])]
        );
    }

    #[test]
    fn a_key_in_two_vaults_is_listed_once_and_the_open_one_signs() {
        let store = Store::new(vec![list_of("A", &[("Copy", blob(ED))])], true, false);
        open(&store, "B", vec![key("b1", "Deploy", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        assert_eq!(store.list(&local(), &*hooks, SHORT).len(), 1);
        assert!(store
            .sign(&blob(ED), b"data", 0, &local(), &*hooks, SHORT)
            .is_some());
        assert!(hooks.asks().is_empty());
    }

    #[test]
    fn signs_without_asking_while_unlocked() {
        let store = Store::new(vec![], true, false);
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        assert!(store
            .sign(&blob(ED), b"data", 0, &local(), &*hooks, SHORT)
            .is_some());
        assert!(hooks.asks().is_empty());
    }

    #[test]
    fn ask_each_use_confirms_every_signature() {
        let store = Arc::new(Store::new(vec![], true, true));
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        for round in 1..=2 {
            let hooks = unlocked();
            let waiter = {
                let (store, hooks) = (store.clone(), hooks.clone());
                thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
            };
            let ask = hooks.wait_ask();
            assert_eq!(ask.mode, Mode::Confirm, "round {round}");
            store.answer(&ask.id, true);
            assert!(waiter.join().unwrap().is_some());
        }
    }

    #[test]
    fn locked_asks_to_unlock_then_signs_when_keys_arrive() {
        let store = Arc::new(Store::new(
            vec![list_of("A", &[("Deploy", blob(ED))])],
            true,
            false,
        ));
        let hooks = TestHooks::locked();
        let waiter = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
        };
        let ask = hooks.wait_ask();
        assert_eq!(ask.mode, Mode::Unlock);
        assert_eq!(ask.vault_id.as_deref(), Some("A"));
        assert_eq!(ask.key_name.as_deref(), Some("Deploy"));
        hooks.locked.store(false, Ordering::SeqCst);
        open(&store, "A", vec![key("1", "Deploy", ED, None, &[])]).unwrap();
        assert!(waiter.join().unwrap().is_some());
        assert_eq!(*hooks.done.lock().unwrap(), vec![ask.id]);
    }

    #[test]
    fn another_open_vault_asks_to_switch() {
        let store = Arc::new(Store::new(
            vec![list_of("W", &[("Deploy", blob(ECDSA))])],
            true,
            false,
        ));
        open(&store, "P", vec![key("1", "Mine", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        let waiter = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ECDSA), b"d", 0, &local(), &*hooks, SHORT))
        };
        let ask = hooks.wait_ask();
        assert_eq!(
            (ask.mode, ask.vault_id.as_deref()),
            (Mode::Switch, Some("W"))
        );
        assert!(waiter.join().unwrap().is_none());
    }

    #[test]
    fn a_forwarded_server_is_asked_once_until_lock() {
        let store = Arc::new(Store::new(vec![], true, false));
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        let lister = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.list(&forwarded(b"HK"), &*hooks, LONG))
        };
        let ask = hooks.wait_ask();
        assert_eq!(
            (ask.mode, ask.server.as_deref()),
            (Mode::AllowServer, Some("bastion"))
        );
        store.answer(&ask.id, true);
        assert_eq!(lister.join().unwrap().len(), 1);
        assert!(store
            .sign(&blob(ED), b"d", 0, &forwarded(b"HK"), &*hooks, SHORT)
            .is_some());
        assert_eq!(hooks.asks().len(), 1);

        store.forget_keys();
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        assert!(store.list(&forwarded(b"HK"), &*hooks, SHORT).is_empty());
        assert_eq!(hooks.asks().len(), 2);
    }

    #[test]
    fn a_denied_server_gets_an_empty_list() {
        let store = Arc::new(Store::new(vec![], true, false));
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        let lister = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.list(&forwarded(b"HK"), &*hooks, LONG))
        };
        store.answer(&hooks.wait_ask().id, false);
        assert!(lister.join().unwrap().is_empty());
    }

    #[test]
    fn one_unlock_serves_every_waiter() {
        let store = Arc::new(Store::new(
            vec![list_of("A", &[("K", blob(ED))])],
            true,
            false,
        ));
        let hooks = TestHooks::locked();
        let waiters: Vec<_> = (0..2)
            .map(|_| {
                let (store, hooks) = (store.clone(), hooks.clone());
                thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
            })
            .collect();
        hooks.wait_ask();
        thread::sleep(Duration::from_millis(50));
        hooks.locked.store(false, Ordering::SeqCst);
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        for w in waiters {
            assert!(w.join().unwrap().is_some());
        }
        assert_eq!(hooks.asks().len(), 1);
    }

    #[test]
    fn forgetting_a_vault_fails_its_waiters_now() {
        for disable in [false, true] {
            let store = Arc::new(Store::new(
                vec![list_of("A", &[("K", blob(ED))])],
                true,
                false,
            ));
            let hooks = TestHooks::locked();
            let waiter = {
                let (store, hooks) = (store.clone(), hooks.clone());
                thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
            };
            hooks.wait_ask();
            let started = Instant::now();
            if disable {
                store.set_enabled(false);
            } else {
                store.forget_vault("A");
            }
            assert!(waiter.join().unwrap().is_none());
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }

    #[test]
    fn an_allow_after_a_lock_signs_nothing() {
        let store = Arc::new(Store::new(vec![], true, true));
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        let waiter = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT))
        };
        let ask = hooks.wait_ask();
        hooks.locked.store(true, Ordering::SeqCst);
        store.forget_keys();
        store.answer(&ask.id, true);
        assert!(waiter.join().unwrap().is_none());
    }

    #[test]
    fn the_ninth_waiter_fails_at_once() {
        let lists = (0..9)
            .map(|i| list_of(&format!("V{i}"), &[("K", vec![i as u8; 8])]))
            .collect();
        let store = Arc::new(Store::new(lists, true, false));
        let hooks = TestHooks::locked();
        let waiters: Vec<_> = (0..8u8)
            .map(|i| {
                let (store, hooks) = (store.clone(), hooks.clone());
                thread::spawn(move || store.sign(&[i; 8], b"d", 0, &local(), &*hooks, SHORT))
            })
            .collect();
        for _ in 0..200 {
            if hooks.asks().len() == 8 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let started = Instant::now();
        assert!(store
            .sign(&[8; 8], b"d", 0, &local(), &*hooks, LONG)
            .is_none());
        assert!(started.elapsed() < Duration::from_millis(100));
        for w in waiters {
            w.join().unwrap();
        }
    }

    #[test]
    fn times_out_with_a_failure_and_says_done() {
        let store = Store::new(vec![list_of("A", &[("K", blob(ED))])], true, false);
        let hooks = TestHooks::locked();
        assert!(store
            .sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT)
            .is_none());
        let asks = hooks.asks();
        assert_eq!(*hooks.done.lock().unwrap(), vec![asks[0].id.clone()]);
    }

    #[test]
    fn keys_sent_after_a_lock_are_not_loaded() {
        let store = Store::new(vec![], true, false);
        let seq = store.claim("A");
        let prepared = store.prepare(vec![key("1", "K", ED, None, &[])]);
        assert!(store.apply(seq, "A", "A vault", prepared, true).is_none());
        assert!(store.list(&local(), &*unlocked(), SHORT).is_empty());
        assert_eq!(store.cached(), 0, "a locked apply keeps nothing");
    }

    #[test]
    fn an_unlock_ask_becomes_a_switch_for_the_next_vault() {
        let lists = vec![
            list_of("A", &[("KA", blob(ED))]),
            list_of("B", &[("KB", blob(ECDSA))]),
        ];
        let store = Arc::new(Store::new(lists, true, false));
        let hooks = TestHooks::locked();
        let b = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ECDSA), b"d", 0, &local(), &*hooks, LONG))
        };
        let first = hooks.wait_ask();
        assert_eq!(
            (first.mode, first.vault_id.as_deref()),
            (Mode::Unlock, Some("B"))
        );
        hooks.locked.store(false, Ordering::SeqCst);
        open(&store, "A", vec![key("1", "KA", ED, None, &[])]).unwrap();
        for _ in 0..200 {
            if hooks.asks().len() == 2 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let asks = hooks.asks();
        assert_eq!(asks.len(), 2, "{asks:?}");
        assert_eq!(
            (asks[1].mode, asks[1].vault_id.as_deref()),
            (Mode::Switch, Some("B"))
        );
        assert!(
            hooks.done.lock().unwrap().contains(&first.id),
            "the old ask ends"
        );
        store.answer(&asks[1].id, false);
        assert!(b.join().unwrap().is_none());
    }

    #[test]
    fn confirm_asks_are_never_joined() {
        let store = Arc::new(Store::new(vec![], true, true));
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        let hooks = unlocked();
        let waiters: Vec<_> = (0..2)
            .map(|_| {
                let (store, hooks) = (store.clone(), hooks.clone());
                thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT))
            })
            .collect();
        for w in waiters {
            w.join().unwrap();
        }
        let asks = hooks.asks();
        assert_eq!(asks.len(), 2);
        assert!(asks.iter().all(|a| a.mode == Mode::Confirm));
    }

    #[test]
    fn under_ask_each_use_an_unlock_approves_only_the_request_that_asked() {
        let store = Arc::new(Store::new(
            vec![list_of("A", &[("K", blob(ED))])],
            true,
            true,
        ));
        let hooks = TestHooks::locked();
        let first = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
        };
        hooks.wait_ask();
        let second = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT))
        };
        thread::sleep(Duration::from_millis(50));
        assert_eq!(hooks.asks().len(), 1, "the second joins the unlock");
        hooks.locked.store(false, Ordering::SeqCst);
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        assert!(first.join().unwrap().is_some(), "the unlock was its yes");
        assert!(second.join().unwrap().is_none(), "it needed its own yes");
        let asks = hooks.asks();
        assert_eq!(asks.last().map(|a| a.mode), Some(Mode::Confirm));
    }

    #[test]
    fn a_request_that_joins_a_waiting_ask_brings_the_window_forward_again() {
        let store = Arc::new(Store::new(
            vec![list_of("A", &[("K", blob(ED))])],
            true,
            false,
        ));
        let hooks = TestHooks::locked();
        let first = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT))
        };
        let ask = hooks.wait_ask();
        let second = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT))
        };
        thread::sleep(Duration::from_millis(50));
        assert_eq!(hooks.asks().len(), 1, "the second joins the unlock");
        assert_eq!(*hooks.raised.lock().unwrap(), vec![ask.id]);
        assert!(first.join().unwrap().is_none());
        assert!(second.join().unwrap().is_none());
    }

    #[test]
    fn cancel_all_fails_every_waiting_request_at_once() {
        let lists = vec![
            list_of("A", &[("KA", blob(ED))]),
            list_of("B", &[("KB", blob(ECDSA))]),
        ];
        let store = Arc::new(Store::new(lists, true, false));
        let hooks = TestHooks::locked();
        let a = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
        };
        hooks.wait_ask();
        let b = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ECDSA), b"d", 0, &local(), &*hooks, LONG))
        };
        for _ in 0..200 {
            if store.pending_asks().len() == 2 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(store.pending_asks().len(), 2);
        let started = Instant::now();
        store.cancel_all();
        assert!(a.join().unwrap().is_none());
        assert!(b.join().unwrap().is_none());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "not left to time out"
        );
        assert!(store.pending_asks().is_empty());
    }

    #[test]
    fn pending_asks_are_listed_in_order() {
        let lists = vec![
            list_of("A", &[("KA", blob(ED))]),
            list_of("B", &[("KB", blob(ECDSA))]),
        ];
        let store = Arc::new(Store::new(lists, true, false));
        let hooks = TestHooks::locked();
        let a = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, SHORT))
        };
        hooks.wait_ask();
        let b = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ECDSA), b"d", 0, &local(), &*hooks, SHORT))
        };
        thread::sleep(Duration::from_millis(50));
        let pending: Vec<_> = store
            .pending_asks()
            .into_iter()
            .map(|a| a.vault_id)
            .collect();
        assert_eq!(pending, [Some("A".to_string()), Some("B".to_string())]);
        a.join().unwrap();
        b.join().unwrap();
        assert!(store.pending_asks().is_empty());
    }

    #[test]
    fn pruning_a_vault_wakes_its_waiters() {
        let store = Arc::new(Store::new(
            vec![list_of("A", &[("K", blob(ED))])],
            true,
            false,
        ));
        let hooks = TestHooks::locked();
        let waiter = {
            let (store, hooks) = (store.clone(), hooks.clone());
            thread::spawn(move || store.sign(&blob(ED), b"d", 0, &local(), &*hooks, LONG))
        };
        hooks.wait_ask();
        let started = Instant::now();
        store.prune(&[]);
        assert!(waiter.join().unwrap().is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn cache_never_outlives_a_lock() {
        let store = Store::new(vec![], true, false);
        open(&store, "A", vec![key("1", "K", ED, None, &[])]).unwrap();
        assert_eq!(store.cached(), 1);
        store.forget_keys();
        assert_eq!(store.cached(), 0);
    }

    #[test]
    fn lists_round_trip_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let a = list_of("A", &[("K", vec![1, 2, 3])]);
        let b = list_of("B", &[("L", vec![4, 5])]);
        write_list(dir.path(), &a).unwrap();
        thread::sleep(Duration::from_millis(20));
        write_list(dir.path(), &b).unwrap();
        let read = read_lists(dir.path());
        assert_eq!(
            read.iter().map(|l| l.vault_id.as_str()).collect::<Vec<_>>(),
            ["B", "A"]
        );
        assert_eq!(read[1].keys[0].public_key, vec![1, 2, 3]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir.path().join("ssh-agent/A.json")), 0o600);
            assert_eq!(mode(&dir.path().join("ssh-agent")), 0o700);
        }
        prune_lists(dir.path(), &["A".to_string()]).unwrap();
        assert_eq!(read_lists(dir.path()).len(), 1);
        assert!(write_list(dir.path(), &list_of("../x", &[])).is_err());
        delete_all(dir.path()).unwrap();
        assert!(!dir.path().join("ssh-agent").exists());
    }
}
