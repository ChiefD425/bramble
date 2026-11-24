# Security Policy

Bramble is a password manager, so its security is the whole point. Reports are
taken seriously and handled with priority. Thank you for helping keep it safe.

## Supported Versions

Bramble is early and ships frequently. Only the latest released version receives
security fixes. There are no long-term support branches, so always update to the
newest release before reporting an issue.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release     | :white_check_mark: |
| Any older release  | :x:                |

The current version is shown on the
[releases page](https://github.com/bramble-sh/bramble/releases) and in the
Chrome Web Store listing.

## How Releases Are Checked

Bramble ships often, so each release says what it changed and what it passed:

- Nothing is built or signed until CI has passed on the exact commit being released: lint, type
  checks, unit tests, the browser end-to-end tests, two-device sync and the transport security
  tests.
- Each GitHub release page ends with two generated sections. **Security-relevant changes** lists
  every commit since the previous release that changed code on the security-sensitive list in
  [`scripts/release-paths.ts`](scripts/release-paths.ts) (cryptography, the vault format, sync,
  unlock, autofill, passkeys, permissions, the updater), or says "None". **How this release was
  checked** links the CI run, the run that built and signed it, and how to rebuild it
  reproducibly.

Anyone can recompute the list from a clone:
`node scripts/release-evidence.ts security <previous tag> <tag> <target>`.

## Reporting a Vulnerability

**Please do not open a public issue, pull request, or discussion for a security
vulnerability.** Disclosing it publicly before a fix is available puts users at
risk.

Use either of these private channels:

- **GitHub Security Advisories (preferred).** Go to the
  [Security tab](https://github.com/bramble-sh/bramble/security/advisories) and
  click **Report a vulnerability**. This keeps the report private and lets us
  collaborate on a fix in one place.
- **Email.** support@bramble.sh. For sensitive details, say so and we can arrange
  an encrypted channel.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected version, browser, and OS.
- Any suggested fix or mitigation.

Reports touching the crypto and vault-format paths (key derivation, key slots,
envelope encryption, the Rust/WASM module, autofill origin matching) get the
closest scrutiny.

## What to Expect

This is a solo, volunteer-run project, so timelines are best-effort rather than
contractual:

- **Acknowledgement:** within 5 days.
- **Initial assessment:** within 14 days, including whether the report is
  accepted and a rough severity.
- **Updates:** at least every 14 days while the issue is open.
- **Fix and disclosure:** for accepted reports, a fix is prioritized by severity.
  Once a fix is released, a security advisory is published. Coordinated
  disclosure is preferred; a typical embargo is up to 90 days, shorter for
  actively exploited issues.
- **If declined:** you will get a clear explanation of why (for example, out of
  scope or working as intended).

## Recognition

With your permission, reporters are credited in the published advisory and
release notes. There is no paid bug bounty.
