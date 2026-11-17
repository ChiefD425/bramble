# AMO source-code submission: building Bramble for Firefox

addons.mozilla.org requires the buildable source for any add-on whose shipped code is bundled or
compiled. Bramble is Vite/Rollup-bundled and ships Rust compiled to WebAssembly, so a reviewer must
be able to rebuild the extension from source and diff it against the uploaded package.

The `pnpm run release firefox` flow attaches this source automatically (web-ext `uploadSourceCode`);
this file is the human-readable build recipe, and it ships inside that archive.

## Toolchain

- **Node.js 24**
- **pnpm 10.33.0**, pinned by `packageManager` in the root `package.json`; `corepack enable` selects it.
- **Rust 1.95.0** with the `wasm32-unknown-unknown` target, pinned by `rust-toolchain.toml`, so
  `rustup` picks the exact toolchain automatically inside the repo.
- **wasm-pack 0.13.1**, used by `pnpm run wasm:build` to compile the crate.

`docker/reproducible-build.Dockerfile` is all of the above in one image.

## Build

```sh
corepack enable
pnpm install --frozen-lockfile        # the lockfile pins every JS dependency
pnpm run wasm:build                    # Rust -> WASM into clients/extension/public/wasm
pnpm run build:firefox                 # TARGET=firefox vite build
```

The built, unpacked extension is in **`clients/extension/dist-firefox/`** — that directory
is what was uploaded to AMO. (`pnpm run bundle:firefox` runs the same `vite build` and additionally
zips `dist-firefox/`; the GitHub release attaches that `.zip`.)

## What is where

- **Rust crate:** `packages/core-rust/` (compiled by `wasm:build`).
- **TypeScript:** shared core in `packages/core/`, the extension in `clients/extension/src/`,
  bundled by Vite (`clients/extension/vite.config.ts`, gated on `TARGET=firefox`).
- **Manifest:** `packages/manifests/firefox/manifest.json` (copied into `dist-firefox/` at build).

## Notes for the reviewer

- No code is obfuscated; it is only minified/bundled by Vite. All original source is in this archive.
- The build is reproducible: every file, the WebAssembly included, comes out byte-identical to the
  uploaded package when built on x86_64 Linux. On another platform the JavaScript still matches
  but the `.wasm` does not, because its layout depends on the build host. To rebuild on any
  machine with Docker, from the root of this archive:

  ```sh
  docker build --platform linux/amd64 -t bramble-build -f docker/reproducible-build.Dockerfile docker
  docker run --rm --platform linux/amd64 -v "$PWD":/src:ro -v "$PWD/out":/out bramble-build bash -c \
    'cp -a /src /build && cd /build && pnpm install --frozen-lockfile && pnpm run wasm:build &&
     pnpm --filter @vault/platform-extension run bundle:firefox && cp -a clients/extension/dist-firefox /out/'
  ```

  `out/dist-firefox/` then matches the uploaded package file for file. See
  docs/reproducible-builds.md, which `scripts/verify-release.ts` automates.
