# Reproducible builds

Anyone can rebuild a Bramble release from its tag and get the same bytes we published. That is
what makes the source the thing to audit: a build that matches it cannot hide anything the source
does not show, and a build that does not match is evidence that something was added.

| Target | Reproducible | Checked |
|--------|--------------|---------|
| Firefox extension | Yes, every file | Daily in CI: what addons.mozilla.org serves, and the GitHub zip |
| Chrome extension | Yes, every file | Daily in CI: what the Chrome Web Store serves, and the GitHub zip |
| Android APK | Yes, every file but the signature | Daily in CI: the newest GitHub release |
| Desktop app | Not yet | No; its updates are transparency-logged instead ([update-transparency.md](update-transparency.md)) |
| iOS app | Cannot be checked: the App Store re-encrypts every binary | No |

## Checking a release yourself

You need git, Node 24 and Docker. From a clone with its tags:

```sh
node scripts/verify-release.ts 1.37.0-firefox      # one release, by its tag
node scripts/verify-release.ts --live chromium     # whatever the store is serving right now
node scripts/verify-release.ts 1.40.0-chromium --no-store
node scripts/verify-release.ts --live android      # the newest Android release
```

It builds the tag in `docker/reproducible-build.Dockerfile` and compares every file with:

- **the GitHub release's zip**, after checking the zip against the release's `SHA256SUMS`;
- **the store's package**: the `.xpi` addons.mozilla.org hands to Firefox, checked against AMO's own
  hash, or the `.crx` the Chrome Web Store hands to Chrome. The Chrome Web Store only serves its
  current version, so an older Chrome release is compared with GitHub alone.

`.github/workflows/verify-releases.yml` runs `--live` for both stores and Android every day, so a
store serving something other than what the source builds would turn up within a day.

**Android** builds in the same base image with `docker/reproducible-android.sh`, which installs what
the release runner has: Temurin 21, the Android SDK platform 36 and NDK 27.3.13750724, cargo-ndk
4.1.2, Node and wasm-pack, each pinned. The SDK is large, so it and the package caches live in
`BRAMBLE_VERIFY_CACHE` (default `~/.cache/bramble-verify`, about 6 GB) rather than in an image. The
APK is compared entry by entry with the one on the GitHub release, after checking that against
`SHA256SUMS`. Releases are signed v2 and v3 only, and those signatures live in a block outside the
zip entries, so nothing is set aside: every entry must match, the four Rust libraries and the WASM
included. 0.31.0 did, all 542 entries (2026-11-17). Every package is read from the archive itself
rather than unpacked to disk: an APK's shrunk resource names differ only by case (`res/9n.9.png`
and `res/9N.9.png`), and a case-insensitive file system would merge them and compare fewer files
than there are. `--apk <file>` compares an APK you built some other way, natively on x86_64 Linux
for instance, without Docker.

Under emulation on Apple silicon, Gradle's aapt2 daemons sometimes hung at startup when many ran at
once, so the script runs Gradle with two workers and the Kotlin compiler in-process. Neither changes
the output; on an x86_64 machine it only makes the build slower.

## What the stores change

Each store adds its own signature, and that is all a package may differ by:

- **addons.mozilla.org** adds `META-INF/` (Mozilla's signature) and reformats `manifest.json`
  without changing what it says.
- **The Chrome Web Store** adds `_metadata/` (its hashes of every file, which Chrome checks) and an
  `update_url` key to `manifest.json`.

So `manifest.json` is compared as data with only `update_url` allowed to differ, those two folders
are ignored, and every other file must match byte for byte. The GitHub zip leaves out the
TypeScript declarations and `wasm/package.json` (the `zip -x` list in
`clients/extension/package.json`), which the store packages carry; those are compared too.

## Why the build runs as x86_64 Linux

The JavaScript, HTML and CSS come out identical on any machine. The WASM crypto core does not. Its
contents depend on the platform the build runs on, through two things found by rebuilding
1.37.0 on a Mac and on Linux (2026-11-17):

1. **The host platform.** Built on an Apple silicon Mac, on arm64 Linux and on x86_64 Linux, the
   same commit gives three different WASM files, each the same every time, and only x86_64 Linux,
   the release runner's platform, matches what shipped. The files hold the same strings in a
   different order, which points at symbol hashes: Cargo hashes the host into proc-macro and build
   script units, and those feed the hashes of the crates that use them. That cause is inferred, not
   traced; the platform dependence is measured.
2. **wasm-bindgen must be the prebuilt binary.** wasm-pack 0.13.1 (what CI pins) downloads the
   wasm-bindgen release binary for the version in `Cargo.lock`. Newer wasm-pack builds it from
   source without a lockfile, which picks up newer dependencies (walrus 0.26.2 against 0.26.1) and
   produces different bytes.

The paths rustc would otherwise embed are already normalised by `scripts/rustflags-reproducible.sh`
(which `wasm:build` uses), so where the repository is checked out does not matter.

So the image is pinned to the release runner's platform: `--platform linux/amd64`, the Rust 1.95.0
image by digest, wasm-pack 0.13.1 and Node by checksum, and pnpm by `packageManager`. On Apple
silicon Docker emulates it, which costs a few minutes.

## What could break it

- **A floating tool in the release workflow.** `firefox-release.yml` and `chrome-release.yml` take
  `node-version: 24`, not an exact version. The bundler's output has not depended on Node's minor
  version so far; if it ever does, the daily check fails and the two must be pinned together.
- **Bumping wasm-pack or the Rust toolchain** in CI without the same change to the Dockerfile.
  Change both in one commit; the next day's check proves the pair.
- **A build step that reads the clock or the machine.** None does today. The zip archives
  themselves are not byte-identical (zip stores file times), which is why the check compares their
  contents rather than the archive's hash.

## Desktop, next

Three platforms, each with its own signature: Apple's code signature and notarization ticket,
Authenticode, and the AppImage's own squashfs. Linux first, since it has no platform signature
inside the binary: the AppImage needs fixed file times (`SOURCE_DATE_EPOCH`) and a pinned
`mksquashfs`. Until then, desktop updates are covered by the transparency log, which shows that
every user got the same build even though nobody has yet shown that build matches the source.

Android's Rust libraries matched only because of the July 2026 work for F-Droid, which made the Rust
output independent of where the repository is checked out (`scripts/rustflags-reproducible.sh`) and
committed `Cargo.lock`. The desktop app links the same crate, so it starts from there.
