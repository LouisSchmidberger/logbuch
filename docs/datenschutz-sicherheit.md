# Datenschutz, Sicherheit und Secrets

Rechtstexte (Datenschutzerklärung, AGB, Impressum) sind bewusst NICHT Teil dieses Repos – das
klärt der Nutzer selbst, bevor eine breite/kommerzielle Nutzung startet. Verschlüsselung
siehe [verschluesselung.md](verschluesselung.md).

## Konto und Daten

- **Konto löschen** (Art. 17 DSGVO): Edge Function `delete-account`, aufgerufen über "Konto
  löschen" in den Einstellungen (Bestätigung durch Eintippen von "LÖSCHEN"; der Dialog zeigt
  die E-Mail des Kontos). Löscht per `auth.admin.deleteUser()` ausschließlich den durchs
  mitgeschickte Access-Token ermittelten Nutzer (nie eine vom Client übergebene ID) – alle
  Tabellen hängen per `on delete cascade` an `auth.users`. Danach entfernt
  `clearDeviceAccountTraces` die Spuren des Kontos/Einrichtens auf dem Gerät (`localStorage`:
  angemeldet hier, Einstiegs-Wahl, Einrichten läuft, Installations-Etappe,
  Installations-Seite/-Hinweis weggeklickt, Erklär-Karten, Gruppen-Zustände);
  Geräte-Einstellungen (Hell/Dunkel, Textgröße, Streifenmuster, Vibration) bleiben.
- **Geschützte Konten** (`public.protected_accounts`, Migration
  `20261001120000_add_protected_accounts`): Fremdschlüssel ohne Cascade auf `auth.users` –
  die DB lehnt jedes Löschen dieser Konten ab (auch aus dem Dashboard), `delete-account`
  meldet vorher "geschützt". Eingetragen ist das echte Konto des Betreibers (damit es beim
  häufigen Löschen von Testkonten nicht versehentlich mit erwischt wird); welche Konten das
  sind, steht bewusst nicht im öffentlichen Repo. Entfernen: `delete from
  public.protected_accounts where user_id = …`.
- **Unbestätigte Konten werden automatisch gelöscht**: pg_cron-Job `daily-cleanup` (täglich
  03:17 UTC) ruft `public.delete_stale_unconfirmed_users()` auf – löscht Konten ohne
  E-Mail-Bestätigung und ohne je erfolgte Anmeldung 24h nach der letzten Bestätigungsmail
  (`confirmation_sent_at`, nicht `created_at`, sonst träfe es jemanden, der sich gerade eine
  neue Mail geschickt hat; der Link selbst gilt nur 1h, `otp_expiry`). Grund
  Datensparsamkeit: eine vertippte Adresse gehört oft einer fremden Person. Derselbe Job
  räumt `cron.job_run_details` älter als 14 Tage weg (wächst sonst mit jedem
  15-Minuten-Lauf unbegrenzt).
- **Datenexport** (Art. 15/20 DSGVO): "Meine Daten exportieren" in den Einstellungen
  (`handleExportData`) lädt die eigenen Rohdaten aus allen fünf Tabellen mit Nutzerdaten
  (Felder, Einträge, Gruppen, Einstellungen, Push-Abos; RLS scoped automatisch) direkt im
  Browser als JSON-Datei herunter – keine eigene Function nötig. Feedback ist bewusst
  **nicht** Teil des Exports (Nutzer-Entscheidung).

## Feedback

Übergangslösung bis zu einem möglichen Community-Bereich: Unterseite "Feedback geben" (Menü +
Links an den "ich freue mich über Feedback"-Stellen in "Über Logbuch", `renderFeedback`/
`handleFeedbackSubmit`) → Edge Function `submit-feedback` → `record_feedback()` speichert in
`public.feedback`, danach Mail an den Betreiber über Resend (best effort – schlägt die Mail
fehl, bleibt das Feedback gespeichert). `feedback`/`feedback_rate_log` sind für Nutzer weder
les- noch schreibbar (RLS ohne Policies, GRANTs nur an `service_role` – bewusste Ausnahme von
der sonstigen GRANT-Regel), einziger Weg hinein ist die Function.

- **Limit 5 Nachrichten pro Konto in 24h**, serverseitig und atomar (Advisory-Lock pro
  Nutzer) in `record_feedback()` – ein Client-Limit wäre per direktem API-Aufruf umgehbar.
