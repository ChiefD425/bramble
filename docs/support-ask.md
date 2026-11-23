# Asking for support

Every two weeks, the vault list asks once for a donation: a bottom sheet with a short reason, a
**Donate** button that opens Ko-fi, and **Not now**. Modelled on Signal's donation prompts; the
schedule and the copy are Bramble's own.

Code: `packages/core/src/app/support-ask.ts` (the schedule), `app/hooks/useSupportAsk.ts`,
`app/components/SupportSheet.tsx`, `app/components/ui/bottom-sheet.tsx`, the switch in
`Settings/components/SupportSection.tsx`.

## When it shows

- **Every 14 days at most**, counted from when it was last shown. The clock starts on a device's
  first vault list on a build that asks, so a new install, or an existing one after this update,
  is first asked two weeks in.
- **Shown counts as asked.** A popup closed with the sheet still up is not asked again on the
  next open.
- **After Donate, 90 days.** Bramble can't tell whether a donation went through, but someone who
  just went to give shouldn't be asked again in two weeks.
- **Only on an open with no other card.** It is one of the vault list's cards
  (docs/whats-new.md): after the update notice and What's new, ahead of the review ask and the
  default manager offer, so a card someone leaves open can't keep it away for good. Answering it
  leaves the spot empty until the next open, and iOS's own review prompt waits while it is up.
- **Off** with **Remind me every two weeks** in Settings → About → Support.

## Where

The extension, the desktop app and Android. **Not iOS:** App Review has rejected for-profit apps
for an external tip link under guideline 3.1.1, even on an About page, and in-app purchase is the
only route it accepts. `SUPPORT_URL` in `support-ask.ts` is the capability, as `STORE_REVIEW_URL`
is for the review ask: a target without a URL never asks and has no switch.

The crypto addresses in Settings → About → Support predate this and still show on iOS; they carry
the same review risk.

## Privacy

The schedule is a few timestamps in `pref.supportAsk`, device-scoped and never synced: it
describes this install, and a phone's answer should not quiet a browser. iOS stores none. Nothing
is fetched to show the sheet. Ko-fi loads only when someone taps **Donate**, in the browser.
