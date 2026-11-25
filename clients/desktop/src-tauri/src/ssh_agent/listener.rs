//! The agent's socket (a named pipe on Windows), beside the browser link's, through the same
//! `ipc::Listener`. One thread per connection, as the browser socket does, capped so a flood of
//! connections can't take the app down. Every process running as the user can connect, so
//! nothing here trusts the caller: its name is only a label for the user.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use super::{
    protocol::{self, Reply, Request},
    ssh_config,
    store::{Conn, Hooks, Store},
};
use crate::{ipc, socket_addr::SSH_AGENT_NAME};

/// Open connections at once; past this a new one is closed unanswered.
pub const MAX_CONNECTIONS: usize = 64;
/// How long a request waits for an unlock or an answer before failing.
pub const UNLOCK_WAIT: Duration = Duration::from_secs(120);

/// `sun_path`, terminator included.
#[cfg(target_os = "macos")]
const SUN_PATH: usize = 104;
#[cfg(all(unix, not(target_os = "macos")))]
const SUN_PATH: usize = 108;

#[derive(Debug)]
pub enum ListenError {
    /// The home folder's path leaves no room for the socket's. Unix only: a pipe name has room.
    #[cfg_attr(windows, allow(dead_code))]
    PathTooLong,
    Bind(String),
}

struct Running {
    stopped: Arc<AtomicBool>,
    address: String,
}

fn running() -> &'static Mutex<HashMap<PathBuf, Running>> {
    static RUNNING: OnceLock<Mutex<HashMap<PathBuf, Running>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start answering at `root`'s agent endpoint, replacing any listener already there. Returns the