- **"Ohne Absender senden"**: `feedback.user_id` bleibt NULL, das Limit läuft über das
  getrennte `feedback_rate_log` (nur Konto + Zeitpunkt, kein Inhalt, nach 24h gelöscht –
  stündlicher pg_cron-Job `feedback-rate-log-cleanup`). Bewusst nicht "anonym" genannt: der
  DB-Owner könnte innerhalb dieser 24h über Zeitpunkte zuordnen – der App-Text verspricht nur
  "ich sehe dann nicht, von wem es kommt".
- Mit Absender: die Konto-E-Mail wird Reply-To der Mail (Antworten geht direkt an den
  Nutzer), der Nutzer sieht im Formular, an welche Adresse. Feedback mit Absender wird bei
  Konto-Löschung per Cascade mitgelöscht, ohne Absender nicht (hängt an keinem Konto). Mails
  sind reiner Text (Nutzereingabe nie als HTML).

## Anmeldung

- **Passwort-Reset**: "Passwort vergessen?" → `supabase.auth.resetPasswordForEmail(email, {
  redirectTo: <aktuelle App-URL> })`. Der Rückkehr-Link löst `PASSWORD_RECOVERY` aus
  (`onAuthStateChange`), das Routing zeigt dann `renderPasswordRecovery()` (neues Passwort
  via `auth.updateUser`, plus Ersatzschlüssel, siehe
  [verschluesselung.md](verschluesselung.md)), unabhängig vom sonstigen Session-Status.
  Aus demselben Grund bekommt `signUp()` `options: { emailRedirectTo: <aktuelle App-URL> }`
  – sonst zeigt der Bestätigungslink auf die "Site URL", die nicht zum Pfad passen muss
  (führte zu einer 404-Seite). **Bei einer neuen Domain/Hosting-URL** muss die URL unter
  Supabase Dashboard → Authentication → URL Configuration als Redirect-URL erlaubt sein
  (reine Dashboard-Konfiguration).
- **Signup-Schutz ohne sichtbares Captcha**: zwei dependency-freie Filter im
  Signup-Formular (`renderAuth`): ein unsichtbares Honeypot-Feld (`.honeypot-field`,
  off-screen statt `display:none`, da manche Bots das erkennen) und eine Mindest-Ausfüllzeit
  (`SIGNUP_MIN_FILL_MS`). Beides nur clientseitig, mit generischer Fehlermeldung (kein
  Hinweis, welcher Filter zuschlug). Ergänzt durch die verpflichtende E-Mail-Bestätigung und
  Supabases Rate-Limiting pro IP. **Verworfen: sichtbares Captcha** (Turnstile/hCaptcha/
  reCAPTCHA): lädt eine Drittanbieter-Ressource, die Adblocker/Tracking-Schutz häufig
  blockieren – hindert echte Nutzer an der Registrierung; zusätzlich unvereinbar mit der CSP.
  Schwächer gegen gezielte Bot-Angriffe, aber reibungslos für echte Nutzer – passender
  Kompromiss für einen kleinen, wachsenden Nutzerkreis.
- **Passwort-Policy**: Mindestlänge 10 (`auth.minimum_password_length` in
  `supabase/config.toml`), bewusst ohne Zeichenklassen-Zwang (`password_requirements` leer –
  aktuelle Empfehlungen stellen Länge über erzwungene Komplexität). Im Dashboard aktiviert
  (Authentication → Sign In / Providers → Email, **nicht** in `config.toml`, per `config
  pull` nicht prüfbar): "Require current password when updating" – passt zur
  Zero-Access-Architektur, da das Passwort der einzige Schlüssel ist. Davon getrennt:
  `secure_password_change` (Neuanmeldung vor Passwort-Änderung) ist aus (`config.toml`).
  "Leaked password protection" (HaveIBeenPwned) bleibt aus – nur ab Supabase Pro-Plan,
  aktuell Free.

## E-Mail-Versand (Registrierung/Passwort-Reset)

Über [Resend](https://resend.com) als Custom SMTP (Supabase Dashboard → Authentication →
Emails → SMTP Settings), Rate-Limit 50/Stunde (Authentication → Rate Limits). Supabases
eingebauter Versand ist hart auf 2 Mails/Stunde limitiert (nur für eigenes Testen).
Versand-Domain `mail.louis-schmidberger.de` (Subdomain der privaten Website-Domain des
Nutzers, bei IONOS verwaltet, DNS-Records für Resend dort) – bewusste Interims-Lösung,
entkoppelt von einer möglichen eigenen Projekt-Domain (die bräuchte nur eine neue
Resend-Verifizierung). `RESEND_API_KEY` liegt **ausschließlich** im Dashboard-Formular;
`supabase/config.toml` dokumentiert die SMTP-Konfiguration per
`env(RESEND_API_KEY)`-Platzhalter.

