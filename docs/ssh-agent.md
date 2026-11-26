# SSH agent in the desktop app

**Status: built 2026-11-25, unreleased.** Phase 6 of [desktop-port.md](desktop-port.md). Checked on
macOS against OpenSSH 10.2 (`ssh-add`, `ssh-keygen -Y`, a real `sshd` login, `ssh -A`) and in the
desktop e2e (`e2e/desktop-link/ssh-agent.spec.ts`). Not yet run on Windows or Linux, and the Mac
checks with Touch ID and a security key are owed.

## Bottom line

- The desktop app (macOS, Linux, Windows) speaks the OpenSSH agent protocol, so `ssh`, `git`,
  `scp`, `rsync`, VS Code Remote and git commit signing use the SSH keys already in the vault. The
  private key never leaves Bramble: the client sends the data it needs signed and gets a signature
  back.
- **A key can name its hosts.** `ssh 123.123.123.123` is offered only the key whose Hosts list says
  `123.123.123.123`, from the first connection on. `ssh` does the matching, from a config Bramble
  writes, because the agent protocol never tells an agent which host it is for.
- **Every vault's keys are offered** to a host no key names, as the macOS AutoFill sheet offers
  every vault's logins in Safari. A switch turns that off.
- **Unlocked means it just works.** While the key's vault is open, signing asks nothing, for the
  auto-lock time the user set (15 minutes by default). A switch makes it ask every time.
- **Locked means Bramble comes forward on the unlock screen** of the vault holding the key, with
  whatever that vault unlocks with: master password, Touch ID or Windows Hello, a security key. The
  signature goes out as soon as it opens.
- **A server reached with `ssh -A` asks once** per server per unlock, before it can see or use any
  key.
- **Off by default.** One switch in Settings and one line at the top of `~/.ssh/config`, which
  Bramble can add itself.
- **Desktop only.** The browser extension and the phone apps can't listen on a local socket and
  never receive a private key. They show and edit the two new fields on an SSH key, and sync them.

## What exists already

- The `ssh-key` entry type (name, public key, private key, passphrase, notes) syncs and imports
  today (`app/entry-modes/ssh-key.tsx`, CXF in [credential-exchange.md](credential-exchange.md)).
- The VEK lives in the desktop's Rust process (`src-tauri/src/crypto.rs`). Decrypted entries reach
  Rust through the autofill adapter on unlock and on every save, and leave it on lock and
  auto-lock (`index_store`). The SSH keys travel the same way, on a path of their own.
- `lifetime::show_main` brings the vault window forward; the browser link already uses it.
- Touch ID, Windows Hello and security-key unlock are the app's ordinary unlock screen.

## Two new fields on an SSH key

| Field | Form | Stored | Meaning |
|---|---|---|---|
| Hosts | **Hosts (optional)**, one per line, hint "Bramble offers this key only to these hosts." | `hosts?: string[]` | What you type after `ssh`: `github.com`, `123.123.123.123`, `*.example.com`, or an alias like `prod` or `github-work`. |
| Use with the SSH agent | A switch, on by default | `agentDisabled?: true` only when off | Off: the key is never listed or written to the config. For keys that must never sign silently, such as an SSH certificate authority. |

- **A host is only a host.** Letters, digits and `. - _ * ? : %` (wildcards, IPv6, zone ids). The
  form refuses anything else ("Use only the host, like github.com or 10.0.0.5") and strips a
  `user@` prefix. Rust checks again before writing the config, because these values come from sync
  and imports, and a newline or space in a host would let a crafted entry add a `ProxyCommand`
  that runs whenever `ssh` starts. A host that fails the check is left out and named in Settings.
- **Hosts are their own field, not `urls`.** About ten places read `urls` as websites (TOTP setup
  suggestions, entry de-duplication, KeePass export); server addresses must not reach them.
  `hosts` is an ordinary part for sync: concurrent edits on two devices ask the user to choose.
