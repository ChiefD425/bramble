# SSH agent in the desktop app

**Status: designed 2026-11-25, not built.** Phase 6 of [desktop-port.md](desktop-port.md).

## Bottom line

- The desktop app (macOS, Linux, Windows) speaks the OpenSSH agent protocol, so `ssh`, `git`,
  `scp`, `rsync` and git commit signing (`ssh-keygen -Y sign`) use the SSH keys already in the
  vault. The private key never leaves Bramble: the client sends the data it needs signed and gets a
  signature back.
- **Every vault's keys are offered.** The agent lists the keys of every vault on this computer,
  open or not, as the macOS AutoFill sheet offers every vault's logins in Safari.
- **Unlocked means it just works.** While the key's vault is open, signing asks nothing. The vault
  stays open for the auto-lock time the user set (15 minutes by default), as for anything else.
- **Locked means Bramble comes forward on the unlock screen** of the vault holding the key, with
  whatever that vault unlocks with: master password, Touch ID or Windows Hello, a security key. The
  signature goes out as soon as it opens.
- **Off by default.** One switch in Settings and one line in `~/.ssh/config`.
- **Desktop only.** The browser extension and the phone apps can't listen on a local socket, and
  the keys are never sent to them.

## What exists already

- The `ssh-key` entry type (name, public key, private key, passphrase, notes) syncs and imports
  today (`app/entry-modes/ssh-key.tsx`, CXF in [credential-exchange.md](credential-exchange.md)).
  No vault-format, sync or importer change is needed.
- The VEK lives in the desktop's Rust process (`src-tauri/src/crypto.rs`). Decrypted entries reach
  Rust through the autofill adapter on unlock and on every save, and leave it on lock and
  auto-lock (`index_store`). The SSH keys travel the same way.
- `lifetime::show_main` brings the vault window forward; the browser link already uses it.
- Touch ID, Windows Hello and security-key unlock are the app's ordinary unlock screen. Nothing new
  is needed to support them here.

## How a request goes

1. **ssh asks for the list.** Bramble answers with every vault's public keys, locked or not,
   without asking. The open vault's keys come first, then the others; within a vault, the key used
   last comes first. The comment `ssh-add -l` shows is the entry's name.
2. **ssh offers keys to the server** one at a time, and the server says which one it accepts. No
   signature is involved yet, so a server that takes none of them never brings Bramble forward.
