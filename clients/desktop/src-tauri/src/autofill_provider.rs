//! The macOS AutoFill extension's copy of the vault, written where its sandbox can read it (the
//! App Group container), plus the identities the OS lists. See docs/macos-credential-provider.md.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The App Group the app and the extension share; read back with `codesign -d --entitlements`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const GROUP: &str = "BHGR3PP64J.group.app.bramble.desktop";
/// One copy per vault, `<vaultId>.json`, so the sheet can open any vault opened here.
const COPIES_DIR: &str = "autofill";
/// The single copy builds before per-vault copies kept. The first write removes it.
const LEGACY_MIRROR_FILE: &str = "autofill.json";
/// Passkeys the extension created, VEK-encrypted, for the app to merge into the vault.
const PENDING_FILE: &str = "pending-passkeys.json";

/// What the webview hands over: everything VEK-encrypted already, identities in the clear (they
/// are metadata, and go to the OS store rather than to disk).
#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    pub iv: String,
    pub ciphertext: String,
    #[serde(default)]
    pub vault_id: String,
    /// What the app calls the vault, for the sheet to show before it unlocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<serde_json::Value>,
    #[serde(default)]
    pub passkey_iv: String,
    #[serde(default)]
    pub passkey_ciphertext: String,
    #[serde(default, skip_serializing)]
    pub identities: Vec<PasswordIdentity>,
    #[serde(default, skip_serializing)]
    pub one_time_code_identities: Vec<CodeIdentity>,
    #[serde(default, skip_serializing)]
    pub passkey_identities: Vec<PasskeyIdentity>,
    /// The vaults the app lists. A copy of any other vault is pruned; empty prunes nothing.
    #[serde(default, skip_serializing)]
    pub listed_vault_ids: Vec<String>,
}

/// A copy on disk: the mirror, plus what the sheet reads before it unlocks.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnDisk<'a> {
    #[serde(flatten)]
    mirror: &'a Mirror,
    passkey_credential_ids: Vec<&'a str>,
    written_at: u64,
}

/// What a write changed besides the vault's own copy.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Written {
    /// The single copy from before was there, so its untagged identities are still in the store.
    pub legacy_removed: bool,
    /// Vaults whose copies went because the app no longer lists them.
    pub pruned: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasswordIdentity {
    pub record_id: String,
    pub username: String,
    pub service: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeIdentity {
    pub record_id: String,
    pub label: String,
    pub service: String,
}

/// credentialId and userHandle are STANDARD base64, as the core stores them.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyIdentity {
    pub credential_id: String,
    pub rp_id: String,
    pub user_name: String,
    pub user_handle: String,
}

/// The group container, asked of macOS as the extension does. Built from a path instead, it reads
/// to macOS 15+ as another app's data and asks the user every launch.
#[cfg(target_os = "macos")]
fn group_dir() -> Option<PathBuf> {
    use objc2::{
        msg_send,
        rc::{autoreleasepool, Retained},
        runtime::{AnyClass, AnyObject},
    };
    use objc2_foundation::NSString;

    let asked = autoreleasepool(|_| unsafe {
        let fm: Retained<AnyObject> = msg_send![AnyClass::get(c"NSFileManager")?, defaultManager];
        let url: Option<Retained<AnyObject>> = msg_send![
            &*fm,
            containerURLForSecurityApplicationGroupIdentifier: &*NSString::from_str(GROUP)
        ];
        let path: Option<Retained<NSString>> = msg_send![&*url?, path];
        path.map(|p| PathBuf::from(p.to_string()))
    });
    // An unsigned dev build has no group entitlement, so macOS answers nil.
    asked.or_else(path_group_dir)
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn group_dir() -> Option<PathBuf> {
    path_group_dir()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn path_group_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        PathBuf::from(h)
            .join("Library/Group Containers")
            .join(GROUP)
    })
}

/// What a copy write, a prune or a delete does to the store.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum StoreOp {
    Write,
    Prune,
    Delete,
}

/// What reading the store back gave: nothing below macOS 14.4, or no answer in time.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Read {
    Unsupported,
    Slow,
    Got,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq)]
enum Plan {
    ReplaceAll,
    RemoveTaggedThenSave,
    SaveOnly,
    RemoveTagged,
    ClearAll,
    Nothing,
}

