# 1Password 7 import: the .1pif format

What `import/onepassword-1pif.ts` has to cope with, and the evidence for each rule. Issue #247.

Fixtures: `clients/extension/src/fixtures/imports/onepassword7-data.1pif` and
`onepassword7.zip` (the same export folder zipped, with an attachment).

## Which export

1Password 7, Mac or Windows, exports `.1pif` (1Password Interchange Format) or CSV; `.1pux` is
1Password 8 only (support.1password.com/export). The CSV holds logins and passwords without
custom fields, so `.1pif` is the one we read. It goes on the existing 1Password card:
`parseOnePassword` reads a zip with `export.data` as `.1pux`, a zip with a `.1pif` in it as a
zipped export folder, and anything else as the text of a `data.1pif`.

## Layout

The export is a folder, `<name>.1pif/`, holding `data.1pif`, `attachments/<item uuid>/<file>` and
`previews/` (thumbnails); the two subfolders are only there when some item has a file. It is a
plain folder, not a package: 1Password 7 declares `.1pif` with `LSTypeIsPackage: false`, so a file
picker opens it like any folder. A picker can't choose a folder, so the user picks either
`data.1pif` or a `.zip` of the folder. Only the zip brings attachments: `data.1pif` doesn't
mention them, so the preview always says they stay behind when given the bare file. Finder's
Compress (as `ditto -c -k --sequesterRsrc --keepParent`) adds `__MACOSX/<name>.1pif/._data.1pif`
whenever the file has extended attributes, as the real export below did (1Password 7 marks it
quarantined): its name ends in `.1pif` too, so `__MACOSX/` is skipped. A zip with two exports is refused rather than half
read.

## Records

One JSON object per record, each followed by `***5642bee8-a5ff-11dc-8314-0800200c9a66***` on its
own line. Lines end in LF or CRLF, and the file may start with a BOM. A file without separators
is read one record per line, as Bitwarden's reader reads every file. Some exports leave raw control characters inside strings, which `JSON.parse` rejects, so a
record is retried with them escaped. A record that still won't parse is counted and named in a
warning.

## Two shapes

| | Mac | Windows |
| --- | --- | --- |
| kind | `typeName`: `webforms.WebForm`, `passwords.Password`, `wallet.financial.CreditCard`, … | `category`: `001`, `005`, `002`, … |
| values | `secureContents` | `details` |
| title, websites, tags | `title`, `location` + `secureContents.URLs[].url`, `openContents.tags` | `overview.title`, `overview.URLs[].u` + `overview.url`, `overview.tags` |
| folder | `folderUuid` | `folder` |
| dates (Unix s) | `createdAt`, `updatedAt` | `created`, `updated` |

Inside `secureContents`/`details` the parts are the same: `fields` (the web form, each with
`type` T/E/P/C/R/B/I/… and sometimes a `designation` of `username` or `password`), `sections`
(each field `{k kind, n name, t label, v value}`), `notesPlain`, `password` (a Password item's),
`passwordHistory`.

Items untouched since 1Password 3 still come out in its shape: no sections, values as flat keys
of `secureContents` (`ccnum`, `expiry_mm`, `pop_server`, …). Those keys become the fields when an
item has no section fields.

An empty field has no `v`/`value` key at all. Every part is read on its own, so one odd part
costs only itself; reading a section array whole once dropped every field of a 1Password 7
Identity because one field was empty.

## Mapping

| Kind | Becomes |
| --- | --- |
| Login, Password | login. Username and password are the designated form fields, else the first text/email and password ones. The first section field named `TOTP_…` (or holding an `otpauth://` URI) is the one-time code. Other form fields are kept as fields, except checkbox, radio, button and submit, which are the form's state |
| Credit card | card: `ccnum`, `cardholder`, `cvv`, `expiry` (YYYYMM). `type` is re-derived from the number |
| anything else (note, identity, licence, bank, server, …) | note, its fields as fields and its websites as `URL` fields, so they never fill |
| `trashed` | left out, as every import leaves trash |
| `system.*` | not items: folders, saved searches (smart folders), tombstones of deleted items |

Field values: `concealed` is hidden; `date` (Unix s) reads `YYYY-MM-DD`; `monthYear` (YYYYMM)
reads `MM/YYYY`; `address` is its parts joined. A label that repeats within an item (an email
account's POP and SMTP username) takes its section's title, where it has one.

Folders become tags, one per level, like RoboForm's. Mac folders nest by `folderUuid`, Windows
ones by `parent`; a Windows smart folder is `smart: true`. Password history is left behind, as in
every import but `.bramble` (only `password-changelog.ts` may write the changelog).

## Evidence

A real export from 1Password 7.10.4 for Mac (2026-11-21, 5 logins and 4 notes, no files): LF line
endings, no BOM, a separator after every record. Its data.1pif and a Finder-style zip of its
folder both import all 9 items through the extension, and every value in the file but password
history reaches an entry.

Also checked against the public sample exports in github.com/juanii/OnePIF (`Sample vaults/`):
1Password 7.2.4 for Mac (`1P7-macOS-Cloud.1pif`), 6.8.9 for Mac, 4.6 for Windows and 3.8 for Mac.
Every item in each maps and none fails. The `attachments/` layout comes from those samples (as
`attachments/<item uuid>/<file>`); no real 1Password 7 export with a file has been read, and none
from 1Password 7 for Windows.
