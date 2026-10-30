# Freigabe: Beta, Tester, Live und Schalter pro Funktion

Nutzer-Entscheidung 2026-10-30 (Variante "kombiniert"): drei Stufen, ohne eine dritte Seite
und ohne Code-Zweige.

- **Private Beta** = die Beta-Seite (`git push beta main`): halbfertiger Stand, darf auch mal
  kaputt sein, nur Louis. Unverändert wie in CLAUDE.md "Deployment".
- **Live** bekommt fertigen Code wie bisher gesammelt am Sitzungsende. Ob eine neue Funktion
  dort **sichtbar** ist, entscheidet ihr Schalter, nicht der Live-Gang.
- **Schalter** (`feature_flags.stage`): `off` → `owner` (nur Louis) → `testers` (ausgewählte
  Konten + Louis) → `all`. Welche Konten Tester sind, steht in `user_access` (`owner` |
  `tester`). Beide Tabellen sind für Nutzer nur lesbar; ändern nur über Dashboard/SQL
  (service_role) - sonst könnte sich jeder selbst freischalten.

Verworfen: drei Seiten mit je eigenem Code-Stand - gibt nur ganze Stände frei (einzelne
Funktionen zurückhalten bräuchte ständig zusammenzuführende Zweige), GitHub Pages schützt
"nur ausgewählte Leute" nicht (nur über den Link), und Datenbank/Functions teilen sich ohnehin
alle.

## Deployment-Schritte

1. `logbuch.html`, `logbuch.js`, `sw.js`, `vendor/`, `fonts/` → GitHub Pages (Root).
2. `supabase functions deploy <name>` (Code unter `supabase/functions/<name>/index.ts`).
3. Schema-Änderungen nur über Migrationen (`supabase/migrations/`):
   `supabase migration new <name>`, dann `supabase db push --linked` gegen das Live-Projekt
   (vorher `--dry-run` zeigt, was ginge). Nach Dashboard-Änderungen am Schema (Ausnahme)
   `supabase db pull` (braucht Docker Desktop für die Schatten-Datenbank).
   Vault-Secrets sind nicht Teil der Migrationen (siehe docs/datenschutz-sicherheit.md).
4. `supabase/config.toml` spiegelt Auth-/API-/DB-Einstellungen rein dokumentarisch (kein
   `config push`); nach Dashboard-Änderungen `supabase config pull --force`.

## Im Code

- `featureOn('<key>')` (Stand aus `loadFeatureAccess` beim Anmelden, geleert mit
  `clearCurrentDek`). Unbekannter Schalter oder Ladefehler = aus.
- **Ein Schalter sperrt nur den Einstieg** (eine Feld-Art im Formular, einen Menüpunkt), nie
  vorhandene Daten oder deren Anzeige: wer etwas schon angelegt hat, behält es, auch wenn die
  Stufe wieder sinkt; Bearbeiten bleibt möglich.
- **Nach der Freigabe für alle**: erst den Schalter aus dem Code nehmen (Live-Gang), dann die
  Zeile in `feature_flags` löschen - sonst sammeln sich tote Abzweigungen.
- Ein Schalter im Browser ist kein Schutz: wer technisch versiert ist, kann eine versteckte
  Funktion freischalten. Für Tests egal; für Premium siehe unten.

**Aktuelle Schalter**: `since` (berechnet "Tage seit"), `multi` (Feld-Typ Mehrfachauswahl),
`templates` (Vorlagen bei "Neues Feld" und im Tutorial). Alle drei seit 2026-10-30 auf `all`;
nach ein paar ruhigen Tagen aus dem Code nehmen, dann die Zeilen löschen.

## Schalter setzen (Dashboard → SQL)

```sql
update public.feature_flags set stage = 'testers', updated_at = now() where key = 'since';
insert into public.feature_flags (key, stage, note) values ('<key>', 'owner', '<wofür>');
insert into public.user_access (user_id, access_group)
  select id, 'tester' from auth.users where email = '<adresse>';
```

Neuer Schalter: Zeile per Migration anlegen (Stufe `owner`), im Code `featureOn`, in
`dev/tests.mjs` nichts nötig (die Stufenlogik ist dort getestet). Vorschau:
`window.__logbuchPreview.admin.setFeature(key, stage)` / `setAccessGroup(email, group)`.

## "Was ist neu"

Der Eintrag gehört zur Freigabe für **alle**, nicht zum Live-Gang: eine Funktion hinter einem
Schalter bekommt ihren `CHANGELOG`-Eintrag erst mit dem Live-Gang, der sie für alle
freischaltet (bzw. ihren Schalter aus dem Code nimmt).

## Datenschutz

`user_access` ist eine Zuordnung durch den Betreiber, keine Information über die Nutzung -
der Datenschutz-Text in "Über Logbuch" ändert sich dadurch nicht. Im Export steht die eigene
Gruppe (`access_group`); beim Löschen des Kontos verschwindet die Zeile mit (`on delete
cascade`).

## Premium (noch nicht entschieden)

Die Schalter sind die Technik, mit der Premium später sichtbar gemacht würde (eine weitere
Gruppe). Offen ist das Grundsätzliche: wegen der Zero-Access-Verschlüsselung läuft fast alles
auf dem Gerät und ist dort nicht erzwingbar.
