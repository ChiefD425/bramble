# What's new after an update

After an update, the first vault list shows a card: "What's new in 1.42.0", the release's headline,
its changes behind a "Show changes" button, and "Read more", which opens the blog post for the
week's releases. Asked for in issue #258.

Code: `packages/core/src/app/whats-new.ts`, `app/hooks/useWhatsNew.ts`,
`app/components/WhatsNewCard.tsx`, the notes in `app/release-notes/<locale>/<target>.md`.

## Where the text comes from

Each target has one English file, `packages/core/src/app/release-notes/en/<target>.md`, written
and approved before its release is dispatched:

```
---
version: 1.42.0
---

Fill a login straight from Bramble's window, and fill two-factor codes with the shortcut.

- Logins that match the page have a Fill button in Bramble's window.
- Shift-click selects a range of items in selection mode.
```

- The first paragraph is the headline; the `- ` lines are the changes. Plain sentences: the card
  shows the text as it is, so other markdown would appear as typed.
- `version` is the release the text is for. An app shows the card only when it equals its own
  version, so a release that went out without new notes shows nothing rather than last release's.
- `pnpm i18n:native` translates it into `release-notes/<locale>/<target>.md` like every other
  surface (`scripts/i18n/release-notes.mjs`, re-translated when the English changes), and
  `pnpm i18n:check` fails while a locale's file is missing or names another version. The app
  shows English for such a locale.
- The same text is the GitHub release's summary: `release.ts` takes it instead of the model's
  draft when its version matches the one being released, so the app, the GitHub release, the email
  and the blog post all say the same thing. Without a match the dispatch warns, drafts as before,
  and that release shows no card.

The files are committed before the dispatch, so a release's tag holds the text its build carried
and the reproducible rebuild (docs/reproducible-builds.md) still matches. The text is in the
bundle: nothing is fetched to show the card. Each target's file is its own lazily loaded chunk,
read only when there is a card to show.

## When the card shows

- **After an update only.** `pref.whatsNew` (device-scoped) records the version the card was last
  closed for. A first launch with no vault yet is a fresh install: it records the installed
  version, so a new user never sees the card. An install that already has a vault but no record
  predates this feature, and gets the card once.
- **Closing it or tapping Read more ends it.** Either records the installed version.
- **Only the latest.** The card is always for the installed version; updating again before
  closing it replaces it.
- **Read more** opens `https://bramble.sh/whats-new/<target>/<version>`. A Pages Function sends
  that to the blog post listing the release (posts carry their tags in `releases:`), or to the
  GitHub release until the post is published, or to `/blog` for iOS, which has no GitHub release.

## One card at a time, one per open

The vault list has one spot for a card (`VaultHomeRoute`). In order:

1. The mobile update notice: a newer version matters more than notes on this one, which arrive
   with that version anyway.
2. What's new.
3. The hosted mailbox's paid time ending (docs/mailbox-service.md, "The paid-time card"). Once the
   time has ended it can't be closed, so it holds back the cards below until it is acted on.
4. The donation card, every two weeks (docs/support-ask.md). It asks for a moment rather than
   waiting to be acted on, so it goes ahead of the two below, which could otherwise hold it back.
5. The store review ask.
6. The default password manager offer (extension).

Closing a card, or acting on it, leaves the spot empty until the next open: the next popup on the
extension, the next unlock on mobile and desktop. Before this, closing one card showed the next
at once. The others only record anything when acted on, so the next one waits for a later open.

iOS asks for a review with Apple's own prompt rather than a card. It is held back on an open that
shows a card or has closed one, so it never lands on top of what's new.