/// Only what was read back says which identities are another vault's, so without it nothing but
/// this vault's own goes: a slow store skips removal rather than wiping every vault.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn store_plan(op: StoreOp, read: Read) -> Plan {
    match (op, read) {
        (StoreOp::Write, Read::Got) => Plan::RemoveTaggedThenSave,
        (StoreOp::Write, Read::Slow) => Plan::SaveOnly,
        (StoreOp::Write, Read::Unsupported) => Plan::ReplaceAll,
        (StoreOp::Prune | StoreOp::Delete, Read::Got) => Plan::RemoveTagged,
        // Below 14.4 the store holds the last vault's only: the deleted one's, never a pruned one's.
        (StoreOp::Delete, Read::Unsupported) => Plan::ClearAll,
        (StoreOp::Prune, Read::Unsupported) | (_, Read::Slow) => Plan::Nothing,
    }
}

/// A store identity's record identifier, carrying its vault so the sheet knows which to open.
fn tag(vault_id: &str, id: &str) -> String {
    format!("{vault_id}:{id}")
}

/// Whether a record identifier is one of `vault_id`'s. The colon keeps `v1` off `v10`'s.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn tagged_for(record_identifier: &str, vault_id: &str) -> bool {
    record_identifier
        .strip_prefix(vault_id)
        .is_some_and(|rest| rest.starts_with(':'))
}

fn copy_path(dir: &Path, vault_id: &str) -> Result<PathBuf, String> {
    crate::storage::ops::validate_vault_id(vault_id)?;
    Ok(dir.join(COPIES_DIR).join(format!("{vault_id}.json")))
}

