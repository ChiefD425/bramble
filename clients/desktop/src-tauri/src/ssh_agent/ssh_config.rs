//! The ssh config that offers each key only to the hosts it names.
//!
//! The agent protocol never says which host a request is for, but `ssh` knows, and its config can
//! say "for this host, offer only this key". So Bramble writes `~/.ssh/bramble/`: a `config` the
//! user includes from the top of `~/.ssh/config`, one `vaults/<id>.conf` per vault, and the
//! `keys/*.pub` those name. Everything a host or path contributes is checked first, because the
//! hosts come from sync and imports and a newline in one would add a directive such as
//! `ProxyCommand`. Paths are absolute: OpenSSH expands `~` from the account's passwd entry, not
//! `$HOME`. See docs/ssh-agent.md.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use ssh_encoding::Decode;

use super::store::{valid_vault_id, write_private};

/// The one line the user adds, first in `~/.ssh/config`.
pub const INCLUDE_LINE: &str = "Include ~/.ssh/bramble/config";

const HEADER: &str = "# Written by Bramble. Changes here are overwritten.\n";
const MAX_HOST: usize = 253;

/// Where `~/.ssh` lives: `$HOME`, or `%USERPROFILE%` on Windows. Never a passwd lookup, so a
/// test or the e2e's scratch home stays away from the real one.
pub fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.map(PathBuf::from).filter(|p| p.is_absolute())
}

/// What may follow `Host`: a name, address or pattern, and nothing that could end the line or
/// start another word.
pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= MAX_HOST
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_*?:%".contains(&b))
}

pub struct VaultKey {
    pub blob: Vec<u8>,
    pub hosts: Vec<String>,
}

/// A host left out of the config because it isn't one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftOut {
    pub entry_id: String,
    pub host: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Setup {
    SetUp,
    NotAdded,
    /// The line is there, below a `Host` or `Match`, where it only applies to that block.
    NotFirst,
}

fn bramble_dir(home: &Path) -> PathBuf {
    home.join(".ssh").join("bramble")
}

/// A path as a quoted ssh_config argument; refused if it could break out of the quotes.
fn quoted(path: &str) -> io::Result<String> {
    if path.contains(['"', '\n', '\r']) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path"));
    }
    Ok(format!("\"{path}\""))
}

fn make_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// `~/.ssh/bramble/config`: the vault files, and the agent for every host.
pub fn write_main(home: &Path, agent_address: &str, only_their_hosts: bool) -> io::Result<()> {
    let dir = bramble_dir(home);
    let vaults = quoted(&format!("{}/vaults/*.conf", dir.display()))?;
    let agent = quoted(agent_address)?;
    let mut text = format!("{HEADER}Include {vaults}\nHost *\n  IdentityAgent {agent}\n");
    if only_their_hosts {
        text.push_str("  IdentitiesOnly yes\n");
    }
    make_private_dir(&dir)?;
    write_private(&dir.join("config"), text.as_bytes())
}

