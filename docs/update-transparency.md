# Update transparency

The desktop app installs an update only if that exact build is in a public, append-only log that
independent witnesses cosign. So Bramble cannot quietly give one person a different build from
everyone else: every build an installed app will accept is a build anyone can see, and monitors
check every logged build against the published releases.

## The threat

The updater signature (docs/release-signing.md) proves Bramble released a build. It says nothing
about whether everyone received the same one. Whoever holds the updater key can sign a build that
leaks one person's vault, and serve it to that person alone: the manifest the app fetches,
`https://bramble.sh/desktop/latest.json`, is ours to answer differently per request. That person
could be anyone the key holder is pressured, compromised or legally compelled to target, and a
legal order can come with a ban on saying it exists.

Signatures cannot rule that out, because the key holder is the one doing it. Transparency can: if
the app requires every build it installs to be public, a targeted build has to be published to the
world to work, and secrecy, which is the point of targeting, is gone.

## How it works

**At release** (`scripts/sigsum-log.ts`, from `release.ts` on both routes). After every updater
signature verifies, and before anything is public, each updater artifact (the macOS
`.app.tar.gz`, the AppImages, the Windows installer) is logged with `sigsum-submit`:

- its SHA-256 is signed with Bramble's Sigsum key and added to a [Sigsum](https://www.sigsum.org)
  log;
- the log's tree head is cosigned by witnesses, and `sigsum-submit` waits until the policy's quorum
  has, then writes a proof beside the artifact (`<artifact>.proof`);
- `release-desktop.mjs --require-proofs` puts the proofs into `latest.json` under `sigsum_proofs`,
  keyed by each artifact's SHA-256, and refuses to write a manifest missing one;
- the `.proof` files are attached to the GitHub release.

A dry run signs the requests and logs nothing, since a build that is never released must never
appear in the log.

**In the app** (`clients/desktop/src-tauri/src/update_log.rs`, `updates.rs`). Installing is a Rust
command: check, download (the plugin verifies the updater signature), then verify the Sigsum proof
for the downloaded bytes, then install. The webview may only check (`capabilities/default.json`
grants `updater:allow-check` and nothing else of the plugin), so nothing reaches install without
the proof check. The proof is checked offline: the app contacts no log or witness, and nobody
learns that it updated. It must show:

- the artifact's checksum signed by one of the keys in `clients/desktop/src-tauri/sigsum-keys.txt`;
- included in a log tree whose head the log signed;
- that head cosigned by a quorum of witnesses.

A missing or failing proof refuses the update, and Settings shows why. There is no override.

**The policy** is `sigsum-generic-2025-1`, maintained by the Sigsum project and built into both the
`sigsum` crate (pinned in `Cargo.lock`) and `sigsum-submit`: two logs, Glasklar Teknik's `seasalp`
and Mullvad's `ginkgo`, and three witnesses (Glasklar, Mullvad, Tillitis) of which two must
cosign. A witness only cosigns a tree that extends the last one it saw, so a log cannot show the
app one history and the monitors another.

**The monitor** (`scripts/sigsum-monitor.ts`, daily in `.github/workflows/verify-releases.yml`)
reads every entry of both logs, checks each tree head against the log's key and the witness
quorum, recomputes the Merkle root from all the entries so none can be withheld, and requires every
entry signed with a Bramble key to match a file in some desktop release's `SHA256SUMS`. It keeps no
state and needs only network:

```sh
node scripts/sigsum-monitor.ts
```

## What it does and does not do

- **It detects; it does not prevent.** A targeted build can still be installed, but only after it
  is in the log for anyone to find. The protection is that this cannot be done in secret, and that
  a monitor run by anyone will flag it.
- **The monitor that matters most is someone else's.** Bramble's own scheduled check is the one an
  order could tell us to switch off. The script exists so that others can run it; a pinned public
  key list and a public log are all it needs.