fn remove_if_present(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

fn write_mirror(dir: &Path, mirror: &Mirror, now_ms: u64) -> Result<Written, String> {
    let path = copy_path(dir, &mirror.vault_id)?;
    let copies = dir.join(COPIES_DIR);
    fs::create_dir_all(&copies).map_err(|e| format!("group container: {e}"))?;
    let copy = OnDisk {
        mirror,
        passkey_credential_ids: mirror
            .passkey_identities
            .iter()
            .map(|p| p.credential_id.as_str())
            .collect(),
        written_at: now_ms,
    };
    let tmp = copies.join(format!("{}.json.tmp", mirror.vault_id));
    let body = serde_json::to_vec(&copy).map_err(|e| format!("encode mirror: {e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("write mirror: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("restrict mirror: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("write mirror: {e}"))?;
    let legacy_removed = remove_if_present(&dir.join(LEGACY_MIRROR_FILE))?;
    let pruned = if mirror.listed_vault_ids.is_empty() {
        Vec::new()
    } else {
        prune(&copies, mirror)?
    };
    Ok(Written {
        legacy_removed,
        pruned,
    })
}

/// Remove the copies of vaults the app no longer lists, keeping the one just written.
fn prune(copies: &Path, mirror: &Mirror) -> Result<Vec<String>, String> {
    let mut pruned = Vec::new();
    for entry in fs::read_dir(copies).map_err(|e| format!("list copies: {e}"))? {
        let path = entry.map_err(|e| format!("list copies: {e}"))?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if id == mirror.vault_id || mirror.listed_vault_ids.iter().any(|v| v == id) {
            continue;
        }
        remove_if_present(&path)?;
        pruned.push(id.to_string());
    }
    pruned.sort();
    Ok(pruned)
}

fn clear_mirror(dir: &Path, vault_id: &str) -> Result<(), String> {
    remove_if_present(&copy_path(dir, vault_id)?).map(|_| ())
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Record {
    pub iv: String,
    pub ciphertext: String,
}

fn read_records(path: &Path) -> Vec<Record> {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Rename first, so a record the extension appends meanwhile lands in a new file, not a deleted one.
fn consume_pending(dir: &Path) -> Result<Vec<Record>, String> {
    let draining = dir.join(format!("{PENDING_FILE}.draining"));
    match fs::rename(dir.join(PENDING_FILE), &draining) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("pending passkeys: {e}")),
        Ok(()) => {}
    }
    let records = read_records(&draining);
    let _ = fs::remove_file(&draining);
    Ok(records)
}

/// Put back what another vault sealed, after anything appended since.
fn restore_pending(dir: &Path, keep: Vec<Record>) -> Result<(), String> {
    let path = dir.join(PENDING_FILE);
    let mut records = read_records(&path);
    records.extend(keep);
    let tmp = dir.join(format!("{PENDING_FILE}.tmp"));
    let body = serde_json::to_vec(&records).map_err(|e| format!("encode pending: {e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("write pending: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("write pending: {e}"))
}

#[tauri::command(async)]
pub fn autofill_consume_pending_passkeys() -> Result<Vec<Record>, String> {
    #[cfg(target_os = "macos")]
    return consume_pending(&group_dir().ok_or("no home directory")?);
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

#[tauri::command(async)]
pub fn autofill_restore_pending_passkeys(keep: Vec<Record>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return restore_pending(&group_dir().ok_or("no home directory")?, keep);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = keep;
        Ok(())
    }
}

/// One write at a time: each reads the store back, swaps a vault's identities, and writes through a
/// temp file named for the vault, so two at once would leave stale identities or clobber the file.
#[cfg(target_os = "macos")]
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Replace the extension's mirror and the OS identities. Not on other platforms.
#[tauri::command(async)]
pub fn autofill_provider_set(mirror: Mirror) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _one = WRITES.lock().unwrap_or_else(|e| e.into_inner());
        let dir = group_dir().ok_or("no home directory")?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let written = write_mirror(&dir, &mirror, now_ms)?;
        // The single copy's identities were untagged: only a full replace clears them.
        if written.legacy_removed {
            store::replace_all(&mirror);
        } else {
            store::replace_vault(&mirror);
        }
        for vault_id in &written.pruned {
            store::prune_vault(vault_id);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = mirror;
    Ok(())
}

/// The vault is gone: its copy and identities go with it, or they outlive it as an openable copy.
#[tauri::command(async)]
pub fn autofill_provider_clear(vault_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _one = WRITES.lock().unwrap_or_else(|e| e.into_inner());
        clear_mirror(&group_dir().ok_or("no home directory")?, &vault_id)?;
        store::remove_vault(&vault_id);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = vault_id;
    Ok(())
}

/// ASCredentialIdentityStore, by message: the identities QuickType and the passkey sheet list.
#[cfg(target_os = "macos")]
mod store {
    use std::{ffi::c_void, sync::mpsc, time::Duration};

    use base64::{engine::general_purpose::STANDARD, Engine};
    use block2::RcBlock;
    use objc2::{
        msg_send,
        rc::{autoreleasepool, Allocated, Retained},
        runtime::{AnyClass, AnyObject, Bool},
        sel,
    };
    use objc2_foundation::NSString;

    use super::{store_plan, Mirror, Plan, Read, StoreOp};

    #[link(name = "AuthenticationServices", kind = "framework")]
    extern "C" {}

    const WAIT: Duration = Duration::from_secs(5);

    fn ns(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    fn data(bytes: &[u8]) -> Retained<AnyObject> {
        unsafe {
            msg_send![AnyClass::get(c"NSData").unwrap(), dataWithBytes: bytes.as_ptr() as *const c_void, length: bytes.len()]
        }
    }

    fn domain(service: &str) -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"ASCredentialServiceIdentifier")?;
        let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
        // ASCredentialServiceIdentifierTypeDomain.
        unsafe { msg_send![a, initWithIdentifier: &*ns(service), type: 0isize] }
    }

    /// Every identity the mirror names, as store objects. Kinds this macOS lacks are skipped.
    pub(super) fn identities(m: &Mirror) -> Vec<Retained<AnyObject>> {
        let mut out = Vec::new();
        if let Some(cls) = AnyClass::get(c"ASPasswordCredentialIdentity") {
            for i in &m.identities {
                let Some(service) = domain(&i.service) else {
                    continue;
                };
                let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let id: Option<Retained<AnyObject>> = unsafe {
                    msg_send![a, initWithServiceIdentifier: &*service, user: &*ns(&i.username), recordIdentifier: &*ns(&super::tag(&m.vault_id, &i.record_id))]
                };
                out.extend(id);
            }
        }
        // macOS 14: the passkey sheet only offers a provider it was told holds the credential.
        if let Some(cls) = AnyClass::get(c"ASPasskeyCredentialIdentity") {
            for p in &m.passkey_identities {
                let (Ok(cid), Ok(handle)) = (
                    STANDARD.decode(&p.credential_id),
                    STANDARD.decode(&p.user_handle),
                ) else {
                    continue;
                };
                let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let id: Option<Retained<AnyObject>> = unsafe {
                    msg_send![a, initWithRelyingPartyIdentifier: &*ns(&p.rp_id), userName: &*ns(&p.user_name), credentialID: &*data(&cid), userHandle: &*data(&handle), recordIdentifier: &*ns(&super::tag(&m.vault_id, &p.credential_id))]
                };
                out.extend(id);
            }
        }
        // macOS 15.
        if let Some(cls) = AnyClass::get(c"ASOneTimeCodeCredentialIdentity") {
            for c in &m.one_time_code_identities {
                let Some(service) = domain(&c.service) else {
                    continue;
                };
                let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let id: Option<Retained<AnyObject>> = unsafe {
                    msg_send![a, initWithServiceIdentifier: &*service, label: &*ns(&c.label), recordIdentifier: &*ns(&super::tag(&m.vault_id, &c.record_id))]
                };
                out.extend(id);
            }
        }
        out
    }

    fn array(items: &[Retained<AnyObject>]) -> Retained<AnyObject> {
        let ptrs: Vec<*const AnyObject> = items.iter().map(|o| Retained::as_ptr(o)).collect();
        unsafe {
            msg_send![AnyClass::get(c"NSArray").unwrap(), arrayWithObjects: ptrs.as_ptr(), count: ptrs.len()]
        }
    }

    fn shared() -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"ASCredentialIdentityStore")?;
        Some(unsafe { msg_send![cls, sharedStore] })
    }

    /// A no-op until the user enables Bramble in AutoFill & Passwords, which is also when
    /// QuickType should start.
    fn enabled(store: &AnyObject) -> bool {
        let (tx, rx) = mpsc::channel();
        let on_state = RcBlock::new(move |state: *mut AnyObject| {
            let enabled = !state.is_null() && unsafe { msg_send![state, isEnabled] };
            let _ = tx.send(enabled);
        });
        unsafe {
            let _: () = msg_send![store, getCredentialIdentityStoreStateWithCompletion: &*on_state];
        }
        rx.recv_timeout(WAIT).unwrap_or(false)
    }

    fn responds(store: &AnyObject, selector: objc2::runtime::Sel) -> bool {
        let yes: Bool = unsafe { msg_send![store, respondsToSelector: selector] };
        yes.as_bool()
    }

    /// Send one store message that ends in a completion block, and wait for it.
    fn wait(send: impl FnOnce(&RcBlock<dyn Fn(Bool, *mut AnyObject)>)) {
        let (tx, rx) = mpsc::channel();
        let done: RcBlock<dyn Fn(Bool, *mut AnyObject)> =
            RcBlock::new(move |_ok: Bool, _error: *mut AnyObject| {
                let _ = tx.send(());
            });
        send(&done);
        let _ = rx.recv_timeout(WAIT);
    }

    fn replace_with(store: &AnyObject, all: &[Retained<AnyObject>]) {
        let entries = responds(store, sel!(replaceCredentialIdentityEntries:completion:));
        wait(|done| unsafe {
            if entries {
                let _: () = msg_send![store, replaceCredentialIdentityEntries: &*array(all), completion: &**done];
            } else {
                // macOS 13: the older selector, passwords only (the other classes don't exist
                // there, so `all` holds nothing else).
                let _: () = msg_send![store, replaceCredentialIdentitiesWithIdentities: &*array(all), completion: &**done];
            }
        });
    }

    /// A retained object handed across threads by address (Retained is not Send). Released if
    /// never taken, so an answer that arrives after the wait was given up on does not leak.
    pub(super) struct Handed(*mut AnyObject);

    unsafe impl Send for Handed {}

    impl Handed {
        pub(super) fn new(raw: *mut AnyObject) -> Self {
            Self(raw)
        }

        pub(super) fn take(mut self) -> Option<Retained<AnyObject>> {
            let raw = std::mem::replace(&mut self.0, std::ptr::null_mut());
            unsafe { Retained::from_raw(raw) }
        }
    }

    impl Drop for Handed {
        fn drop(&mut self) {
            if !self.0.is_null() {
                drop(unsafe { Retained::from_raw(self.0) });
            }
        }
    }

    /// Everything in the store, where macOS 14.4+ can say in time.
    fn read_back(store: &AnyObject) -> (Read, Vec<Retained<AnyObject>>) {
        if !responds(
            store,
            sel!(getCredentialIdentitiesForService:credentialIdentityTypes:completionHandler:),
        ) {
            return (Read::Unsupported, Vec::new());
        }
        let (tx, rx) = mpsc::channel::<Handed>();
        let got = RcBlock::new(move |list: *mut AnyObject| {
            let kept = unsafe { Retained::retain(list) };
            let _ = tx.send(Handed::new(
                kept.map_or(std::ptr::null_mut(), Retained::into_raw),
            ));
        });
        unsafe {
            let none: *const AnyObject = std::ptr::null();
            // ASCredentialIdentityTypesAll.
            let _: () = msg_send![store, getCredentialIdentitiesForService: none, credentialIdentityTypes: 0usize, completionHandler: &*got];
        }
        let Ok(handed) = rx.recv_timeout(WAIT) else {
            return (Read::Slow, Vec::new());
        };
        let Some(list) = handed.take() else {
            return (Read::Got, Vec::new());
        };
        let count: usize = unsafe { msg_send![&*list, count] };
        let items = (0..count)
            .filter_map(|i| unsafe {
                let item: *mut AnyObject = msg_send![&*list, objectAtIndex: i];
                Retained::retain(item)
            })
            .collect();
        (Read::Got, items)
    }

    /// Remove `vault_id`'s identities from what the store read back.
    fn remove_tagged(store: &AnyObject, existing: &[Retained<AnyObject>], vault_id: &str) {
        let theirs: Vec<Retained<AnyObject>> = existing
            .iter()
            .filter(|o| {
                let id: Option<Retained<NSString>> = unsafe { msg_send![&***o, recordIdentifier] };
                id.is_some_and(|id| super::tagged_for(&id.to_string(), vault_id))
            })
            .cloned()
            .collect();
        if theirs.is_empty() {
            return;
        }
        wait(|done| unsafe {
            let _: () = msg_send![store, removeCredentialIdentityEntries: &*array(&theirs), completion: &**done];
        });
    }

    /// Every vault's identities replaced by this one's. For the first write after the single copy,
    /// whose identities carried no vault.
    pub(super) fn replace_all(m: &Mirror) {
        autoreleasepool(|_| {
            let Some(store) = shared() else { return };
            if enabled(&store) {
                replace_with(&store, &identities(m));
            }
        });
    }

    fn save(store: &AnyObject, mine: &[Retained<AnyObject>]) {
        if mine.is_empty() {
            return;
        }
        wait(|done| unsafe {
            let _: () =
                msg_send![store, saveCredentialIdentityEntries: &*array(mine), completion: &**done];
        });
    }

    /// Update the store for one vault as `store_plan` says, from what it could read back.
    fn apply(op: StoreOp, vault_id: &str, mine: &[Retained<AnyObject>]) {
        autoreleasepool(|_| {
            let Some(store) = shared() else { return };
            if !enabled(&store) {
                return;
            }
            let (read, existing) = read_back(&store);
            match store_plan(op, read) {
                Plan::ReplaceAll => replace_with(&store, mine),
                Plan::RemoveTaggedThenSave => {
                    remove_tagged(&store, &existing, vault_id);
                    save(&store, mine);
                }
                Plan::SaveOnly => save(&store, mine),
                Plan::RemoveTagged => remove_tagged(&store, &existing, vault_id),
                Plan::ClearAll => replace_with(&store, &[]),
                Plan::Nothing => {}
            }
        });
    }

    /// This vault's identities swapped for the new ones, every other vault's left as they are.
    pub(super) fn replace_vault(m: &Mirror) {
        apply(StoreOp::Write, &m.vault_id, &identities(m));
    }

    /// A vault no longer listed: its identities go.
    pub(super) fn prune_vault(vault_id: &str) {
        apply(StoreOp::Prune, vault_id, &[]);
    }

    /// The vault is deleted: its identities go too.
    pub(super) fn remove_vault(vault_id: &str) {
        apply(StoreOp::Delete, vault_id, &[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_group_container_is_the_one_the_extension_opens() {
        let dir = group_dir().unwrap();
        assert!(dir.ends_with(format!("Library/Group Containers/{GROUP}")));
    }

    fn mirror() -> Mirror {
        serde_json::from_value(serde_json::json!({
            "iv": "IV", "ciphertext": "CT", "vaultId": "v1", "vaultName": "Personal",
            "slot": { "saltB64": "s" },
            "passkeyIv": "PIV", "passkeyCiphertext": "PCT",
            "identities": [{ "recordId": "e1", "username": "me", "service": "github.com" }],
            "oneTimeCodeIdentities": [{ "recordId": "c1", "label": "me", "service": "github.com" }],
            "passkeyIdentities": [{ "credentialId": "Y2lk", "rpId": "github.com", "userName": "me", "userHandle": "dWg=" }]
        }))
        .unwrap()
    }

    fn mirror_for(vault_id: &str, listed: &[&str]) -> Mirror {
        let mut m = mirror();
        m.vault_id = vault_id.into();
        m.listed_vault_ids = listed.iter().map(|s| s.to_string()).collect();
        m
    }

    #[test]
    fn writes_each_vault_to_its_own_copy() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("group");
        write_mirror(&group, &mirror_for("v1", &[]), 1000).unwrap();
        write_mirror(&group, &mirror_for("v2", &[]), 2000).unwrap();
        let copy = group.join(COPIES_DIR).join("v1.json");
        assert!(group.join(COPIES_DIR).join("v2.json").exists());
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&copy).unwrap()).unwrap();
        assert_eq!(written["ciphertext"], "CT");
        assert_eq!(written["vaultId"], "v1");
        assert_eq!(written["vaultName"], "Personal");
        assert_eq!(written["passkeyCiphertext"], "PCT");
        assert_eq!(written["slot"]["saltB64"], "s");
        assert_eq!(written["passkeyCredentialIds"], serde_json::json!(["Y2lk"]));
        assert_eq!(written["writtenAt"], 1000);
        // Identities go to the OS store, never to disk.
        assert!(written.get("identities").is_none());
        assert!(written.get("passkeyIdentities").is_none());
        assert!(written.get("listedVaultIds").is_none());
        let names: Vec<_> = std::fs::read_dir(group.join(COPIES_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        let mut names = names;
        names.sort();
        assert_eq!(names, vec!["v1.json", "v2.json"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&copy).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn the_first_write_removes_the_single_copy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(LEGACY_MIRROR_FILE), "{}").unwrap();
        let first = write_mirror(dir.path(), &mirror_for("v1", &[]), 1).unwrap();
        assert!(first.legacy_removed);
        assert!(!dir.path().join(LEGACY_MIRROR_FILE).exists());
        let second = write_mirror(dir.path(), &mirror_for("v1", &[]), 2).unwrap();
        assert!(!second.legacy_removed);
    }

    #[test]
    fn prunes_copies_of_vaults_no_longer_listed() {
        let dir = tempfile::tempdir().unwrap();
        write_mirror(dir.path(), &mirror_for("v1", &[]), 1).unwrap();
        write_mirror(dir.path(), &mirror_for("v2", &[]), 2).unwrap();
        let written = write_mirror(dir.path(), &mirror_for("v1", &["v1"]), 3).unwrap();
        assert_eq!(written.pruned, vec!["v2".to_string()]);
        assert!(!dir.path().join(COPIES_DIR).join("v2.json").exists());
        assert!(dir.path().join(COPIES_DIR).join("v1.json").exists());
    }

    // A registry that could not be read must not cost every other vault its copy.
    #[test]
    fn an_empty_vault_list_prunes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write_mirror(dir.path(), &mirror_for("v1", &[]), 1).unwrap();
        write_mirror(dir.path(), &mirror_for("v2", &[]), 2).unwrap();
        let written = write_mirror(dir.path(), &mirror_for("v1", &[]), 3).unwrap();
        assert!(written.pruned.is_empty());
        assert!(dir.path().join(COPIES_DIR).join("v2.json").exists());
    }

    #[test]
    fn clearing_removes_only_that_vault() {
        let dir = tempfile::tempdir().unwrap();
        write_mirror(dir.path(), &mirror_for("v1", &[]), 1).unwrap();
        write_mirror(dir.path(), &mirror_for("v2", &[]), 2).unwrap();
        clear_mirror(dir.path(), "v1").unwrap();
        assert!(!dir.path().join(COPIES_DIR).join("v1.json").exists());
        assert!(dir.path().join(COPIES_DIR).join("v2.json").exists());
        clear_mirror(dir.path(), "v1").unwrap();
    }

    #[test]
    fn rejects_a_vault_id_that_is_not_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("group");
        assert!(write_mirror(&group, &mirror_for("../x", &[]), 1).is_err());
        assert!(clear_mirror(&group, "../x").is_err());
        assert!(!group.join("x.json").exists());
        assert!(!dir.path().join("x.json").exists());
    }

    #[test]
    fn consumes_and_removes_pending_passkeys() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(PENDING_FILE),
            r#"[{"iv":"a","ciphertext":"b"},{"iv":"c","ciphertext":"d"}]"#,
        )
        .unwrap();
        let got = consume_pending(dir.path()).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].ciphertext, "d");
        assert!(!dir.path().join(PENDING_FILE).exists());
        assert!(consume_pending(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn restoring_puts_records_back_beside_new_ones() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(PENDING_FILE),
            r#"[{"iv":"new","ciphertext":"n"}]"#,
        )
        .unwrap();
        restore_pending(
            dir.path(),
            vec![Record {
                iv: "old".into(),
                ciphertext: "o".into(),
            }],
        )
        .unwrap();
        let got = consume_pending(dir.path()).unwrap();
        let ivs: Vec<_> = got.iter().map(|r| r.iv.as_str()).collect();
        assert_eq!(ivs, vec!["new", "old"]);
    }

    // Reading the store back is the only way to know which identities are another vault's, so a
    // store too slow to answer must cost nothing but this vault's own update.
    #[test]
    fn a_slow_store_never_costs_other_vaults_their_suggestions() {
        use StoreOp::*;
        assert_eq!(store_plan(Write, Read::Slow), Plan::SaveOnly);
        assert_eq!(store_plan(Prune, Read::Slow), Plan::Nothing);
        assert_eq!(store_plan(Delete, Read::Slow), Plan::Nothing);
    }

    #[test]
    fn plans_each_store_update_from_what_it_could_read() {
        use StoreOp::*;
        assert_eq!(store_plan(Write, Read::Got), Plan::RemoveTaggedThenSave);
        assert_eq!(store_plan(Prune, Read::Got), Plan::RemoveTagged);
        assert_eq!(store_plan(Delete, Read::Got), Plan::RemoveTagged);
        // Before macOS 14.4 the store holds the last vault's identities only.
        assert_eq!(store_plan(Write, Read::Unsupported), Plan::ReplaceAll);
        assert_eq!(store_plan(Prune, Read::Unsupported), Plan::Nothing);
        assert_eq!(store_plan(Delete, Read::Unsupported), Plan::ClearAll);
    }

    // An answer that arrives after the wait is given up on is released, not leaked.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_list_handed_over_and_never_taken_is_released() {
        use objc2::{msg_send, rc::Retained, runtime::AnyClass, runtime::AnyObject};
        let obj: Retained<AnyObject> =
            unsafe { msg_send![AnyClass::get(c"NSObject").unwrap(), new] };
        let count = || -> usize { unsafe { msg_send![&*obj, retainCount] } };
        let before = count();
        let handed = store::Handed::new(Retained::into_raw(obj.clone()));
        assert_eq!(count(), before + 1);
        drop(handed);
        assert_eq!(count(), before);
        let taken = store::Handed::new(Retained::into_raw(obj.clone())).take();
        assert!(taken.is_some());
        drop(taken);
        assert_eq!(count(), before);
    }

    #[test]
    fn tags_and_recognises_a_vaults_identities() {
        assert_eq!(tag("v1", "e1"), "v1:e1");
        assert!(tagged_for("v1:e1", "v1"));
        assert!(!tagged_for("v10:e1", "v1"));
        assert!(!tagged_for("e1", "v1"));
    }

    // The Objective-C side for real, short of the store: wrong selectors or argument types fail
    // here rather than on a user's Mac.
    #[cfg(target_os = "macos")]
    #[test]
    fn builds_identity_objects_the_store_takes() {
        use objc2::{msg_send, rc::Retained};
        use objc2_foundation::NSString;
        let m = mirror();
        let built = store::identities(&m);
        assert!(
            built.len() >= 2,
            "one password, one passkey, and a code from macOS 15"
        );
        let mut ids: Vec<String> = built
            .iter()
            .map(|o| {
                let id: Retained<NSString> = unsafe { msg_send![&**o, recordIdentifier] };
                id.to_string()
            })
            .collect();
        ids.sort();
        let mut want = vec!["v1:Y2lk", "v1:e1", "v1:c1"];
        want.truncate(built.len());
        want.sort();
        assert_eq!(ids, want);
    }
}