/// One vault's `Host` blocks and the public keys they name, replacing whatever that vault had.
/// Hosts that aren't hosts are left out and returned.
pub fn write_vault(
    home: &Path,
    vault_id: &str,
    keys: &[(String, VaultKey)],
) -> io::Result<Vec<LeftOut>> {
    if !valid_vault_id(vault_id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "vault id"));
    }
    let dir = bramble_dir(home);
    let mut left_out = Vec::new();
    let mut blocks = Vec::new();
    let mut pubs = Vec::new();
    for (entry_id, key) in keys {
        let hosts: Vec<&str> = key
            .hosts
            .iter()
            .filter(|h| {
                let ok = valid_host(h);
                if !ok {
                    left_out.push(LeftOut {
                        entry_id: entry_id.clone(),
                        host: (*h).clone(),
                    });
                }
                ok
            })
            .map(String::as_str)
            .collect();
        if hosts.is_empty() {
            continue;
        }
        let name = format!("{vault_id}-{}.pub", hex(&Sha256::digest(&key.blob)));
        let path = quoted(&dir.join("keys").join(&name).display().to_string())?;
        blocks.push(format!(
            "Host {}\n  IdentityFile {path}\n  IdentitiesOnly yes\n",
            hosts.join(" ")
        ));
        pubs.push((name, pub_line(&key.blob)?));
    }
    make_private_dir(&dir)?;
    for sub in ["vaults", "keys"] {
        make_private_dir(&dir.join(sub))?;
    }
    for (name, line) in &pubs {
        write_private(&dir.join("keys").join(name), line.as_bytes())?;
    }
    remove_pubs(&dir, vault_id, |name| pubs.iter().any(|(n, _)| n == name))?;
    let conf = dir.join("vaults").join(format!("{vault_id}.conf"));
    if blocks.is_empty() {
        remove(&conf)?;
    } else {
        write_private(&conf, format!("{HEADER}\n{}", blocks.join("\n")).as_bytes())?;
    }
    Ok(left_out)
}

/// A vault's `.conf` and `.pub` files, gone.
pub fn delete_vault(home: &Path, vault_id: &str) -> io::Result<()> {
    if !valid_vault_id(vault_id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "vault id"));
    }
    let dir = bramble_dir(home);
    remove(&dir.join("vaults").join(format!("{vault_id}.conf")))?;
    remove_pubs(&dir, vault_id, |_| false)
}

/// Every vault's files whose vault the picker no longer lists, gone.
pub fn prune_vaults(home: &Path, listed: &[String]) -> io::Result<()> {
    let Ok(entries) = fs::read_dir(bramble_dir(home).join("vaults")) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".conf") {
            if valid_vault_id(id) && !listed.iter().any(|l| l == id) {
                delete_vault(home, id)?;
            }
        }
    }
    Ok(())
}

/// `~/.ssh/bramble`, gone. The user's own files in `~/.ssh` are untouched.
pub fn delete_all(home: &Path) -> io::Result<()> {
    match fs::remove_dir_all(bramble_dir(home)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Whether `~/.ssh/config` includes Bramble's config, and where.
pub fn setup(home: &Path) -> Setup {
    let Ok(text) = fs::read_to_string(home.join(".ssh").join("config")) else {
        return Setup::NotAdded;
    };
    let mut in_block = false;
    for line in text.lines() {
        let Some((keyword, args)) = directive(line) else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") || keyword.eq_ignore_ascii_case("match") {
            in_block = true;
        } else if is_our_include(keyword, args, home) {
            return if in_block {
                Setup::NotFirst
            } else {
                Setup::SetUp
            };
        }
    }
    Setup::NotAdded
}

/// Whether Bramble may add the line itself: never through a symlink (a dotfiles manager owns it),
/// never into a file it can't write.
pub fn can_add_line(home: &Path) -> bool {
    let config = home.join(".ssh").join("config");
    match fs::symlink_metadata(&config) {
        Ok(meta) => {
            !meta.file_type().is_symlink()
                && fs::OpenOptions::new().append(true).open(&config).is_ok()
        }
        Err(_) => fs::metadata(home.join(".ssh")).map_or(true, |m| !m.permissions().readonly()),
    }
}

/// Put `INCLUDE_LINE` first in `~/.ssh/config`, moving it up if it is lower down, and keep every
/// other byte of the file as it was.
pub fn add_line(home: &Path) -> io::Result<()> {
    if !can_add_line(home) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "ssh config",
        ));
    }
    let ssh = home.join(".ssh");
    let config = ssh.join("config");
    if !ssh.exists() {
        make_private_dir(&ssh)?;
    }
    let (existing, mode) = match fs::read_to_string(&config) {
        Ok(text) => (Some(text), file_mode(&config)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (None, None),
        Err(e) => return Err(e),
    };
    let rest: String = existing
        .as_deref()
        .unwrap_or("")
        .split_inclusive('\n')
        .filter(|line| !directive(line).is_some_and(|(k, a)| is_our_include(k, a, home)))
        .collect();
    let text = if rest.is_empty() {
        format!("{INCLUDE_LINE}\n")
    } else {
        format!("{INCLUDE_LINE}\n\n{rest}")
    };
    let tmp = ssh.join(".config.bramble.tmp");
    fs::write(&tmp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode.unwrap_or(0o600)))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    fs::rename(&tmp, &config)
}

