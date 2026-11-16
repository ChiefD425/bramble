# Governance

This document describes who makes decisions about Bramble, how they are made, and what the
project commits to. It covers the code in this repository and the apps built from it.

## Roles

- **Lead maintainer:** [@flythenimbus](https://github.com/flythenimbus). Sets the roadmap,
  reviews and merges changes, approves every release, and handles security reports. The lead
  maintainer is the only person with merge rights and access to the release signing keys.
- **Contributors:** anyone who opens an issue, reviews a change, translates, or sends a pull
  request. Contributors keep their copyright and license their work under the project's licenses
  by signing [CLA.md](CLA.md).
- **Security reporters:** anyone who reports a vulnerability privately, as described in
  [SECURITY.md](SECURITY.md).

## How decisions are made

- **In the open.** Features, bugs and design questions are discussed in
  [GitHub issues](https://github.com/bramble-sh/bramble/issues). Anything large, such as a new
  feature, a new dependency, or a change to the vault format or crypto, starts as an issue before
  any code is written.
- **Written down.** Significant design decisions are recorded in [docs/](docs/README.md), so the
  reasoning stays available to everyone after the discussion ends.
- **Final say.** The lead maintainer makes the final call, after hearing from contributors and
  users, and explains the reasoning in the issue or pull request.
- **Higher bar for security code.** Changes to key derivation, encryption, the vault format, sync
  and autofill origin matching need tests and closer review before they are merged.

## Releases

Every change goes through the checks described in [CONTRIBUTING.md](CONTRIBUTING.md) before it
is merged. Releases are built from this repository by GitHub Actions, in protected release
environments that wait for the lead maintainer's approval before any signing key is used. Signing
keys are never stored in the repository. See [docs/release-signing.md](docs/release-signing.md)
and the [code signing policy](https://bramble.sh/code-signing).

## Security

Vulnerabilities are reported privately and handled as described in [SECURITY.md](SECURITY.md).
Once a fix is released, a security advisory is published on GitHub.

## Commitments

These hold regardless of who maintains Bramble or how it is funded:

- **Free software.** Bramble's source code stays available to everyone under the GPLv3 (the
  AGPLv3 for the server components), as [CLA.md](CLA.md) commits.
- **Your data stays yours.** No telemetry, no analytics, no ads, and no selling or sharing of user
  data. Bramble runs no server that stores anyone's vault. See the
  [privacy policy](https://bramble.sh/privacy).
- **No lock-in.** Users can always export their vault to an open format and leave.

## Funding

Bramble is independent and takes no venture capital. It is funded by donations and grants, which
pay for maintainer time and independent security audits. Funding sources and plans are published
in [funding.json](https://bramble.sh/funding.json). No funder gets a say over the commitments
above.

## Becoming a maintainer

Contributors who make sustained, high-quality contributions and show good judgment in review may
be invited to become maintainers with merge rights. Release approval and the signing keys stay
with the lead maintainer unless this document is updated to say otherwise.

## Changes to this document

Changes to this document are made by pull request, like any other change, so the history of how
Bramble is governed stays public.
