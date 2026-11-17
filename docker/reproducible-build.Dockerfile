# syntax=docker/dockerfile:1
#
# The environment for rebuilding a browser-extension release and checking it byte for byte against
# what was published (scripts/verify-release.ts, docs/reproducible-builds.md).
#
# It reproduces the release runner (ubuntu-24.04, x86_64), not this Mac. The JavaScript comes out
# the same on any host, but the WASM does not: Cargo's crate hashes take in the host the proc-macros
# were built for, and those hashes decide the order of the WASM's data. So build it as
# --platform linux/amd64 (the script does), whatever the machine. On Apple silicon that runs under
# emulation, and the Rust build takes a minute or two longer.
#
# Every tool that shapes the output is pinned: the Rust toolchain and std by the image digest,
# wasm-pack by version and checksum (it fetches the wasm-bindgen that Cargo.lock names, as on the
# runner), Node by version and checksum, and pnpm by packageManager in package.json.

FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082

ENV DEBIAN_FRONTEND=noninteractive

# zip: the bundle scripts package with it. Nothing installed here reaches the output.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      xz-utils \
      zip \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz \
    && corepack enable

ARG WASM_PACK_VERSION=0.13.1
ARG WASM_PACK_SHA256=c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539
RUN curl -fsSLo /tmp/wasm-pack.tar.gz "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    && echo "${WASM_PACK_SHA256}  /tmp/wasm-pack.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/wasm-pack.tar.gz -C /usr/local/bin --strip-components=1 "wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack" \
    && rm /tmp/wasm-pack.tar.gz

# What rust-toolchain.toml asks for, installed now so a build never downloads it. No rust-src: the
# runner has none, and scripts/rustflags-reproducible.sh expects std paths in that form.
RUN rustup component add rustfmt clippy && rustup target add wasm32-unknown-unknown

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