/// The server's name from an unhashed `known_hosts` line for its host key, else its fingerprint.
pub fn server_label(home: &Path, host_key: &[u8]) -> String {
    let known = fs::read_to_string(home.join(".ssh").join("known_hosts")).unwrap_or_default();
    for line in known.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(hosts), Some(_algo), Some(key)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if hosts.starts_with('|') || STANDARD.decode(key).ok().as_deref() != Some(host_key) {
            continue;
        }
        if let Some(first) = hosts.split(',').next() {
            let name = first
                .strip_prefix('[')
                .and_then(|h| h.split(']').next())
                .unwrap_or(first);
            return name.to_string();
        }
    }
    let digest = Sha256::digest(host_key);
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

/// An ssh_config line's keyword and arguments, `None` for blanks and comments.
fn directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let split = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (keyword, rest) = line.split_at(split);
    let args = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    Some((keyword, args))
}

fn is_our_include(keyword: &str, args: &str, home: &Path) -> bool {
    if !keyword.eq_ignore_ascii_case("include") {
        return false;
    }
    let absolute = bramble_dir(home).join("config").display().to_string();
    args.split_whitespace()
        .map(|a| a.trim_matches('"'))
        .any(|a| a == "~/.ssh/bramble/config" || a == absolute)
}

fn pub_line(blob: &[u8]) -> io::Result<String> {
    let algo = String::decode(&mut &blob[..])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "public key"))?;
    if !algo.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "public key"));
    }
    Ok(format!("{algo} {}\n", STANDARD.encode(blob)))
}