- **It covers updates, not first installs.** A download from the website or GitHub is checked by
  nothing in the app. The `.proof` files on each release let anyone check an updater artifact by
  hand, for example
  `sigsum-verify -k signing.pub -P sigsum-generic-2025-1 Bramble.app.tar.gz.proof < Bramble.app.tar.gz`.
  Disk images and packages are covered by `SHA256SUMS` only.
- **It shows everyone got the same build, not that the build matches the source.** That is
  reproducibility's job, which the desktop app does not have yet (docs/reproducible-builds.md).
- **The extensions and the mobile apps are outside it.** Store-distributed builds go to everyone
  alike, since we cannot target one user through the Chrome Web Store, AMO, the App Store or a
  GitHub APK download, and the extensions are checked daily against their source instead.

**Testing an update locally.** `pnpm build:macos:local-update` builds with the `update-log-test`
feature: that build trusts Sigsum's test log and a throwaway key made for it
(`target/smoke-sigsum-key`), and `pnpm updater:smoke` logs the archive it serves there and puts the
proof in its manifest, so the whole path runs, proof check included. Anyone can log to the test log,
so such a build must never ship: `release-desktop.mjs` refuses any binary carrying the marker string
from `update_log.rs`, as it already refuses one built against the local endpoint, and the feature
does not compile without the key.

## Keys

| Key | Where | Purpose |
|-----|-------|---------|
| Signing key `79d10aca…` | `SIGSUM_SIGNING_KEY` in `desktop-release`; `~/.config/bramble/sigsum-signing-key.age` | Signs each release's leaves |
| Backup key `1a1d40ab…` | `~/.config/bramble/sigsum-backup-key.age` only | Pinned in the app too, so losing the signing key does not strand every install |
| Rate-limit key `7e511464…` | `SIGSUM_RATE_LIMIT_KEY` in `desktop-release`; `~/.config/bramble/sigsum-rate-limit-key.age` | Proves submissions come from bramble.sh; its public half is a DNS record |

The `.age` files are encrypted to the Touch ID identity (`age-plugin-se`), like the other release
secrets, and `pnpm run ci:secrets --only desktop-release` restores the two CI secrets from them.
Re-wrap all three to the YubiKey as well once it is to hand, and keep an offline passphrase copy of
the backup key as docs/release-signing.md describes for the others: the backup key is the one that
matters if everything else is lost.

**The public log's rate limit** is per domain. `sigsum-submit` signs a token with the rate-limit
key, and the log checks it against a DNS TXT record:

```
_sigsum_v1.bramble.sh.  TXT  "7e511464b1565311a63a4552639707a5e00a740afc59d154f8f09c66833a6924"
```

The production logs rate-limit by that record. If a log refuses a submission, the release stops
before publishing anything.

**Rotating a leaf key** means a release that pins the new key, logged with the old one. Losing both
the signing key and the backup means installed apps can never update again and must be reinstalled
by hand, which is why the backup exists and should not live only on this Mac.

**Rotating the rate-limit key** is cheap: make a new one, add its TXT record beside the old, update
the secret, then delete the old record.

## If the monitor fails

An unexplained entry is an entry signed with a Bramble key whose checksum is in no published
desktop release. In order:

1. A release logged its artifacts in the last half hour and has not published yet: the monitor
   waits 30 minutes and checks again, so this should clear on its own. A failed release that
   logged but never published leaves entries for good; say so publicly, naming the run.
2. Otherwise, assume the signing key has been used by someone other than the release workflow.
   Say so publicly, rotate it (above), and find out how.

## Setting it up from scratch

```sh
go install sigsum.org/sigsum-go/cmd/sigsum-key@v0.14.1
go install sigsum.org/sigsum-go/cmd/sigsum-submit@v0.14.1
sigsum-key generate -o signing && sigsum-key to-hex -k signing.pub
```

Then wrap the private key with `age` to the release recipients, `gh secret set` it into
`desktop-release`, put its hex into `sigsum-keys.txt`, and delete the plaintext. The same for the
rate-limit key, plus its DNS record. The test fixture in
`clients/desktop/src-tauri/fixtures/update-log/` shows the whole round trip against Sigsum's test
log.
