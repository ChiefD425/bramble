// Where a desktop release compiles on macOS, whoever builds it: CI, the local route, and anyone
// checking a release (docs/reproducible-builds.md). The desktop crate reaches packages/core-rust by
// a path outside its own workspace, and Cargo hashes such a dependency by its absolute path, which
// then decides symbol names and code layout: the same commit built in two places gives two
// binaries. A path that is the same everywhere takes that away. /tmp, because anyone can create it.
export const CANONICAL_MACOS = "/private/tmp/bramble";