/// Remove `keys/<vault>-*.pub` except those `keep` names.
fn remove_pubs(dir: &Path, vault_id: &str, keep: impl Fn(&str) -> bool) -> io::Result<()> {
    let Ok(entries) = fs::read_dir(dir.join("keys")) else {
        return Ok(());
    };
    let prefix = format!("{vault_id}-");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".pub") && !keep(&name) {
            remove(&entry.path())?;
        }
    }
    Ok(())
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn file_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .ok()
            .map(|m| m.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const ED_PUB: &str = include_str!("fixtures/ed25519.pub");
    const ECDSA_PUB: &str = include_str!("fixtures/ecdsa256.pub");

    fn blob(pub_line: &str) -> Vec<u8> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD
            .decode(pub_line.split_whitespace().nth(1).unwrap())
            .unwrap()
    }

    fn vk(pub_line: &str, hosts: &[&str]) -> VaultKey {
        VaultKey {
            blob: blob(pub_line),
            hosts: hosts.iter().map(|h| h.to_string()).collect(),
        }
    }

    fn sha_hex(b: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(b)
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect()
    }

    fn files(home: &Path) -> Vec<String> {
        let root = home.join(".ssh/bramble");
        let mut out = Vec::new();
        for dir in ["", "vaults", "keys"] {
            if let Ok(entries) = fs::read_dir(root.join(dir)) {
                for e in entries.flatten() {
                    if e.path().is_file() {
                        out.push(format!("{dir}/{}", e.file_name().to_string_lossy()));
                    }
                }
            }
        }
        out.sort();
        out
    }

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn valid_host_takes_hosts_and_patterns() {
        for h in [
            "github.com",
            "10.0.0.5",
            "*.example.com",
            "fe80::1%en0",
            "prod",
            "a-b_c?",
        ] {
            assert!(valid_host(h), "{h}");
        }
    }

    #[test]
    fn hosts_that_could_inject_are_left_out() {
        let home = tempfile::tempdir().unwrap();
        let long = "a".repeat(254);
        let bad = [
            "a\nProxyCommand x",
            "a b",
            "a\"b",
            "a#b",
            "a=b",
            "",
            long.as_str(),
        ];
        for h in bad {
            assert!(!valid_host(h), "{h:?}");
        }
        let keys = [("e1".to_string(), vk(ED_PUB, &bad))];
        let left = write_vault(home.path(), "A", &keys).unwrap();
        assert_eq!(left.len(), bad.len());
        assert!(left.iter().all(|l| l.entry_id == "e1"));
        assert!(!home.path().join(".ssh/bramble/vaults/A.conf").exists());
        for f in files(home.path()) {
            let text = fs::read_to_string(home.path().join(".ssh/bramble").join(&f)).unwrap();
            assert!(!text.contains("ProxyCommand"), "{f}");
        }
    }

    #[test]
    fn a_bad_vault_id_writes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let keys = [("e1".to_string(), vk(ED_PUB, &["github.com"]))];
        assert!(write_vault(home.path(), "../x", &keys).is_err());
        assert!(files(home.path()).is_empty());
    }

    #[test]
    fn write_vault_matches_ssh_config_syntax() {
        let home = tempfile::tempdir().unwrap();
        let keys = [
            (
                "e1".to_string(),
                vk(ED_PUB, &["github.com", "*.example.com"]),
            ),
            ("e2".to_string(), vk(ECDSA_PUB, &[])),
        ];
        assert!(write_vault(home.path(), "A", &keys).unwrap().is_empty());
        let h = home.path().display();
        let pub_name = format!("A-{}.pub", sha_hex(&blob(ED_PUB)));
        let conf = fs::read_to_string(home.path().join(".ssh/bramble/vaults/A.conf")).unwrap();
        assert_eq!(
            conf,
            format!(
                "# Written by Bramble. Changes here are overwritten.\n\n\
                 Host github.com *.example.com\n  \
                 IdentityFile \"{h}/.ssh/bramble/keys/{pub_name}\"\n  \
                 IdentitiesOnly yes\n"
            )
        );
        let pub_text =
            fs::read_to_string(home.path().join(".ssh/bramble/keys").join(&pub_name)).unwrap();
        let mut fields = ED_PUB.split_whitespace();
        assert_eq!(
            pub_text,
            format!("{} {}\n", fields.next().unwrap(), fields.next().unwrap())
        );
        assert_eq!(
            files(home.path()),
            [format!("keys/{pub_name}"), "vaults/A.conf".to_string()]
        );
        #[cfg(unix)]
        {
            assert_eq!(mode(&home.path().join(".ssh/bramble")), 0o700);
            assert_eq!(mode(&home.path().join(".ssh/bramble/vaults/A.conf")), 0o600);
            assert_eq!(
                mode(&home.path().join(".ssh/bramble/keys").join(&pub_name)),
                0o600
            );
        }
    }

    #[test]
    fn main_config_gains_identities_only_when_asked() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().display();
        write_main(home.path(), "/run/agent.sock", false).unwrap();
        let expected = format!(
            "# Written by Bramble. Changes here are overwritten.\n\
             Include \"{h}/.ssh/bramble/vaults/*.conf\"\n\
             Host *\n  \
             IdentityAgent \"/run/agent.sock\"\n"
        );
        let main = home.path().join(".ssh/bramble/config");
        assert_eq!(fs::read_to_string(&main).unwrap(), expected);
        write_main(home.path(), "/run/agent.sock", true).unwrap();
        assert_eq!(
            fs::read_to_string(&main).unwrap(),
            format!("{expected}  IdentitiesOnly yes\n")
        );
    }

    #[test]
    fn a_quote_or_newline_in_a_path_writes_nothing() {
        let home = tempfile::tempdir().unwrap();
        assert!(write_main(home.path(), "/run/a\"gent", false).is_err());
        assert!(write_main(home.path(), "/run/a\ngent", false).is_err());
        assert!(files(home.path()).is_empty());
    }

    #[test]
    fn prune_and_delete_remove_only_bramble_files() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        fs::write(home.path().join(".ssh/id_ed25519.pub"), "mine").unwrap();
        write_main(home.path(), "/a.sock", false).unwrap();
        write_vault(
            home.path(),
            "A",
            &[("1".into(), vk(ED_PUB, &["a.example"]))],
        )
        .unwrap();
        write_vault(
            home.path(),
            "B",
            &[("2".into(), vk(ECDSA_PUB, &["b.example"]))],
        )
        .unwrap();
        prune_vaults(home.path(), &["A".to_string()]).unwrap();
        let left = files(home.path());
        assert!(left.contains(&"vaults/A.conf".to_string()));
        assert!(!left.iter().any(|f| f.contains("B")), "{left:?}");
        delete_vault(home.path(), "A").unwrap();
        assert_eq!(files(home.path()), ["/config"]);
        delete_all(home.path()).unwrap();
        assert!(!home.path().join(".ssh/bramble").exists());
        assert_eq!(
            fs::read_to_string(home.path().join(".ssh/id_ed25519.pub")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn setup_reads_the_include_position() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".ssh/config");
        assert_eq!(setup(home.path()), Setup::NotAdded);
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        fs::write(&config, "Host x\n  User y\n").unwrap();
        assert_eq!(setup(home.path()), Setup::NotAdded);
        fs::write(&config, format!("Host x\n  User y\n{INCLUDE_LINE}\n")).unwrap();
        assert_eq!(setup(home.path()), Setup::NotFirst);
        fs::write(&config, format!("# mine\n\n{INCLUDE_LINE}\nHost x\n")).unwrap();
        assert_eq!(setup(home.path()), Setup::SetUp);
        let absolute = format!(
            "Include=\"{}/.ssh/bramble/config\"\n",
            home.path().display()
        );
        fs::write(&config, absolute).unwrap();
        assert_eq!(setup(home.path()), Setup::SetUp);
    }

    #[test]
    fn add_line_prepends_and_keeps_the_rest() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".ssh/config");
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        let mine = "Host x\n\tUser  y # spacing kept\n\nHost *\n  ServerAliveInterval 30";
        fs::write(&config, mine).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&config, fs::Permissions::from_mode(0o640)).unwrap();
        }
        assert!(can_add_line(home.path()));
        add_line(home.path()).unwrap();
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            format!("{INCLUDE_LINE}\n\n{mine}")
        );
        assert_eq!(setup(home.path()), Setup::SetUp);
        #[cfg(unix)]
        assert_eq!(mode(&config), 0o640);
    }

    #[test]
    fn add_line_moves_a_line_that_is_too_low() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".ssh/config");
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        fs::write(&config, format!("Host x\n  User y\n{INCLUDE_LINE}\n")).unwrap();
        add_line(home.path()).unwrap();
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            format!("{INCLUDE_LINE}\n\nHost x\n  User y\n")
        );
    }

    #[test]
    fn add_line_creates_ssh_dir_and_config() {
        let home = tempfile::tempdir().unwrap();
        add_line(home.path()).unwrap();
        let config = home.path().join(".ssh/config");
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            format!("{INCLUDE_LINE}\n")
        );
        #[cfg(unix)]
        {
            assert_eq!(mode(&home.path().join(".ssh")), 0o700);
            assert_eq!(mode(&config), 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_is_never_rewritten() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        let target = home.path().join("dotfiles-config");
        fs::write(&target, "Host x\n").unwrap();
        std::os::unix::fs::symlink(&target, home.path().join(".ssh/config")).unwrap();
        assert!(!can_add_line(home.path()));
        assert!(add_line(home.path()).is_err());
        assert!(fs::symlink_metadata(home.path().join(".ssh/config"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "Host x\n");
    }

    #[test]
    fn server_label_reads_unhashed_known_hosts() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        let (algo, b64) = {
            let mut f = ED_PUB.split_whitespace();
            (f.next().unwrap(), f.next().unwrap())
        };
        let hashed = format!("|1|c2FsdA==|aGFzaA== {algo} {b64}\n");
        fs::write(home.path().join(".ssh/known_hosts"), &hashed).unwrap();
        let label = server_label(home.path(), &blob(ED_PUB));
        assert!(label.starts_with("SHA256:"), "{label}");
        let named = format!("{hashed}[bastion.example]:2222,10.0.0.9 {algo} {b64}\n");
        fs::write(home.path().join(".ssh/known_hosts"), named).unwrap();
        assert_eq!(server_label(home.path(), &blob(ED_PUB)), "bastion.example");
    }

    #[test]
    fn a_replaced_key_leaves_no_stale_pub() {
        let home = tempfile::tempdir().unwrap();
        write_vault(home.path(), "A", &[("1".into(), vk(ED_PUB, &["h"]))]).unwrap();
        write_vault(home.path(), "A", &[("1".into(), vk(ECDSA_PUB, &["h"]))]).unwrap();
        let pubs: Vec<_> = files(home.path())
            .into_iter()
            .filter(|f| f.ends_with(".pub"))
            .collect();
        assert_eq!(pubs, [format!("keys/A-{}.pub", sha_hex(&blob(ECDSA_PUB)))]);
    }

    #[test]
    fn a_vault_with_no_hosts_has_no_conf() {
        let home = tempfile::tempdir().unwrap();
        write_vault(home.path(), "A", &[("1".into(), vk(ED_PUB, &["h"]))]).unwrap();
        write_vault(home.path(), "A", &[("1".into(), vk(ED_PUB, &[]))]).unwrap();
        assert!(files(home.path()).is_empty());
    }

    #[test]
    fn no_temporary_files_are_left() {
        let home = tempfile::tempdir().unwrap();
        write_main(home.path(), "/a.sock", true).unwrap();
        write_vault(home.path(), "A", &[("1".into(), vk(ED_PUB, &["h"]))]).unwrap();
        add_line(home.path()).unwrap();
        for f in files(home.path()) {
            assert!(!f.contains(".tmp"), "{f}");
        }
        let in_ssh: Vec<_> = fs::read_dir(home.path().join(".ssh"))
            .unwrap()
            .flatten()
            .collect();
        assert!(in_ssh
            .iter()
            .all(|e| !e.file_name().to_string_lossy().contains(".tmp")));
    }

    #[test]
    #[ignore = "needs OpenSSH's ssh on PATH"]
    fn real_ssh_accepts_the_files() {
        let home = tempfile::tempdir().unwrap();
        write_main(home.path(), "/tmp/bramble-test-agent.sock", false).unwrap();
        write_vault(
            home.path(),
            "A",
            &[("1".into(), vk(ED_PUB, &["named.example"]))],
        )
        .unwrap();
        let config = home.path().join(".ssh/bramble/config");
        let out = Command::new("ssh")
            .args(["-G", "-F"])
            .arg(&config)
            .arg("named.example")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        assert!(text.contains("identitiesonly yes"), "{text}");
        assert!(
            text.contains(&format!("a-{}.pub", sha_hex(&blob(ED_PUB)))),
            "{text}"
        );
        assert!(
            text.contains("identityagent /tmp/bramble-test-agent.sock"),
            "{text}"
        );

        delete_all(home.path()).unwrap();
        let user = home.path().join("user-config");
        fs::write(&user, format!("Include \"{}\"\n", config.display())).unwrap();
        let out = Command::new("ssh")
            .args(["-G", "-F"])
            .arg(&user)
            .arg("x")
            .output()
            .unwrap();
        assert!(out.status.success(), "a leftover include line breaks ssh");
    }
}
