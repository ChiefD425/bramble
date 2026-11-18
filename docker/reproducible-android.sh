#!/usr/bin/env bash
# Rebuilds an Android release the way android-release.yml's build job does, inside the base image
# of docker/reproducible-build.Dockerfile run as linux/amd64 (scripts/verify-release.ts drives it;
# docs/reproducible-builds.md says why the platform matters).
#
# Mounts: /src the tag's tree (read-only), /cache the tools and package caches (kept between runs),
# /work the build, /out where the unsigned apk lands. The SDK and NDK are large, so they live in
# /cache rather than in an image. Every tool is pinned: the JDK, Node and wasm-pack by checksum,
# cargo-ndk by version with --locked, and the SDK packages by version through sdkmanager, which
# checks Google's own hashes.
set -euo pipefail

T=/cache/tools
mkdir -p "$T"
export CARGO_HOME=/cache/cargo-home GRADLE_USER_HOME=/cache/gradle-home
export PATH="$CARGO_HOME/bin:/usr/local/cargo/bin:$PATH"

apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends curl ca-certificates unzip xz-utils >/dev/null

fetch() { # url, file, sha256
	[ -s "$T/$2" ] || curl -fsSLo "$T/$2" "$1"
	echo "$3  $T/$2" | sha256sum -c - >/dev/null
}
# Temurin 21, as the runner's JAVA_HOME_21_X64.
fetch https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz \
	jdk.tgz d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c
fetch https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
	node.txz fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
fetch https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz \
	wasm-pack.tgz c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539
fetch https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
	clt.zip 7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee
[ -d "$T/jdk" ] || { mkdir "$T/jdk" && tar -xzf "$T/jdk.tgz" -C "$T/jdk" --strip-components=1; }
[ -d "$T/node" ] || { mkdir "$T/node" && tar -xJf "$T/node.txz" -C "$T/node" --strip-components=1 --no-same-owner; }
[ -x "$T/wasm-pack" ] || tar -xzf "$T/wasm-pack.tgz" -C "$T" --strip-components=1 \
	wasm-pack-v0.13.1-x86_64-unknown-linux-musl/wasm-pack
export JAVA_HOME="$T/jdk" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
export PATH="$T/node/bin:$T:$JAVA_HOME/bin:$PATH"
corepack enable --install-directory "$T"

# The NDK android-release.yml names (NDK_VERSION), and the platform build.gradle compiles against.
export ANDROID_HOME="$T/sdk" ANDROID_SDK_ROOT="$T/sdk"
if [ ! -d "$ANDROID_HOME/cmdline-tools/latest" ]; then
	mkdir -p "$ANDROID_HOME/cmdline-tools"
	unzip -q "$T/clt.zip" -d "$ANDROID_HOME/cmdline-tools"
	mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install \
	"platforms;android-36" "ndk;27.3.13750724" "platform-tools" >/dev/null
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"

command -v cargo-ndk >/dev/null || cargo install cargo-ndk --version 4.1.2 --locked -q
rustup target add wasm32-unknown-unknown aarch64-linux-android armv7-linux-androideabi \
	x86_64-linux-android i686-linux-android >/dev/null

rm -rf /work/src && cp -a /src /work/src && cd /work/src
pnpm install --frozen-lockfile >/dev/null
# buildAndroidUnsigned in scripts/release.ts.
pnpm run core:build
pnpm run ffi:build:android
pnpm --filter @vault/platform-mobile exec cap sync android
# Two workers, Kotlin in-process, no file watching: under x86_64 emulation on Apple silicon, aapt2
# daemons started side by side by many workers hung at startup, and Gradle waited on them for good.
# None of this changes what is built.
clients/mobile/android/gradlew -p clients/mobile/android assembleRelease \
	"-Porg.gradle.java.installations.paths=$JAVA_HOME" --no-daemon --no-watch-fs --max-workers=2 \
	-Pkotlin.compiler.execution.strategy=in-process
cp clients/mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk /out/
# The container runs as root, so on a Linux host everything it wrote is root's: clear the build,
# and hand the rest back to whoever ran the check (HOST_OWNER, from verify-release.ts).
cd / && rm -rf /work/src
[ -z "${HOST_OWNER:-}" ] || chown -R "$HOST_OWNER" /out /cache /work