3. **ssh asks Bramble to sign** with the accepted key.
   - **Its vault is open:** sign and answer.
   - **Bramble is locked:** the vault window comes forward on that vault's unlock screen, with a
     line saying who asked and for which key ("ssh wants to use GitHub from Personal"). The request
     waits. When the vault opens, the signature goes out. Cancel, or two minutes with no unlock,
     answers with a failure and ssh moves on to its next key or method.
   - **Another vault is open:** Bramble comes forward with a card in the open vault ("ssh wants
     to use Deploy from Work. Open Work?"). Opening it locks the open vault and shows Work's
     unlock screen, as Lock then Choose a different vault does today; Cancel answers with a
     failure and leaves the open vault as it was. The card is there because the app holds one
     vault's key at a time: showing Work's unlock screen without locking first would leave the
     window on one vault while Rust holds another's key, the shape of issue #27.

Several requests waiting on the same vault share one unlock.

## Decisions

- **No prompt while unlocked.** The auto-lock time is the user's answer to "how long may Bramble
  act without asking", as it is for AutoFill ([macos-credential-provider.md](macos-credential-provider.md#following-the-apps-unlock)).
  Like the standard `ssh-agent`, any program running as the user can ask for a signature in that
  window. This is the trade the user chose.
- **A signature doesn't extend auto-lock.** A fill counts as use because a person clicked; an SSH
  signature can come from a script or a cron job, and counting it would keep the vault open
  forever.
- **Forwarded requests always ask.** With `ssh -A` or `ForwardAgent yes`, the server you're logged
  into can ask for signatures. OpenSSH 8.9 and later say when a request was forwarded
  (`session-bind@openssh.com`), and those requests bring Bramble forward with a confirmation even
  while unlocked ("A server you're connected to wants to use GitHub"). Older clients don't say, so
  their requests count as local. The flag sticks to the connection: the local ssh client binds a
  forwarded connection before relaying anything from the server, so a later bind can't clear it.
- **Public keys and key names sit outside the vault.** Listing a locked vault's keys needs them in
  the clear, so each vault gets a small file in the app's data folder, written while that vault is
  open: public keys, entry names and their order, no timestamps. These are what servers already
  hold. The files exist only while the agent is switched on: switching it off deletes them all,
  deleting a vault deletes its file, and a vault no longer in the picker is pruned on the next
  write, as with the AutoFill copies. A vault never opened since the switch went on has no file,
  so its keys aren't offered until it's opened once. Only keys Bramble can sign with go in the
  file, so a key with a wrong passphrase is never offered and never brings Bramble forward.
- **The same key in two vaults** is offered once. Signing uses the open vault's copy if it holds
  one.
- **The vault is the only source of keys.** `ssh-add` of a file, removing a key and the agent's own
  lock are refused. The keys come and go with the vault.
- **SHA-1 RSA signatures are refused.** OpenSSH has asked for `rsa-sha2-256` or `rsa-sha2-512`
  since 7.2, and turned SHA-1 `ssh-rsa` off by default in 8.8.

## Keys it can use

| Stored as | Algorithms | Notes |
|---|---|---|
| OpenSSH (`BEGIN OPENSSH PRIVATE KEY`) | ed25519, ECDSA P-256/384/521, RSA | Encrypted ones open with the entry's passphrase (bcrypt-pbkdf). The public key is read from the file, so an encrypted key is listed without its passphrase. |
| PKCS#1 (`BEGIN RSA PRIVATE KEY`) | RSA | Unencrypted only. |
| SEC1 (`BEGIN EC PRIVATE KEY`) | ECDSA P-256/384/521 | Unencrypted only. |
| PKCS#8 (`BEGIN PRIVATE KEY`) | ed25519, ECDSA, RSA | What a CXF import stores. Unencrypted only. |

Not served: hardware security-key types (`sk-ssh-ed25519`, `sk-ecdsa`), whose private half is on
the key; DSA; the old OpenSSL-encrypted PEM (`Proc-Type: 4,ENCRYPTED`) and encrypted PKCS#8. The
Settings section names any key it can't use and says to re-save it with `ssh-keygen -p -f <file>`,
which writes the OpenSSH format. The public key is always derived from the private key; the
entry's own public key field is display only.

## Where it listens

| | Address | What the user adds |
|---|---|---|
| macOS | `~/Library/Application Support/app.bramble.desktop/ssh-agent.sock` | `IdentityAgent "~/Library/Application Support/app.bramble.desktop/ssh-agent.sock"` under `Host *` |
| Linux | `~/.local/share/app.bramble.desktop/ssh-agent.sock` (under `$XDG_DATA_HOME` when set) | the same, with that path |
| Windows | `\\.\pipe\app.bramble.desktop.ssh-agent.<id>` | `IdentityAgent` with that pipe, shown in Settings `[unverified]` |

- Beside the browser link's `bramble.sock`, through the same `ipc::Listener` with its own name, so
  one piece of code owns both endpoints. Owner-only permissions, as there. Windows pipes share one
  machine-wide namespace, so the name carries the per-user tag the browser pipe already uses.
- Settings shows the line with a copy button. Setting `SSH_AUTH_SOCK` works too.
- A Unix socket path is capped at 104 bytes on macOS and 108 on Linux. A home folder long enough to
  hit it gets a plain message in Settings rather than a silent failure.
- Windows: a pipe of our own, not `openssh-ssh-agent`, which Windows' own agent service holds. Git
  for Windows ships its own ssh that can't reach a pipe; the help article points it at Windows'
  OpenSSH (`core.sshCommand`).

## How keys reach the agent

- `@core` projects the vault's SSH key entries (id, name, private key, passphrase) and pushes them
  through the vault-scoped autofill adapter wherever it pushes the autofill index: on unlock, on
  every save and on refresh. Through `withVault`, so the keys are always tagged with the vault they
  came from, never the recorded active vault (the lesson of 2026-11-20 in
  [macos-credential-provider.md](macos-credential-provider.md#handing-a-sandboxed-extension-the-vault)).
- Only the desktop adapter implements it. The extension's index, the phone's AutoFill copy and the
  macOS AutoFill copy never receive an SSH private key.
- Rust drops the keys when the agent is off, parses them on arrival (keeping each decrypted key,
  zeroized on drop, until lock), and writes that vault's public list. Lock and auto-lock clear
  the keys wherever they clear `index_store`.
- Switching the agent on while unlocked sends the open vault's keys again, as the Keyboard
  suggestions switch does (`refreshAutofillIndex`).

## Code

All of it in the desktop crate, `src-tauri/src/ssh_agent/`, so the extension's wasm and the phone
apps never link it. No `core-rust` change.

- `keys.rs`: read the four formats, derive the public key, sign.
- `protocol.rs`: the agent messages. List (11 to 12), sign (13 to 14), extensions (27) for
  `session-bind@openssh.com`, and failure (5) for everything else. Several requests per
  connection; a frame larger than 256 KiB is refused.
- `listener.rs`: the socket or pipe, and the caller's process name for the unlock line (`LOCAL_PEERPID`
  on macOS, `SO_PEERCRED` on Linux, `GetNamedPipeClientProcessId` on Windows). The name is a
  label for the user, not a security check: anything running as the user can name itself `ssh`.
- `store.rs`: the open vault's keys, the per-vault public lists, and requests waiting for an
  unlock. Whether to sign, ask or fail is one pure function of the key, the lock state, the open
  vault and the forwarded flag, re-run on every wake, so a lock while a request waits can't
  sign with keys that are gone.
- `commands.rs`: the Tauri commands, and the on/off switch, kept in the app's meta like the Quick
  Access shortcut rather than as a webview pref.

**New crates:** `ssh-key` 0.6 (the OpenSSH container, bcrypt-pbkdf decryption, the wire encodings)
without its `rsa` feature, which pins `rsa` 0.9 and RUSTSEC-2023-0071; `rsa` 0.10 directly, the
first release that fixes it (2026-11-08); `p384` and `p521` for the larger ECDSA curves.
`ed25519-dalek` and `p256` are already in the tree.

## Testing it

- Fixtures made with `ssh-keygen` for every row of the key table, encrypted and not, plus the
  refused ones. Each signature checks against the public key.
- Against the real client without a server: `SSH_AUTH_SOCK=<socket> ssh-add -L` lists the keys,
  and `ssh-keygen -Y sign` then `-Y verify` round-trips a signature.
- A login through a throwaway `sshd` run as the user on a high port (macOS ships one), with and
  without `-A`, so the forwarded flag is checked against real OpenSSH.
- The desktop e2e: a locked app, a sign request, the unlock screen with the line, unlock, the
  signature arrives; and Cancel answering a failure.
- On a Mac by hand: Touch ID and a YubiKey unlock from a terminal request, git commit signing, and
  a key in a second vault.
