# Firefox import: the CSV format

What `import/firefox.ts` has to cope with, and the evidence for each rule. Issue #263.

Fixture: `clients/extension/src/fixtures/imports/firefox.csv`.

## Where it comes from

about:logins → ⋯ → **Export Passwords…** (`about-logins-menu-menuitem-export-logins2`). The file
is written by `toolkit/components/passwordmgr/LoginExport.sys.mjs`, so Firefox's forks (LibreWolf,
Waterfox, Zen, Floorp) and Thunderbird write the same thing.

## Shape

```
"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"
"https://github.com","octo","123456",,"https://github.com","{…}","1700000000000","1710000000000","1705000000000"
```

- Every header and value is quoted, with `"` doubled. A null property is a bare empty cell, so
  `httpRealm` is `,,` on a form login and `formActionOrigin` is `,,` on an HTTP authentication one.
- Rows are joined with CRLF, and the file doesn't end with one. No BOM.
- `url` is the login's origin (`origin` in Firefox; the header is renamed on the way out).
- The three times are epoch milliseconds.

Checked against a real export from Firefox on macOS, 2026-11-21.

## Mapping

| Column | Becomes |
| --- | --- |
| `url` | the login's one website, and its name (the host) |
| `username`, `password` | the same |
| `httpRealm` | an `HTTP realm` field, set only for a site's own sign-in dialog. It tells that login apart from a form login on the same site |
| `timeCreated` | `createdAt` |
| `timePasswordChanged` | `updatedAt` |
| `timeLastUsed` | `lastUsedAt`, so "recently used" and fill suggestions start from Firefox's history |
| `formActionOrigin` | dropped: where the form posts, not a site to fill on. Adding it as a website would offer the login on a second host |
| `guid` | dropped |

## Firefox's own account row

The export calls `Services.logins.getAllLogins()`, which includes Firefox's record of its own
Mozilla account sign-in: origin `chrome://FirefoxAccounts`, realm `Firefox Accounts credentials`,
and a "password" that is a JSON blob holding the account's Sync key. Firefox never shows it
(`LoginHelper.isUserFacingLogin` is exactly `origin != "chrome://FirefoxAccounts"`), so the
importer leaves it out the same way and doesn't count it as skipped: the user never saw it.

## Wrong card

`FIREFOX_CSV` in `csv-format.ts` is the only signature with `httprealm`, and Firefox's header has
no `name`, so it can't pass as Google's. A Firefox file on the Google card, or a Chrome file on the
Firefox card, names the right card.