- **The entry page** lists the hosts, and search matches them.
- **Exports and imports carry hosts.** KeePass and CXF exports add a `Hosts` field beside the key's
  other fields; a `.bramble` backup carries both fields as they are. A LastPass `SSH Key` note's
  `Hostname` becomes the key's host when it is one, and stays a custom field when it isn't.
  "Use with the SSH agent" is a setting rather than content, so only `.bramble` keeps it.

### Older apps keep the new fields

An app that doesn't know `hosts` keeps it when it edits an SSH key. Since 7797ce90 (2026-10-24,
shipped on every target) the edit form saves the opened version with the form's fields laid over
it, and the other callers that update an entry pass the whole entry. A field is only cleared when
a form names it, so every entry mode's `toEntry` names each field it owns, `undefined` when empty;
a test checks every mode for that. Only a build older than that commit, still in use, would drop
the hosts on an edit.

## Setting it up

Settings > General > **SSH agent**, desktop only:

- **Use your SSH keys in the terminal.** "ssh and git sign with the keys in your vaults. Their
  public keys, names and hosts are stored outside your vaults while this is on."
- **The setup line**, shown once the switch is on: `Include ~/.ssh/bramble/config`, to go at the
  top of `~/.ssh/config`, with **Copy** and **Add it for me**.
  - Add it for me puts the line first in `~/.ssh/config`, creating `~/.ssh` (0700) and the file
    (0600) if needed, written through a temporary file and a rename. When `~/.ssh/config` is a
    symlink (a dotfiles manager) or not writable, the button isn't offered.
  - The row reads **Added to ~/.ssh/config** when the line is in the file before any `Host` or
    `Match`, and **Move this line to the top of ~/.ssh/config** when it's lower down.
- **Ask before each use**, off. "Bramble asks every time a key is used, even while unlocked."
- **Offer keys only to their hosts**, off. "Servers not named on any key see none of your keys."
- **Keys Bramble can't use**, with the reason and the fix, and hosts it left out.

## Files Bramble writes

```
~/.ssh/bramble/config             written at switch-on, rewritten when a setting changes
~/.ssh/bramble/vaults/<id>.conf   one per vault, written whenever that vault is open
~/.ssh/bramble/keys/<sha256>.pub  public key of each key that names a host
```

```
# ~/.ssh/bramble/config (written by Bramble)
Include ~/.ssh/bramble/vaults/*.conf
Host *
  IdentityAgent "~/Library/Application Support/app.bramble.desktop/ssh-agent.sock"
  # only with Offer keys only to their hosts:
  IdentitiesOnly yes
```

```
# ~/.ssh/bramble/vaults/<id>.conf (written by Bramble)
Host 123.123.123.123 *.example.com
  IdentityFile ~/.ssh/bramble/keys/9f2c….pub
  IdentitiesOnly yes
```

- When `IdentityFile` names a `.pub`, `ssh` uses the matching key from the agent. `IdentityFile`
  adds up across blocks, so two keys naming the same host are both offered, in order.
- `ssh` matches what was typed, so aliases from the user's own config, jump hosts (the jump runs
  its own `ssh`) and every tool that runs `ssh` behave the same.
- `ssh` takes the first value it finds for a setting, so Bramble's lines win over the user's for
  the same host. Help says to put any host-specific `IdentityAgent` above the `Include` line.
- **Bramble owns these files; nobody edits them.** Every save of an SSH key rewrites its vault's
  `.conf`, `.pub` files and key list, because the save already sends the keys to Rust. A rename
  touches only the list (no names here); a changed host rewrites the `.conf`; a replaced or deleted
  key takes its `.pub` with it; a vault with no hosts left loses its `.conf`. Hand edits are
  overwritten, as the header says; host-specific settings belong in the user's own config.
- **Edits from another device** arrive by sync, which reloads the open vault and rewrites the same
  way. Sync doesn't run while locked, so a vault's files reflect the last time it was open here.
  The cost is small: a key removed elsewhere stays listed until then, and using it brings up the
  unlock, after which the key is gone and the request fails.
