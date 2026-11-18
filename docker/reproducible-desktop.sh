#!/usr/bin/env bash
# The desktop Linux half of scripts/verify-release.ts, run in the tag's own
# clients/desktop/docker/linux-build.Dockerfile (docs/reproducible-builds.md).
#
#   build                     /src (the tag, read-only) -> /out, the way build-linux.ts builds a
#                             release; SOURCE_DATE_EPOCH comes from the caller
#   manifest <dir> <name>=<kind>:<file>[:<offset>]...
#                             one line per file inside each .deb, AppImage or .rpm: hash, mode,
#                             path (a link's target in place of its hash), so two packages can be
#                             compared by what they install even where their bytes differ
set -euo pipefail

case "${1:-}" in
build)
	mkdir -p /work/repo
	rsync -a --delete --exclude .git --exclude node_modules --exclude target --exclude dist \
		--exclude dist-chromium --exclude dist-firefox --exclude dist-linux /src/ /work/repo/
	cd /work/repo
	corepack pnpm install --frozen-lockfile
	# The bundler will not emit updater artifacts unsigned. The signature is a separate .sig file,
	# so a throwaway key changes nothing that is compared.
	corepack pnpm --filter @vault/platform-desktop exec tauri signer generate -w /tmp/k -p "" >/dev/null
	TAURI_SIGNING_PRIVATE_KEY="$(cat /tmp/k)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
		corepack pnpm run build:macos
	rm -rf /out/bundle
	mkdir -p /out/bundle
	cp -a clients/desktop/src-tauri/target/release/bundle/{deb,appimage,rpm} /out/bundle/
	;;
manifest)
	# manifest <dir> <name>=<kind>:<file>[:<appimage offset>]... writes <dir>/<name>.txt for each.
	dir=$2
	shift 2
	if ! command -v unsquashfs >/dev/null || ! command -v rpm2cpio >/dev/null; then
		apt-get update -qq >/dev/null
		apt-get install -y -qq --no-install-recommends squashfs-tools rpm2cpio rpm cpio >/dev/null
	fi
	for spec in "$@"; do
		name=${spec%%=*} rest=${spec#*=}
		kind=${rest%%:*} rest=${rest#*:}
		file=${rest%%:*} offset=${rest#*:}
		root=$(mktemp -d)
		{
			case "$kind" in
			deb)
				dpkg-deb --raw-extract "$file" "$root"
				# What a package says, not how it was packed: Installed-Size and the order of
				# md5sums followed the build host's file system before deb-reproducible.ts.
				sed -i '/^Installed-Size:/d' "$root/DEBIAN/control"
				[ ! -f "$root/DEBIAN/md5sums" ] ||
					LC_ALL=C sort -k2 -o "$root/DEBIAN/md5sums" "$root/DEBIAN/md5sums" ;;
			appimage)
				unsquashfs -q -no-xattrs -f -d "$root/x" -o "$offset" "$file" >/dev/null
				root="$root/x" ;;
			rpm)
				# rpm2cpio exits 1 over a signature it has no key for (the release's are GPG-signed)
				# while writing the payload out whole; cpio is what checks the archive.
				rpm2cpio "$file" > "$root.cpio" 2>/dev/null || true
				(cd "$root" && cpio -idm --quiet --no-absolute-filenames < "$root.cpio")
				rm -f "$root.cpio"
				rpm -qp --qf '%{NAME} %{VERSION} %{RELEASE} %{ARCH}\n[requires %{REQUIRENAME} %{REQUIREVERSION}\n][provides %{PROVIDENAME}\n]' "$file" 2>/dev/null |
					sed 's/^/header /' ;;
			esac
			cd "$root"
			find . -mindepth 1 \( -type f -o -type l \) -print0 | LC_ALL=C sort -z |
				while IFS= read -r -d '' path; do
					mode=$(stat -c %a "$path")
					if [ -L "$path" ]; then echo "link:$(readlink "$path") $mode ${path#./}"
					else echo "$(sha256sum < "$path" | cut -c1-64) $mode ${path#./}"; fi
				done
			cd /
		} > "$dir/$name.txt"
		rm -rf "$root"
	done
	;;
*)
	echo "usage: $0 build | manifest <dir> <name>=<kind>:<file>[:<offset>]..." >&2
	exit 2 ;;
esac