/// address to point `IdentityAgent` at.
pub fn listen(
    root: &Path,
    home: Option<PathBuf>,
    store: Arc<Store>,
    hooks: Arc<dyn Hooks>,
) -> Result<String, ListenError> {
    #[cfg(unix)]
    let address = {
        let path = ipc::named_endpoint(root, SSH_AGENT_NAME);
        if path.as_os_str().len() >= SUN_PATH {
            return Err(ListenError::PathTooLong);
        }
        path.display().to_string()
    };
    #[cfg(windows)]
    let address = ipc::named_endpoint(root, SSH_AGENT_NAME);

    stop(root);
    let listener = ipc::Listener::bind_named(root, SSH_AGENT_NAME)
        .map_err(|e| ListenError::Bind(e.to_string()))?;
    let stopped = Arc::new(AtomicBool::new(false));
    let open = Arc::new(AtomicUsize::new(0));
    {
        let stopped = stopped.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let stream = match stream {
                    Ok(stream) => stream,
                    Err(e) => {
                        log::warn!("ssh agent accept: {e}");
                        continue;
                    }
                };
                if open.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    log::warn!("ssh agent: too many connections, closing one");
                    continue;
                }
                open.fetch_add(1, Ordering::SeqCst);
                let (store, hooks, home, stopped, open) = (
                    store.clone(),
                    hooks.clone(),
                    home.clone(),
                    stopped.clone(),
                    open.clone(),
                );
                thread::spawn(move || {
                    let caller = caller_name(&stream);
                    serve(stream, caller, &store, &*hooks, home.as_deref(), &stopped);
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
    }
    running().lock().unwrap_or_else(|e| e.into_inner()).insert(
        root.to_path_buf(),
        Running {
            stopped,
            address: address.clone(),
        },
    );
    Ok(address)
}

/// Stop answering at `root`: no new connection is served, open ones close at their next
/// request, and the socket file goes.
pub fn stop(root: &Path) {
    let Some(was) = running()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(root)
    else {
        return;
    };
    was.stopped.store(true, Ordering::SeqCst);
    // Wakes the accept loop so it sees the flag and drops the listener.
    let _ = ipc::connect_named(root, SSH_AGENT_NAME);
    #[cfg(unix)]
    let _ = std::fs::remove_file(&was.address);
    #[cfg(not(unix))]
    let _ = &was.address;
}

/// One connection's requests, in order, until it closes or the agent stops.
fn serve(
    mut stream: impl Read + Write,
    caller: String,
    store: &Store,
    hooks: &dyn Hooks,
    home: Option<&Path>,
    stopped: &AtomicBool,
) {
    let mut conn = Conn {
        caller,
        forwarded_by: None,
        server: None,
    };
    while let Ok(Some(request)) = protocol::read_request(&mut stream) {
        if stopped.load(Ordering::SeqCst) {
            break;
        }
        let reply = match request {
            Request::Identities => Reply::Identities(store.list(&conn, hooks, UNLOCK_WAIT)),
            Request::Sign { key, data, flags } => {
                match store.sign(&key, &data, flags, &conn, hooks, UNLOCK_WAIT) {
                    Some(signature) => Reply::Signature(signature),
                    None => Reply::Failure,
                }
            }
            Request::SessionBind {
                host_key,
                forwarding,
            } => {
                // The local client binds a forwarded connection before relaying anything from
                // the server, so the first forwarded bind sticks.
                if forwarding && conn.forwarded_by.is_none() {
                    conn.server = Some(match home {
                        Some(home) => ssh_config::server_label(home, &host_key),
                        None => ssh_config::fingerprint(&host_key),
                    });
                    conn.forwarded_by = Some(host_key);
                }
                Reply::Success
            }
            Request::Unsupported => Reply::Failure,
        };
        if protocol::write_reply(&mut stream, &reply).is_err() {
            break;
        }
    }
}

/// The connecting program's name, or "unknown". A label for the user, never a security check.
#[cfg(unix)]
pub(super) fn caller_name(stream: &ipc::Stream) -> String {
    use std::os::fd::AsRawFd;
    peer_name(stream.as_raw_fd()).unwrap_or_else(|| "unknown".into())
}

#[cfg(windows)]
pub(super) fn caller_name(stream: &ipc::Stream) -> String {
    use std::os::windows::io::{AsHandle, AsRawHandle};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            Pipes::GetNamedPipeClientProcessId,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    let pipe = stream.as_handle().as_raw_handle();
    let mut pid = 0u32;
    // SAFETY: the handle is the live pipe this connection owns; pid is a live local.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 {
        return "unknown".into();
    }
    // SAFETY: plain calls on a pid; the process handle is closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return "unknown".into();
    }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: buf and len are live locals of the size passed.
    let ok = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
    };
    // SAFETY: process came from OpenProcess above.
    unsafe { CloseHandle(process) };
    if ok == 0 {
        return "unknown".into();
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let name = Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name.is_empty() {
        "unknown".into()
    } else {
        name
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) fn caller_name(_stream: &ipc::Stream) -> String {
    "unknown".into()
}

#[cfg(target_os = "macos")]
fn peer_name(fd: std::ffi::c_int) -> Option<String> {
    use std::ffi::{c_int, c_void};
    // <sys/un.h>: SOL_LOCAL, LOCAL_PEERPID. <libproc.h>: proc_name.
    const SOL_LOCAL: c_int = 0;
    const LOCAL_PEERPID: c_int = 2;
    extern "C" {
        fn getsockopt(
            s: c_int,
            level: c_int,
            name: c_int,
            value: *mut c_void,
            len: *mut u32,
        ) -> c_int;
        fn proc_name(pid: c_int, buffer: *mut c_void, size: u32) -> c_int;
    }
    let mut pid: c_int = 0;
    let mut len = std::mem::size_of::<c_int>() as u32;
    // SAFETY: pid and len are live locals of the sizes passed.
    let got = unsafe {
        getsockopt(
            fd,
            SOL_LOCAL,
            LOCAL_PEERPID,
            (&mut pid as *mut c_int).cast(),
            &mut len,
        )
    };
    if got != 0 || pid <= 0 {
        return None;
    }
    let mut buf = [0u8; 256];
    // SAFETY: buf is a live local of the size passed.
    let n = unsafe { proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let name = String::from_utf8_lossy(&buf[..usize::try_from(n).ok()?]).into_owned();
    (!name.is_empty()).then_some(name)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn peer_name(fd: std::ffi::c_int) -> Option<String> {
    use std::ffi::{c_int, c_void};
    // <sys/socket.h>: SOL_SOCKET, SO_PEERCRED and struct ucred.
    const SOL_SOCKET: c_int = 1;
    const SO_PEERCRED: c_int = 17;
    #[repr(C)]
    #[allow(dead_code)] // uid and gid are filled in by the kernel and not needed.
    struct Ucred {
        pid: i32,
        uid: u32,
        gid: u32,
    }
    extern "C" {
        fn getsockopt(
            s: c_int,
            level: c_int,
            name: c_int,
            value: *mut c_void,
            len: *mut u32,
        ) -> c_int;
    }
    let mut cred = Ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<Ucred>() as u32;
    // SAFETY: cred and len are live locals of the sizes passed.
    let got = unsafe {
        getsockopt(
            fd,
            SOL_SOCKET,
            SO_PEERCRED,
            (&mut cred as *mut Ucred).cast(),
            &mut len,
        )
    };
    if got != 0 || cred.pid <= 0 {
        return None;
    }
    let name = std::fs::read_to_string(format!("/proc/{}/comm", cred.pid)).ok()?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ssh_agent::{
        ssh_config,
        store::{Ask, KeyInput},
    };
    use std::{
        fs,
        io::{self, Read, Write},
        net::TcpListener,
        os::unix::net::{UnixListener, UnixStream},
        process::{Child, Command, Stdio},
        sync::Mutex,
    };

    const ED: &str = include_str!("fixtures/ed25519");
    const ED_PUB: &str = include_str!("fixtures/ed25519.pub");
    const RSA: &str = include_str!("fixtures/rsa2048");
    const RSA_PUB: &str = include_str!("fixtures/rsa2048.pub");

    /// Unlocked, and answers every ask with a yes on the spot.
    struct Yes {
        store: Arc<Store>,
        asks: Mutex<Vec<Ask>>,
    }

    impl Hooks for Yes {
        fn locked(&self) -> bool {
            false
        }
        fn ask(&self, ask: &Ask) {
            self.asks.lock().unwrap().push(ask.clone());
            self.store.answer(&ask.id, true);
        }
        fn done(&self, _id: &str) {}
    }

    fn agent_with(keys: Vec<KeyInput>) -> (Arc<Store>, Arc<Yes>) {
        let store = Arc::new(Store::new(vec![], true, false));
        let seq = store.claim("A");
        let prepared = store.prepare(keys);
        store.apply(seq, "A", "Personal", prepared).unwrap();
        let hooks = Arc::new(Yes {
            store: store.clone(),
            asks: Mutex::new(Vec::new()),
        });
        (store, hooks)
    }

    fn key(id: &str, name: &str, pem: &str) -> KeyInput {
        KeyInput {
            id: id.into(),
            name: name.into(),
            private_key: pem.into(),
            passphrase: None,
            hosts: vec![],
        }
    }

    fn identities(address: &str) -> io::Result<usize> {
        let mut s = UnixStream::connect(address)?;
        s.write_all(&[0, 0, 0, 1, 11])?;
        let mut len = [0u8; 4];
        s.read_exact(&mut len)?;
        let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut body)?;
        Ok(u32::from_be_bytes(body[1..5].try_into().unwrap()) as usize)
    }

    #[test]
    fn too_long_a_path_is_path_too_long() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a".repeat(120));
        fs::create_dir_all(&root).unwrap();
        let (store, hooks) = agent_with(vec![]);
        assert!(matches!(
            listen(&root, None, store, hooks),
            Err(ListenError::PathTooLong)
        ));
    }

    #[test]
    fn caller_name_names_this_test_binary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s");
        let listener = UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        let (accepted, _) = listener.accept().unwrap();
        let name = caller_name(&accepted);
        assert!(!name.is_empty() && name != "unknown", "{name}");
    }

    #[test]
    fn serves_a_list_over_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let (store, hooks) = agent_with(vec![key("1", "Deploy", ED)]);
        let address = listen(dir.path(), None, store, hooks).unwrap();
        assert_eq!(identities(&address).unwrap(), 1);
        stop(dir.path());
        assert!(identities(&address).is_err(), "still answering after stop");
    }

    #[test]
    fn the_65th_connection_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (store, hooks) = agent_with(vec![key("1", "Deploy", ED)]);
        let address = listen(dir.path(), None, store, hooks).unwrap();
        let open: Vec<_> = (0..MAX_CONNECTIONS)
            .map(|_| {
                let mut s = UnixStream::connect(&address).unwrap();
                s.write_all(&[0, 0, 0, 1, 11]).unwrap();
                let mut buf = [0u8; 4];
                s.read_exact(&mut buf).unwrap();
                s
            })
            .collect();
        let mut extra = UnixStream::connect(&address).unwrap();
        let _ = extra.write_all(&[0, 0, 0, 1, 11]);
        let mut buf = [0u8; 4];
        assert!(extra.read_exact(&mut buf).is_err(), "the 65th was served");
        drop(open);
        stop(dir.path());
    }

    // ---- against real OpenSSH (cargo test ssh_agent -- --ignored) ----

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, text).unwrap();
        path
    }

    #[test]
    #[ignore = "needs OpenSSH's ssh-add and ssh-keygen"]
    fn openssh_lists_and_signs_through_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let (store, hooks) = agent_with(vec![key("1", "Deploy", ED), key("2", "Old box", RSA)]);
        let address = listen(dir.path(), None, store, hooks).unwrap();

        let out = Command::new("ssh-add")
            .arg("-L")
            .env("SSH_AUTH_SOCK", &address)
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&out.stdout);
        assert!(
            listed.contains(ED_PUB.split_whitespace().nth(1).unwrap()),
            "{listed}"
        );
        assert!(
            listed.contains(RSA_PUB.split_whitespace().nth(1).unwrap()),
            "{listed}"
        );
        assert!(
            listed.contains("Deploy") && listed.contains("Old box"),
            "{listed}"
        );

        // Only the public key on disk: a signature can only have come from the agent.
        let pub_file = write(dir.path(), "key.pub", ED_PUB);
        let data = write(dir.path(), "data", "a commit");
        let sign = Command::new("ssh-keygen")
            .args(["-Y", "sign", "-n", "git", "-f"])
            .arg(&pub_file)
            .arg(&data)
            .env("SSH_AUTH_SOCK", &address)
            .output()
            .unwrap();
        assert!(
            sign.status.success(),
            "{}",
            String::from_utf8_lossy(&sign.stderr)
        );
        let allowed = write(dir.path(), "allowed", &format!("fixture {ED_PUB}"));
        let verify = Command::new("ssh-keygen")
            .args(["-Y", "verify", "-I", "fixture", "-n", "git", "-f"])
            .arg(&allowed)
            .arg("-s")
            .arg(dir.path().join("data.sig"))
            .stdin(fs::File::open(&data).unwrap())
            .output()
            .unwrap();
        assert!(
            verify.status.success(),
            "{}",
            String::from_utf8_lossy(&verify.stderr)
        );
        stop(dir.path());
    }

    struct Sshd {
        child: Child,
        port: u16,
    }

    impl Drop for Sshd {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// A throwaway sshd run as this user on a free port, taking both fixture keys.
    fn sshd(dir: &Path) -> Sshd {
        let host_key = dir.join("host_ed25519");
        let made = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&host_key)
            .status()
            .unwrap();
        assert!(made.success());
        let auth = write(dir, "authorized_keys", &format!("{ED_PUB}{RSA_PUB}"));
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = write(
            dir,
            "sshd_config",
            &format!(
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\n\
                 PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n\
                 StrictModes no\nPidFile none\nAllowAgentForwarding yes\nLogLevel ERROR\n",
                host_key.display(),
                auth.display()
            ),
        );
        let sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .expect("an sshd");
        let child = Command::new(sshd)
            .args(["-D", "-e", "-f"])
            .arg(&config)
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        Sshd { child, port }
    }

    fn ssh(
        home: &Path,
        dir: &Path,
        port: u16,
        extra: &[&str],
        command: &str,
    ) -> std::process::Output {
        Command::new("ssh")
            .arg("-F")
            .arg(home.join(".ssh/bramble/config"))
            .args([
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "BatchMode=yes",
                "-o",
                "AddressFamily=inet",
            ])
            .arg("-o")
            .arg(format!(
                "UserKnownHostsFile={}",
                dir.join("known_hosts").display()
            ))
            .args(["-v", "-p", &port.to_string()])
            .args(extra)
            .arg("localhost")
            .arg(command)
            .output()
            .unwrap()
    }

    #[test]
    #[ignore = "needs OpenSSH's sshd and ssh"]
    fn a_real_sshd_login_uses_only_the_named_key() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (store, hooks) = agent_with(vec![key("1", "Deploy", ED), key("2", "Old box", RSA)]);
        let address = listen(dir.path(), None, store, hooks).unwrap();
        let named = ssh_config::VaultKey {
            blob: crate::ssh_agent::keys::parse(ED, None)
                .unwrap()
                .public_blob()
                .to_vec(),
            hosts: vec!["localhost".into()],
        };
        ssh_config::write_main(home.path(), &address, false).unwrap();
        ssh_config::write_vault(home.path(), "A", &[("1".into(), named)]).unwrap();
        let server = sshd(dir.path());

        let out = ssh(home.path(), dir.path(), server.port, &[], "true");
        let log = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "{log}");
        let offered: Vec<_> = log
            .lines()
            .filter(|l| l.contains("Offering public key"))
            .collect();
        assert_eq!(offered.len(), 1, "{offered:?}");
        assert!(offered[0].contains("ED25519"), "{offered:?}");
        stop(dir.path());
    }

    #[test]
    #[ignore = "needs OpenSSH's sshd and ssh"]
    fn a_forwarded_server_asks_before_listing() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (store, hooks) = agent_with(vec![key("1", "Deploy", ED)]);
        let address = listen(
            dir.path(),
            Some(home.path().to_path_buf()),
            store,
            hooks.clone(),
        )
        .unwrap();
        ssh_config::write_main(home.path(), &address, false).unwrap();
        let server = sshd(dir.path());

        let out = ssh(home.path(), dir.path(), server.port, &["-A"], "ssh-add -L");
        let listed = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            listed.contains(ED_PUB.split_whitespace().nth(1).unwrap()),
            "{listed}"
        );
        let asks = hooks.asks.lock().unwrap().clone();
        assert_eq!(asks.len(), 1, "{asks:?}");
        assert_eq!(asks[0].mode, crate::ssh_agent::store::Mode::AllowServer);
        assert!(asks[0]
            .server
            .as_deref()
            .is_some_and(|s| s.starts_with("SHA256:")));
        stop(dir.path());
    }
}