- **Writes are atomic and in order.** Each file goes through a temporary file and a rename, so
  `ssh` never reads half of one, and a slow older save never lands after a newer one: each save
  takes a per-vault sequence number and an older one is dropped. The number is taken when the save
  reaches Rust, so it orders arrivals there; two saves the window sent close together can arrive
  either way round, and the next save corrects the files. Keys that arrive after a lock are
  refused, and so is anything parsed before it.
- **A deleted `~/.ssh/bramble`** comes back with the next save or launch.
- **Bramble has to be running** for a host named on a key: that host is offered only the key that
  lives in Bramble. With Bramble quit, `ssh` carries on without the agent, and that host gets only
  the keys the user's own config names, or a password prompt if it takes one.
- **Uninstalling:** switch the agent off first, which deletes `~/.ssh/bramble`. The `Include` line
  can stay: a missing file matches nothing. No installer can do this for you, since the files are
  per user.
- Paths inside these files are absolute and quoted (shown with `~` above): OpenSSH expands `~` from
  the account's passwd entry, not `$HOME`. Only the `Include` line in the user's own config uses
  `~`.
- No vault or key names in these files: vault ids, hosts and fingerprints only. Dir 0700, files
  0600. Pruned like the key lists below; deleted when the switch goes off, and at launch while it
  is off. Only files Bramble wrote go (its header, or its key-file names); a `~/.ssh/bramble` the
  user had before keeps whatever else is in it, and the folder goes only once it is empty. The
  `Include` line can stay: a missing file matches nothing.

## How a request goes

1. **ssh asks for the list.** Bramble answers with every vault's public keys, locked or not,
   without asking: the open vault's first, then the others. Within a vault, the key last used in
   the app (copied or filled) comes first; a signature doesn't count as a use. The
   comment `ssh-add -l` shows is the entry's name. When the host is named on a key, ssh has
   already narrowed the offer to that key.
2. **ssh offers keys to the server** one at a time, and the server says which it accepts. No
   signature is involved yet, so a server that takes none of them never brings Bramble forward.
3. **ssh asks Bramble to sign** with the accepted key.
   - **Its vault is open:** sign and answer. With Ask before each use, a card first: "ssh wants to
     sign in to a server with GitHub", **Allow** and **Deny**.
   - **Bramble is locked:** the vault window comes forward on that vault's unlock screen with a
     line saying who asked, for which key and why, and **Cancel**. The request waits. When the
     vault opens, the signature goes out. Cancel, closing the window, or two minutes with no
     unlock answers with a failure and ssh moves on to its next key or method. With **Unlock on
     open** on, Touch ID or Windows Hello comes up by itself, once per request, even after the
     Lock button ([auth-and-unlock.md](auth-and-unlock.md)). A request that joins one already
     waiting brings the window forward again, wherever the user put it.
   - **Another vault is open:** a card in the open vault: "ssh wants to use Deploy from Work.
     Open Work? Personal will lock." **Open Work** locks the open vault and shows Work's unlock
     screen, as Lock then Choose a different vault does today; **Cancel** fails the request and
     leaves the open vault as it was. The card is there because the app holds one vault's key at
     a time: showing Work's unlock screen without locking first would leave the window on one
     vault while Rust holds another's key, the shape of issue #27.

The line names the purpose, read from the data to sign: "sign in to a server", "sign a git commit"
(an SSHSIG request in the `git` namespace) or "sign a message" (any other SSHSIG request).

4. **The window goes back** once nothing has asked for 0.4 seconds: hidden again if it was hidden;
   if it was behind another app or minimised, the app hides on macOS, which hands focus back to the
   terminal, and the window minimises elsewhere. A window the user was already in stays. Where it
   was is read when the first card comes up, so an unlock that turns into a switch doesn't count
   the window it raised itself. The wait is for that turn: the store ends one ask just before it
   raises the next. (`ssh_agent/step_back.rs`)

## A server reached with `ssh -A`

