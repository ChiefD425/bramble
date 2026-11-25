//! Bramble as an SSH agent: `ssh`, `git` and friends sign with the SSH keys in the vault, and the
//! private keys never leave this process. See docs/ssh-agent.md.

pub mod keys;
pub mod protocol;
pub mod store;