**Troubleshooting "Bestätigungsmail kommt nie an"**: zuerst prüfen, ob "Enable custom SMTP"
noch aktiv ist – der Schalter kann sich (Ursache unklar, kein Zusammenhang mit einzelnen
Bounces) unabhängig von Code-Änderungen ausschalten; dann läuft der Versand unbemerkt über
den eingebauten Mailer (2/Stunde). Erst danach im Resend-Dashboard ("Emails") nach
Bounce/Fehler der Adresse schauen.

**Bestätigungsmail im Spam** (bei GMX beobachtet): SPF/DKIM/DMARC sind korrekt – Ursache
ist der geringe Ruf der Absender-Domain, die kurze Vorlage und dass Absender
(`louis-schmidberger.de`), Link (`supabase.co`) und Ziel (`github.io`) verschiedene Domains
sind. Deshalb die Seite "Schau in dein Postfach" (siehe [onboarding.md](onboarding.md)) und
dort sowie beim Anmelden mit unbestätigter Adresse eine Hilfe (`renderConfirmEmailHelp`,
`state.confirmEmailFor`): Spam-Hinweis, die verwendete Adresse (Tippfehler fallen auf) und
"Mail nochmal senden" (`supabase.auth.resend`; Supabase erlaubt eine Mail pro Minute und
Adresse – die Wartezeit wird angezeigt).

**Vorlage der Bestätigungsmail**: `supabase/templates/confirmation.html` (Kopf der Datei:
Betreff + Hinweise), live im Dashboard unter Authentication → Emails → Templates → "Confirm
signup" – **beide Stellen gleich halten**. Zweisprachig über `.Data.locale` (von `signUp` als
Nutzer-Metadaten mitgeschickt), Deutsch nur bei `de`, sonst Englisch. Ton wie das
Onboarding, echter Button statt Link.

## Secrets

- `VAPID_PUBLIC_KEY` steht im Klartext in `logbuch.js` – beabsichtigt, öffentliche
  Push-Keys sind dafür gedacht.
- `VAPID_PRIVATE_KEY` liegt **ausschließlich** als Supabase Function Secret (`supabase
  secrets set ...`). Beim Rotieren: neuen Key generieren, Secret updaten, öffentlichen Key in
  `logbuch.js` UND im Push-Subscribe-Flow der Nutzer neu abgleichen (alte Subscriptions
  werden mit neuem Key ungültig).
- `SUPABASE_ANON_KEY` (publishable) ist unkritisch öffentlich, liegt in `logbuch.js` und im
  Vault (`publishable_key`, für den Cron-Aufruf).
- `RESEND_FEEDBACK_KEY` (Function Secret): eigener Resend-Key nur für `submit-feedback`
  ("Sending access"), getrennt vom SMTP-Key, damit er sich unabhängig sperren lässt.
  `FEEDBACK_TO_EMAIL` (Function Secret): Empfänger der Feedback-Mails – nicht im Code, da das
  Repo öffentlich ist; änderbar per `supabase secrets set FEEDBACK_TO_EMAIL=...`.
- `CRON_SECRET` (Function Secret) + Vault-Secret `cron_secret` (gleicher Wert): schützt
  `send-notifications` vor Aufrufen von außen. Der `publishable_key` allein reicht der
  Gateway-Prüfung (`verify_jwt`), steht aber öffentlich im Frontend – ohne dieses Secret
  könnte jede*r die Function beliebig oft auslösen (sie verarbeitet *immer alle* Nutzer). Die
  Function vergleicht den Header `x-cron-secret` und lehnt sonst mit 401 ab.
- **Vault-Secrets** (nicht Teil der Migrationen – Daten, kein Schema, `supabase db push` legt
  sie nicht an): der Cron-Job liest zur Laufzeit `project_url`, `publishable_key` und
  `cron_secret` aus `vault.decrypted_secrets`. Bei einem Fresh-Setup einmalig im SQL Editor:
  ```sql
  select vault.create_secret('<project-url>', 'project_url');
  select vault.create_secret('<publishable-key>', 'publishable_key');
  select vault.create_secret('<frisch generierter zufälliger Wert>', 'cron_secret');
  ```
  `cron_secret` muss exakt dem Function Secret `CRON_SECRET` entsprechen (`supabase secrets
  set CRON_SECRET=<wert>`).

Alle privaten Secrets: niemals im Repo.
