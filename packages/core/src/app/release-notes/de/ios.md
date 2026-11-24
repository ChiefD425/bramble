---
version: 1.29.0
---

Autofill bleibt entsperrt, wenn die App sich automatisch sperrt, und die Prüfung auf Datenlecks umfasst jetzt alle Logins.

- Die automatische Sperre der App sperrt Autofill nicht mehr; Autofill hat einen eigenen Timer und startet ihn bei jedem Ausfüllen neu.
- Wenn „Passwörter auf Sicherheitslücken prüfen“ aktiviert ist, prüft Bramble jetzt alle Logins im Hintergrund, nicht nur die, die Sie öffnen, und bei jedem Login wird angezeigt, wann er zuletzt geprüft wurde.
- Über das ⋮-Menü in der Liste können Sie einen Eintrag duplizieren oder eine Datei anhängen.
- Ein Tresor, den Sie nicht öffnen können, kann jetzt ohne sein Passwort aus der Liste der Tresore gelöscht werden: Wählen Sie „Tresor löschen“.
- Kopien werden jetzt nach der Zeit gelöscht, die unter Einstellungen → Allgemein → „Clipboard automatisch löschen“ festgelegt ist, statt immer nach 30 Sekunden.
