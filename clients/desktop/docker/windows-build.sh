#!/usr/bin/env bash
# The Windows installer, built in windows-build.Dockerfile by `build-windows.ts --container`: /src is
# the repository (read-only), /work the build, /out where the installer lands (its own signature
# still to come), and SOURCE_DATE_EPOCH the commit's time. See docs/reproducible-builds.md.
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

# The files inside the installer are signed on a Windows runner between builds, so Tauri's sign
# command hands them across instead (scripts/windows-sign-handoff.ts). /signed holds signed copies
# from an earlier round, or a published installer to take them out of; BRAMBLE_SIGN_COLLECT=1 puts
# what still needs signing in /out/to-sign.
sign=()
if [ -d /signed ]; then
	rm -rf /work/signed
	cp -r /signed /work/signed
	# The uninstaller inside is an NSIS archive too, with plugins of its own.
	for installer in /work/signed/*-setup.exe; do
		[ -e "$installer" ] || continue
		7z x -bso0 -bsp0 -o"$installer.files" "$installer"
		7z x -bso0 -bsp0 -o"$installer.files/uninstaller" "$installer.files/uninstall.exe"
	done
	export BRAMBLE_SIGN_SIGNED=/work/signed
fi
if [ "${BRAMBLE_SIGN_COLLECT:-}" = 1 ]; then
	rm -rf /out/to-sign
	export BRAMBLE_SIGN_COLLECT=/out/to-sign
fi
if [ -n "${BRAMBLE_SIGN_SIGNED:-}${BRAMBLE_SIGN_COLLECT:-}${BRAMBLE_SIGN_LENIENT:-}" ]; then
	sign=(--config '{"bundle":{"windows":{"signCommand":{"cmd":"node","args":["/work/repo/scripts/windows-sign-handoff.ts","%1"]}}}}')
	# Tauri signs only the NSIS plugins on its own list, and the uninstaller packs LangDLL besides.
	# So every plugin goes through the handoff here, in the copy of NSIS that Tauri packs from.
	rm -rf /work/nsis
	cp -r /usr/share/nsis /work/nsis
	for dll in /work/nsis/Plugins/x86-unicode/*.dll; do node scripts/windows-sign-handoff.ts "$dll"; done
	export NSIS_PATH=/work/nsis
fi

# The bundler will not emit updater artifacts without a key. Its .sig is over the unsigned bytes
# and thrown away: the real one is made over the Authenticode-signed installer (build-windows.ts).
corepack pnpm --filter @vault/platform-desktop exec tauri signer generate -w /tmp/k -p "" >/dev/null
TAURI_SIGNING_PRIVATE_KEY="$(cat /tmp/k)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
	BRAMBLE_TARGET=x86_64-pc-windows-msvc \
	corepack pnpm --filter @vault/platform-desktop exec tauri build --runner cargo-xwin \
	--target x86_64-pc-windows-msvc --bundles nsis "${sign[@]}"

rm -f /out/*-setup.exe
cp clients/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe /out/