With agent forwarding, the server you're logged into can talk to Bramble. OpenSSH 8.9 and later
bind each agent connection to the server's host key (`session-bind@openssh.com`) and say when it
is forwarded. On such a connection:

- **Nothing is listed or signed until you allow that server.** A card: "Let bastion use your SSH
  keys? A server you're connected to with ssh -A wants to see and use your keys until Bramble
  locks." **Allow** and **Deny**. The server is named from `known_hosts` when its entry isn't
  hashed, else by the host key's fingerprint.
- **Allow lasts until lock,** for that server's host key: later lists and signatures through it ask
  nothing. Ask before each use still asks for each signature. While locked, the unlock screen
  carries the same line, and unlocking from it allows that server.
- **Deny** answers that connection with an empty list and failures.
- The forwarded flag sticks to the connection: the local client binds it before relaying anything
  from the server, so a later bind can't clear it.
- **Older clients don't bind.** Their forwarded requests look local and are signed while unlocked.
  Windows 10 ships OpenSSH 8.1 and Debian 11 ships 8.4; the help article says so.
- The Hosts list doesn't reach a forwarded request: the server's `ssh` reads the server's config.

## Decisions

- **No prompt while unlocked, by default.** The auto-lock time is the user's answer to "how long
  may Bramble act without asking", as it is for AutoFill
  ([macos-credential-provider.md](macos-credential-provider.md#following-the-apps-unlock)). Like
  the standard `ssh-agent`, any program running as the user can ask for a signature in that window
  (see [What it exposes](#what-it-exposes)). Ask before each use is there for those who want a
  prompt per use.
- **A signature doesn't extend auto-lock.** A fill counts as use because a person clicked; an SSH
  signature can come from a script or a cron job, and counting it would keep the vault open
  forever.
- **Keys leave memory on lock.** Lock and auto-lock drop every decrypted key and the parse cache,
  so a locked Bramble holds no private key at all. Listing while locked runs from the public lists.
- **Public keys and key names sit outside the vault.** Listing a locked vault's keys needs them in
  the clear, so each vault gets a small file in the app's data folder (0700), written while that
  vault is open: public keys, entry names and their order, no timestamps. Not the OS credential
  store: Windows caps a credential at 2560 bytes, and `ssh` needs the host files in the clear
  anyway. The files exist only while the agent is on; deleting a vault deletes its file, and a
  vault no longer in the picker is pruned on the next write, as with the AutoFill copies. A vault
  never opened since the switch went on has no file, so its keys aren't offered until it's opened
  once.
- **Only keys Bramble can sign with are listed**, so a key with a wrong passphrase is never
  offered and never brings Bramble forward. Settings names it.
- **The same key in two vaults** is offered once. Signing uses the open vault's copy if it holds
  one.
- **The vault is the only source of keys.** `ssh-add` of a file, removing a key and the agent's own
  lock are refused.
- **SHA-1 RSA signatures are refused.** OpenSSH has asked for `rsa-sha2-256` or `rsa-sha2-512`
  since 7.2, and turned SHA-1 `ssh-rsa` off by default in 8.8.
- **Prompts stay calm.** One card or unlock line per vault at a time; a request that arrives while
  one is showing joins it rather than raising the window again. Never a confirm card, though: with
  Ask before each use every use gets its own, and an unlock approves only the request that brought
  it up. At most 8 requests wait and 64 connections are open; past that, requests fail at once.
- **A request always shows what it now needs.** One waiting on an unlock that finds another vault
  opened asks again, as the switch card. A window opened after a request was asked (rebuilt after
  a close, or reloaded) fetches the requests already waiting. While locked, the key's vault is put
  on the unlock screen once per request, so choosing another vault there sticks.
- **Hostile keys can't stall the app.** At most 1024 bcrypt-pbkdf rounds and 8192-bit RSA; beyond
  either, the key is "not supported". Keys are parsed off the main thread.
- **Only the vault window drives the agent.** Commands this crate defines aren't limited by Tauri's
  per-window capabilities (`capabilities/spotlight.json`), so every `ssh_agent_*` command refuses
  any window but the main one, as `backup.rs` does.
- **Nothing about keys is logged.** No key names, hosts, callers or signed data in `bramble.log`,
  which ends up in bug reports: counts and reasons only.

## Keys it can use

| Stored as | Algorithms | Notes |
|---|---|---|
| OpenSSH (`BEGIN OPENSSH PRIVATE KEY`) | ed25519, ECDSA P-256/384/521, RSA | Encrypted ones open with the entry's passphrase (bcrypt-pbkdf). The public key is read from the file, so an encrypted key is listed without its passphrase. |
| PKCS#1 (`BEGIN RSA PRIVATE KEY`) | RSA | Unencrypted only. |
| SEC1 (`BEGIN EC PRIVATE KEY`) | ECDSA P-256/384/521 | Unencrypted only. |
| PKCS#8 (`BEGIN PRIVATE KEY`) | ed25519, ECDSA, RSA | What a CXF import stores. Unencrypted only. |

Not served: hardware security-key types (`sk-ssh-ed25519`, `sk-ecdsa`), whose private half is on
the key; DSA; the old OpenSSL-encrypted PEM (`Proc-Type: 4,ENCRYPTED`) and encrypted PKCS#8; the
limits above. Settings names any key it can't use and says to re-save it with
`ssh-keygen -p -f <file>`, which writes the OpenSSH format. The public key is always derived from
the private key; the entry's own public key field is display only.

## Where it listens

| | Address |
|---|---|
| macOS | `~/Library/Application Support/app.bramble.desktop/ssh-agent.sock` |
| Linux | `~/.local/share/app.bramble.desktop/ssh-agent.sock` (under `$XDG_DATA_HOME` when set) |
| Windows | `\\.\pipe\app.bramble.desktop.ssh-agent.<id>` `[unverified: IdentityAgent with a pipe]` |

- Beside the browser link's `bramble.sock`, through the same `ipc::Listener` with its own name, so
  one piece of code owns both endpoints. Owner-only permissions, as there. Windows pipes share one
  machine-wide namespace, so the name carries the per-user tag the browser pipe already uses.
- The generated config points `IdentityAgent` at it. Setting `SSH_AUTH_SOCK` works too, without
  hosts. Git commit signing needs `SSH_AUTH_SOCK`: git signs through `ssh-keygen -Y sign`, which
  never reads `ssh_config`, so `IdentityAgent` doesn't reach it. The help article says so.
- A Unix socket path is capped at 104 bytes on macOS and 108 on Linux. A home folder long enough to
  hit it gets a plain message in Settings rather than a silent failure.
- Windows: a pipe of our own, not `openssh-ssh-agent`, which Windows' own agent service holds and
  which only one user on a machine could take. Git for Windows ships its own ssh that can't reach a
  pipe; the help article points it at Windows' OpenSSH (`core.sshCommand`).

## How keys reach the agent

- `@core` projects the vault's SSH key entries (id, name, private key, passphrase, hosts, whether
  the agent may use it) and sends them through the vault-scoped autofill adapter wherever it sends
  the autofill index: on unlock, on every save and on refresh. Through `withVault`, so the keys are
  always tagged with the vault they came from, never the recorded active vault (the lesson of
  2026-11-20 in [macos-credential-provider.md](macos-credential-provider.md#handing-a-sandboxed-extension-the-vault)).
- Only the desktop adapter implements it. The extension's index, the phone's AutoFill copy and the
  macOS AutoFill copy never receive an SSH private key.
- Rust ignores the keys while the agent is off; otherwise it parses them, keeps each signable key
  (zeroized on drop) until lock, and writes that vault's public list, `.conf` and `.pub` files.
- Switching the agent on while unlocked sends the open vault's keys again, as the Keyboard
  suggestions switch does (`refreshAutofillIndex`).

## What it exposes

What remains once everything above is in place:

- **Any program running as the user can sign while the key's vault is unlocked**, unless Ask
  before each use is on. It can't take the key away: once Bramble locks, it has nothing. A key
  file in `~/.ssh` can be copied once and used forever.
- **Any program can read the key list and the files in `~/.ssh/bramble`**: public keys, key names,
  and which hosts each key is for.
- **A server no key names sees every public key** while `ssh` tries them, which can link keys from
  different vaults. Hosts, or Offer keys only to their hosts, end that.
- **Forwarded requests from clients older than OpenSSH 8.9 look local.**
- **A lookalike window could ask for the master password** once users expect `ssh` to bring Bramble
  forward. The Touch ID and Windows Hello system prompts are harder to fake.
- **Windows: another account could take the pipe name first.** Bramble then fails to listen and
  says so in Settings; that account's pipe could answer the user's `ssh` `[unverified: whether
  ssh.exe limits pipe impersonation]`.

## Code

The agent is all in the desktop crate, `src-tauri/src/ssh_agent/`, so the extension's wasm and the
phone apps never link it. No `core-rust` change.

- `keys.rs`: read the four formats, derive the public key, sign, enforce the limits.
- `protocol.rs`: the agent messages. List (11 to 12), sign (13 to 14), extensions (27) for
  `session-bind@openssh.com`, and failure (5) for everything else. Several requests per
  connection; a frame larger than 256 KiB is refused.
- `store.rs`: the open vault's keys, the per-vault public lists, allowed forwarding servers and
  requests waiting for an answer. Whether to sign, ask or fail is one pure function of the key,
  the lock state, the open vault, the connection's forwarding server and the settings, re-run on
  every wake, so a lock while a request waits can't sign with keys that are gone.
- `ssh_config.rs`: the files in `~/.ssh/bramble`, host validation, and reading and editing
  `~/.ssh/config` for the setup row.
- `listener.rs`: the socket or pipe, the connection caps, and the caller's process name for the
  line (`LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux, `GetNamedPipeClientProcessId` on
  Windows). The name is a label for the user, not a security check: anything running as the user
  can name itself `ssh`.
- `commands.rs`: the Tauri commands, main window only, and the settings, kept in the app's meta
  like the Quick Access shortcut rather than as webview prefs.
- `step_back.rs`: where the window was before a request raised it, and when to put it back.

**New crates:** `ssh-key` 0.6 (the OpenSSH container, bcrypt-pbkdf decryption, the wire encodings)
without its `rsa` feature, which pins `rsa` 0.9 and RUSTSEC-2023-0071; `rsa` 0.10 directly, the
first release that fixes it (2026-11-08); `p384` and `p521` for the larger ECDSA curves.
`ed25519-dalek` and `p256` are already in the tree.

## Testing it

- Fixtures made with `ssh-keygen` for every row of the key table, encrypted and not, plus the
  refused ones and keys past the limits. Each signature checks against the public key.
- Host validation against injection attempts: newlines, spaces, quotes, `#`, `=`.
- Against the real client without a server: `SSH_AUTH_SOCK=<socket> ssh-add -L` lists the keys,
  and `ssh-keygen -Y sign` then `-Y verify` round-trips a signature.
- Through a throwaway `sshd` run as the user on a high port (macOS ships one): a login using the
  generated config, where `ssh -v` shows only the named key offered; and `ssh -A`, where the
  server's `ssh-add -L` gets the allow card first.
- The desktop e2e: a locked app, a sign request, the unlock screen with the line, unlock, the
  signature arrives; Cancel answering a failure; Add it for me writing the line.
- On a Mac by hand: Touch ID and a YubiKey unlock from a terminal request, git commit signing, a
  key in a second vault, and `ssh -A`.

## Still to check

- Whether macOS brings the window to the front for an unlock request when another app has focus.
  The e2e raises the window itself, so it doesn't prove this. If it can't reliably, a notification
  or a bouncing Dock icon is the fallback.
- Whether Windows OpenSSH reads `Include` and a pipe in `IdentityAgent`. If not, Windows sets
  `SSH_AUTH_SOCK` and has no hosts. The Windows code compiles; it hasn't run on a Windows machine.
