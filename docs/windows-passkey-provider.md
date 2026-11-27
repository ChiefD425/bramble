# Windows passkey provider: Bramble in Windows 11's passkey managers

Plan for making the Windows desktop app a passkey manager through Windows 11's plugin API, so
Bramble appears in **Settings > Accounts > Passkeys > Advanced options > Passkey managers** and
creates and signs passkeys for Edge, Chrome and other apps that use Windows' WebAuthn. It is the
Windows counterpart of [macos-credential-provider.md](macos-credential-provider.md). Passwords and
one-time codes are out of scope; see [Passwords and one-time codes](#passwords-and-one-time-codes).

Three classes of claim live here. **Verified** claims are read from this repository and carry a
file path. **Checked** claims come from Microsoft and other live sources and carry a link; all were
checked on 2026-11-26. **Observed** claims were seen on a test machine on 2026-11-26: a VMware
Fusion 26.0.0 virtual machine on an Apple M1 Max, running Windows 11 Pro ARM64 build 26100.9711
(the October 2026 update, KB5127648), with no TPM and a software Windows Hello PIN, and with
Edge 137.0.3296.68 and Chrome 158.0.8127.89. Anything not observed is marked `[unverified]`. The
stub that produced the observations is not in the repository; see
[What iteration 0 proved](#what-iteration-0-proved).

## Bottom line

- **It works.** A stub registered with Windows, appeared in Settings, was turned on with Windows
  Hello, and created and signed in with passkeys on webauthn.io in Edge and in Chrome, including
  when Windows had to start it. Both browsers listed its passkey in their autofill menus.
- **Passkeys only.** Windows has no system hook for passwords or one-time codes. The browser
  extension keeps doing those.
- **Identity comes from a sparse package, so the NSIS installer and Bramble's updater stay.** The
  plugin API refuses a process with no package identity. A sparse package gives an installed exe
  identity without repackaging the app; a full MSIX was weighed and declined (2026-11-26) because
  it hands updates and signing to Microsoft and breaks the uninstaller's hooks. See
  [Package identity](#package-identity).
- **It works unsigned, which is what ships first.** Bramble has no trusted Windows certificate yet.
  An unsigned identity package installs only with administrator rights and registers only for the
  account that installs it, so turning passkeys on costs one UAC prompt and is out of reach for
  standard accounts. Microsoft says unsigned packages are meant for testing. When a certificate
  arrives, the same design installs per user with no prompt; both routes were observed.
- **Only the plugin process has identity, never the app.** A small new sidecar,
  `bramble-passkeys.exe`, is what Windows starts. The app keeps running unpackaged, so its
  Windows Hello keys and registry entries work as they do today.
- **The plugin is a broker; the app signs.** The vault key and the private keys stay in the app.
  The plugin passes Windows' request to the app over a named pipe, and the app checks Windows'
  own signature on the request before it signs anything. When the app is closed, the plugin
  starts it and the user unlocks it.
- **No new dependency.** No released `windows` crate has the plugin API; a small hand-written
  binding plus `windows-core`, already in the tree, did it.
- **The macOS self-unlock blocker applies here too, and so does its decision.** Windows preselects
  Bramble for new passkeys, so the browser extension's Windows Hello unlock key would be saved into
  Bramble. See [Bramble answering its own unlock](#bramble-answering-its-own-unlock).
- **Floor:** Windows 11 24H2 or 25H2 with the September 2025 preview update (build 26100.6725 or
  26200.6725) or later.

## What the plugin API buys

All of it hangs off `IPluginAuthenticator`, a COM interface the plugin implements, and the
`WebAuthNPlugin*` functions in `webauthn.dll`
([webauthnplugin.h, pluginauthenticator.idl](https://github.com/microsoft/webauthn)).

| Capability | Entry point | Status |
|---|---|---|
| Listed in Settings, turned on by the user | `WebAuthNPluginAddAuthenticator2`; the user enables it, confirmed with Windows Hello | Observed |
| Passkey registration | `IPluginAuthenticator::MakeCredential` | Observed |
| Passkey sign-in | `IPluginAuthenticator::GetAssertion` | Observed |
| Autofill menus and routing | `WebAuthNPluginAuthenticatorAddCredentials` (metadata only) | Observed |
| Lock state hint | `IPluginAuthenticator::GetLockStatus` | Observed, advisory |
| User verification inside Windows' dialog | `WebAuthNPluginPerformUserVerification` | Observed |
| PRF and hmac-secret | Decoded for the plugin in `WEBAUTHN_CTAPCBOR_HMAC_SALT_EXTENSION` | Checked, `[unverified]` |
| Cancel | `IPluginAuthenticator::CancelOperation` | Never called in testing |

Requests are CTAP2 CBOR, the only request type the IDL defines. Each carries a signature by
Windows over the request bytes, made with a P-384 key the plugin receives when it registers.

**Minimum builds (checked):** the API arrived in the September 2025 preview update, builds
26100.6725 and 26200.6725 ([KB5065789](https://support.microsoft.com/help/5065789)), and became
generally available with the November 2025 security update
([KB5068861](https://support.microsoft.com/help/5068861),
[announcement](https://techcommunity.microsoft.com/blog/windows-itpro-blog/windows-11-expands-passkey-manager-support/4467572)).
The "2" versions of the functions need 26100.8524 ([KB5089573](https://support.microsoft.com/help/5089573)).
Observed: build 26100.4349 reports WebAuthn API version 7 and has none of the plugin functions;
26100.9711 reports version 9 and has all of them.

## Where it answers

- **Edge and Chrome (observed).** Create, sign-in and autofill all reach the plugin. Windows shows
  its own sheet first ("Save your passkey", "This will be saved to Bramble", with a **Change**
  link), and the plugin's Windows Hello prompt appears inside that sheet. Chrome 158 labels the
  autofill entry "Passkey • Bramble"; Edge 137 says "Passkey from Windows Hello".
- **Firefox.** It uses Windows' WebAuthn API on Windows, so it should reach the plugin the same
  way. `[unverified]`
- **Native apps.** Any app calling Windows' WebAuthn API should reach it. `[unverified]`
- **Current Edge.** The test machine's Edge would not update past 137. `[unverified]`

## Passwords and one-time codes

Windows 11 gives third parties no system-wide way to fill passwords or one-time codes, so this
plan does not try. The plugin API is passkeys only: its single request type is "CBOR encoded
CTAP2 message" and its interface has `MakeCredential` and `GetAssertion` and nothing else
([pluginauthenticator.idl](https://github.com/microsoft/webauthn)), and Microsoft's page for it
calls it "a plugin model for passkeys"
([Plugin passkey manager support](https://learn.microsoft.com/en-us/windows/apps/develop/security/third-party),
ms.date 2025-09-29). Windows' other credential plugin point, the credential provider, serves
Winlogon, the sign-in screen and the credential dialog, not fields in apps or web pages
([Credential providers in Windows](https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows),
ms.date 2025-07-09). Microsoft documents nothing like macOS AutoFill or Android's autofill
framework for Windows text fields, and each browser fills passwords from its own store. So on
Windows, password and code fill stays with the browser extension.

## Package identity

### Identity is required

Observed: `WebAuthNPluginAddAuthenticator` called from a plain exe fails with `0x80073D54` ("The
process has no package identity"). Microsoft's page and sample
assume a packaged app and say nothing about identity otherwise; the sample is a full MSIX
([PasskeyManager](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/PasskeyManager)).

### A sparse package, not a full MSIX

A sparse package (Microsoft also calls it "packaged with external location") is a tiny `.msix`
holding only a manifest. The installer registers it against the folder it installed the app to
(`Add-AppxPackage -Path <msix> -ExternalLocation <folder>`), and the manifest names the exe in that
folder that runs with the package's identity. Microsoft documents this for apps that keep their
own installer ([Grant identity to non-packaged apps](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps),
and the `winapp` CLI's [sparse guide](https://github.com/microsoft/winappCli/blob/main/docs/guides/sparse.md),
which includes an NSIS snippet). Microsoft's own PowerToys ships a COM exe server this way
([AppxManifest.xml](https://github.com/microsoft/PowerToys/blob/main/src/PackageIdentity/AppxManifest.xml)).

The manifest declares `uap10:AllowExternalContent`, an application with
`uap10:TrustLevel="mediumIL"` and `uap10:RuntimeBehavior="win32App"`, and a `com:ExeServer` for
the plugin's class. Observed with that manifest: Windows starts the exe with `-Embedding` and the
package's identity whenever it needs the plugin, including when nothing of Bramble's is running,
and removing the package unregisters the plugin and drops its credential metadata.

**Why not a full MSIX (decided 2026-11-26).** The Microsoft Store signs an MSIX for free, which
was the attraction. Against it:

- Tauri's bundler builds only MSI and NSIS ([tauri#4818](https://github.com/tauri-apps/tauri/issues/4818),
  open since 2022), and its updater only runs an `.exe` or `.msi` installer. Outside tools can wrap
  a Tauri exe, but updates would then come from Microsoft, not from Bramble's own signed updater.
- The Store always re-signs an MSIX with Microsoft's certificate; there is no way to supply our own.
- The uninstaller's hooks, including the prompt that deletes stored credentials
  (`clients/desktop/src-tauri/windows/hooks.nsh`), have no MSIX equivalent.

A sparse package costs one extra install step and keeps everything else.

### Signed later, unsigned now

The identity package must be signed by a certificate Windows trusts, with a subject equal to the
manifest's `Publisher`. Bramble has none yet (`SIGNPATH_SIGNING_POLICY_SLUG` is `test-signing`;
the Azure setup `docs/release-signing.md` describes was never created). Windows 11 accepts an unsigned
package whose `Publisher` carries a special OID, installed with `Add-AppxPackage -AllowUnsigned`
([Create an unsigned MSIX package](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package),
ms.date 2026-07-02). Microsoft's own words: "Don't use this feature to distribute your app widely."
Both routes were observed with Developer Mode off:

| | Unsigned (now) | Signed (when a certificate arrives) |
|---|---|---|
| Install as a normal user | Refused, `0x80073D2B`: "an unsigned package cannot include Executable activations" | Works |
| Install elevated in the user's own session | Works, for that user only | Not needed |
| Install elevated as another admin | Registers for that admin, not the user | Not needed |
| Register an already staged copy as a normal user | Refused, `0x80073CF9` | Not needed |
| Remove as a normal user | Works | Works |
| `<msix>` element in the exe's manifest | Breaks the exe: Windows will not start it ("The msix publisher must be valid according to MSIX packaging rules", SideBySide event 87) | Works |
| Identity when Windows starts the plugin | Yes | Yes |
| Settings, sign-in, cold start | Work | Work |
| Create | Works | Not repeated; worked with the same manifest registered in Developer Mode |

The signed column used a test certificate trusted on that machine, standing in for a real one.
Elevating from a scheduled task failed (`0x80070005`, "Failed to initialize PLM"), so the
elevation has to happen in the user's desktop session, which is what a UAC prompt does.

Consequences for the design:

1. **Identity only through COM.** Since the unsigned route cannot put identity in the exe's
   manifest, nothing relies on it in either route. The plugin process gets identity because
   Windows starts it through the package. Anything else needing identity (registering, publishing
   metadata) runs in that process; the app asks for it by creating an instance of the plugin's COM
   class, which makes Windows start the plugin. Observed: an unpackaged PowerShell creating the
   class started the plugin with identity, and that process registered it.
2. **Passkeys are opt-in in Bramble's Settings on the unsigned build.** Turning them on asks UAC
   once to register the identity package. Installs and updates stay free of prompts, and the
   identity package only changes when its manifest does, so updates rarely need registering again.
3. **Standard accounts cannot use the unsigned build's passkeys.** Registering needs the user's own
   elevated session. The signed build removes this.
4. **A different plugin class ID per identity.** Observed: a class ID stays registered with Windows
   while its package is installed for any account (`0x8009000F`, "Object already exists", for a
   second package using it), so the signed and unsigned identities must not share one.
5. **The app never gains identity.** Its Windows Hello keys are named per vault through
   `KeyCredentialManager` (`clients/desktop/src-tauri/src/biometric_windows.rs`), and whether those
   keys are scoped by package identity is `[unverified]`. Keeping the app unpackaged means existing
   Windows Hello unlocks cannot be affected.

### Building and shipping the identity package

- **Tooling.** The release build runs on `ubuntu-24.04-arm` and NSIS packs files there
  (`.github/workflows/sign-windows.yml`), so the `.msix` must exist before NSIS runs. An unsigned,
  manifest-only `.msix` is a zip with three entries (the manifest, a block map and a content-types
  file), small enough to write deterministically with Node's own `zlib` and `crypto`. Observed: a
  manifest-only package installs and works; the logos are read from the install folder.
  `makeappx`, from the Windows SDK build tools, builds the same package for comparison.
- **Signing order, later.** A signed identity package must be signed before NSIS packs it, which
  means signing it in its own round trip, or signing it once and keeping it until its manifest
  changes.
- **Reproducible builds.** The unsigned package is deterministic by construction, so it is
  compared like any other file. A signed one would be compared with its signature entry removed.
- **winget.** Unchanged; it would install the NSIS installer.

## Rust access

No released `windows` crate has the plugin API. Checked: `windows` 0.62.2 (2025-10-06, the
version the app already uses per `clients/desktop/src-tauri/Cargo.lock`) covers `webauthn.h` up
to API version 7. windows-rs added the plugin functions with metadata 10.0.26100.7705 in commit
`95dfa93` (2026-03-23), but nothing has been published since, and the next release may drop the
large crate ([windows-rs#4867](https://github.com/microsoft/windows-rs/issues/4867)).

What worked (observed), with no new dependency and no C++:

- About 18 functions looked up at run time from `webauthn.dll` (loaded from System32 only), the
  way the sample's `DelayLoad.h` does, so the binary still starts on older builds and can say
  the feature is unavailable.
- `#[repr(C)]` structs copied from `webauthnplugin.h`, `webauthn.h` and `pluginauthenticator.idl`.
- The COM interface declared with `windows-core`'s `#[interface]` and implemented with
  `#[implement]`, plus a class factory registered with `CoRegisterClassObject`.
- A CTAP2 codec in Rust on `ciborium`, which the desktop already locks. Its create response
  matched Windows' own encoder byte for byte. For sign-in, Windows' encoder adds the user's name
  and display name; Bramble's should too.
- The request signature (ECDSA P-384 over the SHA-256 of the request) and the user verification
  signature (RSA-PSS with SHA-256 over the request) both verified with NCrypt.
- The core's `passkey_make_credential` and `passkey_get_assertion`
  (`packages/core-rust/src/lib.rs`, the `native` feature) signed unchanged.

## Process model

**A sidecar, not the app.** Windows starts `bramble-passkeys.exe -Embedding` from the install
folder. It is a separate binary for the reason the browser proxy is one
(`clients/desktop/src-tauri/src/bin/proxy.rs`): it must not link Tauri or start a webview, and it
must not take the app's single-instance lock. It serves the COM class, idles out after a few
minutes, and holds nothing secret.

**The app signs.** The plugin forwards each request to the running app over a named pipe beside
the browser link's (`ipc::Listener::bind_named`, whose DACL admits the current user only,
`clients/desktop/src-tauri/src/ipc.rs`). The app:

1. verifies Windows' signature over the request with the operation-signing key it pinned when the
   plugin registered, and refuses anything that fails;
2. if it is locked, shows its unlock window and waits; if the user unlocks, it carries on;
3. for a sign-in, reads the passkey from the vault's AutoFill copy, which is encrypted under the
   vault key it already holds, signs with the core, and returns the CTAP2 response;
4. for a create, makes the key with the core and hands it to the window through the
   pending-passkey handoff macOS already uses, so it lands in the vault like any other passkey.

This follows the app's unlock by construction: an unlocked app answers, a locked one asks. The
vault key never leaves the app, keeping the desktop's promise that it lives only in the app's
memory, which a plugin-side unlock with its own copy (the macOS shape) would not.

**When the app is closed**, the plugin starts it and waits for the pipe. The plugin's identity must
not pass to the app, so it starts the app outside its package (process creation breaks away from
the package); whether a child inherits it by default is `[unverified]` and is checked first in
iteration 1. How long Windows waits for an answer is `[unverified]`; a sign-in waited 50 seconds
for the PIN without trouble.

**Checking the other end of the pipe.** On macOS each end checks the other's code signature. Here:

- The app accepts a client only if the client process has the plugin's package family name and its
  image is `bramble-passkeys.exe` in the install folder.
- The plugin accepts a server only if its image is `bramble-desktop.exe` in the install folder.
- Signed builds add an Authenticode check of the other end's image, with the signer's subject
  compared to ours.
- Above all of that, the app signs only what Windows signed. A process faking the plugin cannot
  get a signature for a request Windows never made, because it cannot produce Windows' signature.

The unsigned build's checks are weaker than macOS's against software running as the same user,
which could replace files in the per-user install folder anyway. The request signature is what
keeps a rogue caller from using the app as a signing oracle.

## User verification and what each side shows

- **Windows shows:** its sheet for create ("Save your passkey"), for sign-in ("Sign in with a
  passkey", with the account and Bramble's name), and the browser's autofill list. Observed.
- **The plugin may show:** its own window, parented to the `hWnd` Windows passes in the request.
  Bramble's plan shows nothing of its own when the app is unlocked, and the app's unlock window
  when it is locked.
- **User verification.** When the request asks for it, the plugin calls
  `WebAuthNPluginPerformUserVerification`, which shows Windows Hello inside Windows' sheet
  (observed), and the app checks Windows' RSA signature over the request before setting the UV flag.
  If the user just unlocked Bramble with Windows Hello or the master password for this request,
  that counts as verification and no second prompt is shown.
- **Cancel.** Observed: a cancelled Hello prompt reaches the plugin only as `NTE_USER_CANCELLED`
  from the verification call; Windows did not call `CancelOperation`. The stub then signed without
  verification and webauthn.io accepted it. Bramble must return the cancellation and sign nothing.
- **Lock status is a hint.** Observed: Windows calls `GetLockStatus` before `GetAssertion`, but
  still sends the request when the plugin says it is locked. The app enforces its own lock.
- **Windows Hello unlock is separate.** The app's own Windows Hello unlock
  (`clients/desktop/src-tauri/src/biometric_windows.rs`) uses a per-vault `KeyCredentialManager`
  key, not a passkey, so no plugin and no sheet are involved, and nothing here changes it.

## Operations

| Operation | How | Status |
|---|---|---|
| Register | The app creates an instance of the plugin's class; the plugin calls `AddAuthenticator2` if Windows does not know it, and returns the operation-signing key to the app over the pipe | Observed (registration from a COM-started process) |
| Turn on | The user, in Settings, with Windows Hello. Bramble links there: `ms-settings:savedpasskeys` opens the Passkeys page, one click from the switch (once, a freshly started Settings opened on Home instead) | Observed |
| Sign-in | `GetAssertion`, signed by the app | Observed |
| Create | `MakeCredential`, signed by the app, handed to the window | Observed |
| Autofill list and routing | The app publishes each vault's passkey metadata through the plugin | Observed |
| Unregister | Removing the identity package | Observed |

**Metadata is not optional.** Observed: with the plugin registered and enabled but no metadata
published, Chrome said "No passkeys available" for a sign-in that named the credential. Windows
offers the plugin only for credentials it was told about, as macOS does. The metadata is the
credential ID, relying party, user ID, user name and display name; never a key. It comes from the
same `passkeyIdentities` the macOS store gets (`packages/core/src/vault/provider-mirror.ts`).

**Reused unchanged:** vault entries and their passkey fields; the core's passkey functions; the
AutoFill copy's format and writer (`write_mirror` in
`clients/desktop/src-tauri/src/autofill_provider.rs`), written to the app's data folder instead of
an App Group; and the pending-passkey handoff (`clients/desktop/src/adapters/pending-passkeys.ts`).
On Windows the copy carries passkeys only, since password fill does not use it.

**New on disk:** one small file in the app's data folder holding the pinned operation-signing
public key and the plugin's class ID, with a version field. No stored format changes.

**Several vaults.** Metadata is published for every vault with a copy, as macOS lists every vault.
The app can sign only for the vault it has open, so a request for another vault's passkey brings
Bramble forward asking to open that vault. `[unverified]` on how Windows presents the wait.

## Security invariants

Mirroring macOS, each enforced in the app, not in the plugin:

1. The vault key and private keys never leave the app; the plugin sees requests and responses only.
2. The app signs only requests carrying a valid Windows signature from the pinned key.
3. A locked app answers nothing until the user unlocks it, whatever `GetLockStatus` said.
4. The UV flag is set only after verification succeeded for this request; a cancelled verification
   cancels the operation.
5. Each end of the pipe checks the other, as strongly as the build allows (above).
6. A new passkey is sealed under the open vault's key before it leaves the pipe server, as the
   macOS handoff is.
7. The `bramble.sh` rule below.

### Bramble answering its own unlock

The macOS analysis applies unchanged in substance
([Blocker](macos-credential-provider.md#blocker-bramble-answering-its-own-unlock)). The browser
extension's Windows Hello unlock is a platform passkey for `bramble.sh`
(`packages/core/src/vault/webauthn-ceremony.ts`). Observed: with Bramble enabled, Windows
preselected it for every passkey created in testing. So setting up that unlock would save the key into Bramble,
and importing it from elsewhere could bring it in too.

Decision: adopt the macOS decision. The key becomes the hidden, local-only `unlock-key` entry,
served only by the desktop providers (the macOS extension and this plugin), with the `BRMU`
credential ID prefix and the master-password guard. One difference: on Windows the app signs, so
unlocking the browser extension through Bramble needs Bramble Desktop unlocked, or unlocked on the
spot with Windows Hello. The help article that tells Windows users to pick Windows Hello for that
key changes accordingly.

## What is reused as-is

- **Signing:** the core's passkey functions, unchanged (observed).
- **The copy and the handoff:** `autofill_provider.rs`'s copy writer, the `Mirror` format and the
  pending-passkey drain, built for macOS.
- **The request model:** `autofill_session.rs`'s shape (a snapshot of the app, a pure `answer`
  function, a `serve` that checks the caller before reading), tested the same way.
- **The pipe:** `ipc.rs`'s owner-only named pipe.
- **The early argument check:** the plugin is a sidecar, but the app's `--purge-secrets` path in
  `clients/desktop/src-tauri/src/main.rs` is the precedent for code that must run without Tauri.
- **The unlock-key decision**, built for macOS.

## What iteration 0 proved

A stub (`bramble-passkey-stub.exe`, Rust, about 1,200 lines, built on the Mac with `cargo xwin` for
ARM64) was registered from a sparse package and used on webauthn.io. Everything below was observed
on the machine described at the top.

- **Registration and Settings.** `AddAuthenticator2` returned `S_OK` from a process with identity;
  the plugin appeared under Passkey managers, off, and turning it on asked for Windows Hello.
  Turning it on also switched "Save passkeys to this Windows device" off.
- **COM activation.** Windows started the exe with `--com -Embedding` (our argument, then COM's)
  and the package's identity, both while it was running and from cold.
- **Create and sign-in, Edge 137 and Chrome 158.** Windows' sheet preselected the plugin; the
  plugin's Windows Hello prompt appeared in the sheet; webauthn.io reported success both ways.
  Every request's Windows signature verified, and so did every user verification signature. The
  verification count Windows reports went up by one each time.
- **Autofill.** Both browsers listed the passkey. Settings' own "Saved passkeys" list never shows
  plugin passkeys.
- **Locked and cancelled.** `GetLockStatus` answering locked did not stop `GetAssertion`. A
  cancelled Hello prompt came back only as `NTE_USER_CANCELLED`.
- **Removal.** Removing the package removed the plugin from Settings and its metadata.
- **Identity routes,** in the table above: unsigned and signed, with Developer Mode off.
- **One stub artifact, not a finding:** the stub was a console program, and its console window
  covered the Hello prompt on a cold start. `bramble-passkeys.exe` is a windows-subsystem binary.

`[unverified]` after iteration 0: an x64 machine (the shipped app is x86_64; the observations are
ARM64), a real certificate, the real installer and updater, current Edge, Firefox, native apps,
PRF, several passkeys for one site, how long Windows waits, and the plugin starting the app.

## Iterations

### Iteration 0: prove it (done 2026-11-26)

No user capability. See above.

### Iteration 1: passkeys on the unsigned GitHub build

**In Bramble's Settings, the user can** turn on "Use Bramble for passkeys in Windows", approve
one UAC prompt, and follow a link to the Windows page where they switch Bramble on.

**In Edge, Chrome and other apps using Windows' passkeys, the user can:**

- Sign in with any passkey in the vault Bramble has open.
- Create a passkey and have it land in the vault and sync to their other devices.
- Pick their passkey from the browser's autofill menu.
- Unlock Bramble when asked, with Windows Hello or the master password, and carry on.

**The user still cannot:** fill passwords or codes this way (the extension does), use it from a
standard account, or use it with Bramble locked without unlocking.

### Iteration 2: the signed identity

When the SignPath Foundation certificate (or another) is in place: sign the identity package,
install it per user in the NSIS installer with no prompt, use the signed identity's own class ID,
and move existing users from the unsigned identity to the signed one.

### Iteration 3: leftovers with real data

PRF if it is not in iteration 1, signing for a vault other than the open one, and anything Firefox
or native apps turn up.

## Open questions

- Whether `KeyCredentialManager` keys are scoped by package identity. Moot while the app stays
  unpackaged; matters if that ever changes.
- Whether `WebAuthNPluginAuthenticatorAddCredentials` works from a process without identity. If it
  does, the app can publish metadata itself instead of through the plugin.
- How Windows presents an error or a long wait from the plugin.
- Whether the Microsoft Store should list the signed NSIS installer once a certificate exists
  (an EXE listing keeps Bramble's signature and updater).
