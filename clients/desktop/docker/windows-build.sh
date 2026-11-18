#!/usr/bin/env bash
# The Windows installer, built in windows-build.Dockerfile by `build-windows.ts --container`: /src is
# the repository (read-only), /work the build, /out where the unsigned installer lands, and
# SOURCE_DATE_EPOCH the commit's time. See docs/reproducible-builds.md.
set -euo pipefail

mkdir -p /work/repo
rsync -a --delete --exclude .git --exclude node_modules --exclude target --exclude dist \
	--exclude dist-chromium --exclude dist-firefox --exclude dist-linux /src/ /work/repo/
cd /work/repo
corepack pnpm install --frozen-lockfile

export XWIN_CACHE_DIR=/work/xwin-cache
# /Brepro: the PE timestamp and IDs from a hash of the output rather than the clock. /DEBUG:NONE: no
# PDB, whose identity carries rustc's randomly named temporary files into the binary; none ships.
export RUSTFLAGS="$(bash scripts/rustflags-reproducible.sh) -C link-arg=/Brepro -C link-arg=/DEBUG:NONE"

# The bundler will not emit updater artifacts without a key. Its .sig is over the unsigned bytes
# and thrown away: the real one is made over the Authenticode-signed installer (build-windows.ts).
corepack pnpm --filter @vault/platform-desktop exec tauri signer generate -w /tmp/k -p "" >/dev/null
TAURI_SIGNING_PRIVATE_KEY="$(cat /tmp/k)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
	BRAMBLE_TARGET=x86_64-pc-windows-msvc \
	corepack pnpm --filter @vault/platform-desktop exec tauri build --runner cargo-xwin \
	--target x86_64-pc-windows-msvc --bundles nsis

rm -f /out/*-setup.exe
cp clients/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe /out/
