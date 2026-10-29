// Nachbau von supabase-js für die lokale Vorschau (siehe dev/README.md).
//
// Der Vorschau-Server liefert diese Datei anstelle von vendor/supabase-js-*.js aus. Sie
// bildet nur das nach, was logbuch.js wirklich benutzt: Anmeldung (mit
// Bestätigungs-/Reset-Link über ein lokales "Postfach"), die Tabellen mit ihren
// Standardwerten, eindeutigen Schlüsseln und der Zeilen-Sichtbarkeit "nur eigene Zeilen"
// (RLS), dazu die zwei Edge Functions. Alles liegt in localStorage dieser lokalen Adresse,
// übersteht also ein Neuladen. Verschlüsselt wird weiter in logbuch.js selbst - hier landet
// nur, was auch der echte Server sähe.
//
// Neue Tabelle, Spalte mit Standardwert oder neuer Abfrage-Baustein in logbuch.js: hier
// nachziehen, sonst weicht die Vorschau still vom echten Verhalten ab.

const DB_KEY = 'logbuchPreviewDb';

const TABLES = {
  habit_definitions: {
    key: ['id'],
    defaults: () => ({
      id: crypto.randomUUID(), slug: null, name: null, min: null, max: null, labels: null, good: null,
      sort_order: 0, archived_at: null, created_at: now(), kind: 'scale', unit: null, reminder_minute: null,
      goal_threshold: null, display_style: 'buttons', slider_show_value: true, group_members: null,
      schedule: null, enc: null, section_id: null, period: 'day', period_reminder_day: null, reminder_minutes: null,
    }),
  },
  habit_entries: {
    key: ['user_id', 'entry_date'],
    defaults: () => ({ id: crypto.randomUUID(), data: {}, updated_at: now(), filled_slugs: [], reminder_progress: {} }),
    onUpdate: (row) => { row.updated_at = now(); },
  },
  habit_sections: {
    key: ['id'],
    defaults: () => ({ id: crypto.randomUUID(), sort_order: 0, created_at: now(), reminder_minute: null }),
  },
  user_settings: {
    key: ['user_id'],
    defaults: () => ({
      default_reminder_minute: 1320, created_at: now(), onboarding_completed: false, locale: 'de',
      summary_notifications: true, timezone: 'Europe/Berlin', last_seen_changelog: null,
    }),
  },
  user_encryption: {
    key: ['user_id'],
    defaults: () => ({ kdf_iterations: 250000, created_at: now(), recovery_key_confirmed: false, dek_id: null }),
  },
  push_subscriptions: {
    key: ['endpoint'],
    defaults: () => ({ id: crypto.randomUUID(), created_at: now() }),
  },
};

function now() { return new Date().toISOString(); }

// --- Speicher ---------------------------------------------------------------
function emptyDb() {
  return { users: [], session: null, mails: [], tables: Object.fromEntries(Object.keys(TABLES).map((t) => [t, []])) };
}
function loadDb() {
  try {
    const db = JSON.parse(localStorage.getItem(DB_KEY));
    if (db && db.tables) {
      for (const t of Object.keys(TABLES)) db.tables[t] ??= [];
      return db;
    }
  } catch { /* neu anlegen */ }
  return emptyDb();
}
function saveDb(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
function withDb(fn) {
  const db = loadDb();
  const result = fn(db);
  saveDb(db);
  return result;
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
// Ein Hauch Netz, damit "läuft …"-Zustände kurz sichtbar sind. Langsames Netz nachstellen:
// localStorage.setItem('logbuchPreviewDelayMs', '2000') (gilt für jeden Aufruf).
const delay = () => new Promise((r) => setTimeout(r, Number(localStorage.getItem('logbuchPreviewDelayMs')) || 30));

// --- Auth -------------------------------------------------------------------
function publicUser(u) {
  return {
    id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated',
    email_confirmed_at: u.confirmedAt, created_at: u.createdAt, user_metadata: u.metadata || {},
    ...(u.pendingEmail ? { new_email: u.pendingEmail } : {}),
  };
}
function makeSession(u) {
  return {
    access_token: `preview-${u.id}`, refresh_token: 'preview', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: publicUser(u),
  };
}
function createUser(db, email, password, { confirmed = false, metadata = {} } = {}) {
  const u = {
    id: crypto.randomUUID(), email, password, metadata,
    createdAt: now(), confirmedAt: confirmed ? now() : null,
  };
  db.users.push(u);
  // Wie der Trigger on_auth_user_created_seed_settings.
  db.tables.user_settings.push({ ...TABLES.user_settings.defaults(), user_id: u.id });
  return u;
}
function sendMail(db, to, kind, link) {
  db.mails.push({ to, kind, link, at: now() });
  console.info(`[Vorschau] Mail "${kind}" an ${to}: ${link}`);
}
function linkFor(redirectTo, userId, type) {
  const base = redirectTo || (location.origin + location.pathname);
  return `${base}#access_token=preview-link-${userId}&type=${type}`;
}

function authError(message, status = 400, code) { return { message, status, code, name: 'AuthApiError' }; }

class MockAuth {
  constructor() {
    this.listeners = new Set();
    this.pendingEvent = null;
    // Wie supabase-js (detectSessionInUrl): Token aus dem Link nach '#' übernehmen und den
    // Teil aus der Adresse entfernen.
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get('access_token');
    if (token && token.startsWith('preview-link-')) {
      const userId = token.slice('preview-link-'.length);
      const type = hash.get('type');
      withDb((db) => {
        const u = db.users.find((x) => x.id === userId);
        if (!u) return;
        if (type === 'signup' && !u.confirmedAt) u.confirmedAt = now();
        if (type === 'email_change' && u.pendingEmail) {
          sendMail(db, u.email, 'email_changed_notification', null); // Hinweis an die bisherige
          u.email = u.pendingEmail;
          delete u.pendingEmail;
        }
        db.session = makeSession(u);
        if (type === 'recovery') db.session.recovery = true; // wie Supabase: Reset ohne aktuelles Passwort
      });
      this.pendingEvent = type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN';
      history.replaceState(history.state, '', location.pathname + location.search);
    }
  }

  emit(event, session) {
    for (const cb of this.listeners) setTimeout(() => cb(event, clone(session)), 0);
  }
  currentSession() { return loadDb().session; }

  onAuthStateChange(cb) {
    this.listeners.add(cb);
    const session = this.currentSession();
    setTimeout(() => {
      cb('INITIAL_SESSION', clone(session));
      if (this.pendingEvent) { cb(this.pendingEvent, clone(session)); this.pendingEvent = null; }
    }, 0);
    return { data: { subscription: { unsubscribe: () => this.listeners.delete(cb) } } };
  }

  async getSession() { await delay(); return { data: { session: clone(this.currentSession()) }, error: null }; }
  async getUser() {
    await delay();
    const s = this.currentSession();
    return s ? { data: { user: s.user }, error: null } : { data: { user: null }, error: authError('Auth session missing!') };
  }

  async signUp({ email, password, options = {} }) {
    await delay();
    return withDb((db) => {
      const existing = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      // Wie Supabase bei eingeschalteter Bestätigung: kein Hinweis, ob es die Adresse schon gibt.
      if (existing) return { data: { user: publicUser(existing), session: null }, error: null };
      const u = createUser(db, email, password, { metadata: options.data });
      sendMail(db, email, 'signup', linkFor(options.emailRedirectTo, u.id, 'signup'));
      return { data: { user: publicUser(u), session: null }, error: null };
    });
  }

  async signInWithPassword({ email, password }) {
    await delay();
    const result = withDb((db) => {
      const u = db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!u || u.password !== password) return { data: { user: null, session: null }, error: authError('Invalid login credentials') };
      if (!u.confirmedAt) return { data: { user: null, session: null }, error: authError('Email not confirmed') };
      db.session = makeSession(u);
      return { data: { user: publicUser(u), session: clone(db.session) }, error: null };
    });
    if (!result.error) this.emit('SIGNED_IN', result.data.session);
    return result;
  }

  async signOut({ scope = 'global' } = {}) {
    await delay();
    if (scope === 'others') return { error: null }; // es gibt nur dieses eine "Gerät"
    withDb((db) => { db.session = null; });
    this.emit('SIGNED_OUT', null);
    return { error: null };
  }

  async resend({ email, options = {} }) {
    await delay();
    return withDb((db) => {
      const u = db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (u && !u.confirmedAt) sendMail(db, email, 'signup', linkFor(options.emailRedirectTo, u.id, 'signup'));
      return { data: {}, error: null };
    });
  }

  async resetPasswordForEmail(email, { redirectTo } = {}) {
    await delay();
    return withDb((db) => {
      const u = db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (u) sendMail(db, email, 'recovery', linkFor(redirectTo, u.id, 'recovery'));
      return { data: {}, error: null };
    });
  }

  async updateUser(attrs, options = {}) {
    await delay();
    const result = withDb((db) => {
      if (!db.session) return { data: { user: null }, error: authError('Auth session missing!', 401) };
      // Zum Testen: previewAdmin.failNextUpdateUser() - wie ein Verbindungsabbruch, die
      // Änderung kommt beim Server trotzdem an (der unklare Fall in changePassword).
      const failAfterApply = db.failNextUpdateUser;
      delete db.failNextUpdateUser;
      const u = db.users.find((x) => x.id === db.session.user.id);
      if (attrs.password !== undefined) {
        // Wie "Require current password when updating" (Dashboard): außer im Reset-Link.
        if (!db.session.recovery) {
          if (!attrs.current_password) return { data: { user: null }, error: authError('Current password required when setting new password.', 400, 'current_password_required') };
          if (attrs.current_password !== u.password) return { data: { user: null }, error: authError('Current password required when setting new password.', 400, 'current_password_invalid') };
        }
        if (attrs.password === u.password) return { data: { user: null }, error: authError('New password should be different from the old password.', 422, 'same_password') };
        u.password = attrs.password;
      }
      if (attrs.email !== undefined && attrs.email !== u.email) {
        if (db.users.some((x) => x !== u && x.email.toLowerCase() === attrs.email.toLowerCase())) {
          return { data: { user: null }, error: authError('A user with this email address has already been registered', 422, 'email_exists') };
        }
        // Nur die neue Adresse bestätigt (double_confirm_changes = false).
        u.pendingEmail = attrs.email;
        sendMail(db, attrs.email, 'email_change', linkFor(options.emailRedirectTo, u.id, 'email_change'));
      }
      if (attrs.data) u.metadata = { ...u.metadata, ...attrs.data };
      db.session = makeSession(u);
      if (failAfterApply) return { data: { user: null }, error: { message: 'Failed to fetch', status: 0, name: 'AuthRetryableFetchError' } };
      return { data: { user: publicUser(u) }, error: null };
    });
    if (!result.error) this.emit('USER_UPDATED', loadDb().session);
    return result;
  }
}

// --- Tabellen (PostgREST-Nachbau) --------------------------------------------
function dbError(message, code) { return { message, code, details: null, hint: null }; }

class QueryBuilder {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.orders = [];
    this.rangeFrom = null;
    this.rangeTo = null;
    this.columns = '*';
    this.returning = false;
    this.cardinality = 'many';
    this.payload = null;
    this.onConflict = null;
  }
  select(columns = '*') {
    if (this.op === 'select') this.columns = columns;
    else { this.returning = true; this.columns = columns; }
    return this;
  }
  insert(values) { this.op = 'insert'; this.payload = values; return this; }
  upsert(values, { onConflict } = {}) { this.op = 'upsert'; this.payload = values; this.onConflict = onConflict; return this; }
  update(values) { this.op = 'update'; this.payload = values; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val || (r[col] != null && val != null && String(r[col]) === String(val))); return this; }
  neq(col, val) { this.filters.push((r) => r[col] !== val); return this; }
  is(col, val) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  not(col, op, val) {
    if (op !== 'is') throw new Error(`[Vorschau] not(${op}) nicht nachgebaut`);
    this.filters.push((r) => (val === null ? r[col] != null : r[col] !== val));
    return this;
  }
  order(col, { ascending = true } = {}) { this.orders.push({ col, ascending }); return this; }
  range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this; }
  limit(n) { this.rangeFrom = 0; this.rangeTo = n - 1; return this; }
  single() { this.cardinality = 'single'; return this; }
  maybeSingle() { this.cardinality = 'maybe'; return this; }
  then(resolve, reject) { return this.execute().then(resolve, reject); }

  async execute() {
    await delay();
    const session = this.client.auth.currentSession();
    if (!session) return { data: null, error: dbError('permission denied (keine Anmeldung)', '42501') };
    const uid = session.user.id;
    const spec = TABLES[this.table];
    if (!spec) return { data: null, error: dbError(`relation "public.${this.table}" does not exist`, '42P01') };
    let out;
    try {
      out = withDb((db) => this.run(db, spec, uid));
    } catch (err) {
      return { data: null, error: err.code ? err : dbError(err.message, 'XX000') };
    }
    return this.shape(out);
  }

  visible(rows, uid) {
    // RLS: jede Tabelle mit user_id zeigt nur die eigenen Zeilen.
    return rows.filter((r) => r.user_id === uid && this.filters.every((f) => f(r)));
  }

  run(db, spec, uid) {
    const rows = db.tables[this.table];
    const keyOf = (r, cols) => cols.map((c) => String(r[c])).join('|');
    const prepare = (v) => {
      const row = { ...spec.defaults(), user_id: uid, ...clone(v) };
      if (row.user_id !== uid) throw dbError('new row violates row-level security policy', '42501');
      return row;
    };
    switch (this.op) {
      case 'select':
        return this.visible(rows, uid);
      case 'insert': {
        const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(prepare);
        for (const row of list) {
          if (rows.some((r) => keyOf(r, spec.key) === keyOf(row, spec.key))) {
            throw dbError(`duplicate key value violates unique constraint "${this.table}_pkey"`, '23505');
          }
          rows.push(row);
        }
        return list;
      }
      case 'upsert': {
        const cols = this.onConflict ? this.onConflict.split(',').map((s) => s.trim()) : spec.key;
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        return list.map((v) => {
          const candidate = prepare(v);
          const existing = rows.find((r) => keyOf(r, cols) === keyOf(candidate, cols));
          if (!existing) { rows.push(candidate); return candidate; }
          if (existing.user_id !== uid) throw dbError('new row violates row-level security policy', '42501');
          // PostgREST "merge-duplicates": nur die mitgeschickten Spalten ändern sich.
          Object.assign(existing, clone(v));
          spec.onUpdate?.(existing);
          return existing;
        });
      }
      case 'update': {
        const hit = this.visible(rows, uid);
        for (const r of hit) { Object.assign(r, clone(this.payload)); spec.onUpdate?.(r); }
        return hit;
      }
      case 'delete': {
        const hit = new Set(this.visible(rows, uid));
        const kept = rows.filter((r) => !hit.has(r));
        rows.length = 0;
        rows.push(...kept);
        if (this.table === 'habit_sections') {
          // ON DELETE SET NULL der Feld-Zuordnung (wie in der Migration).
          const ids = new Set([...hit].map((r) => r.id));
          db.tables.habit_definitions.forEach((d) => { if (ids.has(d.section_id)) d.section_id = null; });
        }
        return [...hit];
      }
      default:
        throw new Error(`[Vorschau] Operation ${this.op} nicht nachgebaut`);
    }
  }

  shape(rows) {
    if (this.op !== 'select' && !this.returning) return { data: null, error: null, count: null, status: 204 };
    let data = rows.slice();
    for (const { col, ascending } of [...this.orders].reverse()) {
      data.sort((a, b) => {
        const x = a[col]; const y = b[col];
        if (x === y) return 0;
        if (x == null) return ascending ? 1 : -1; // NULLS LAST bei aufsteigend, wie Postgres
        if (y == null) return ascending ? -1 : 1;
        return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (this.rangeFrom !== null) data = data.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.columns !== '*') {
      const cols = this.columns.split(',').map((s) => s.trim());
      data = data.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    }
    data = clone(data);
    if (this.cardinality === 'many') return { data, error: null };
    if (data.length > 1) return { data: null, error: dbError('JSON object requested, multiple (or no) rows returned', 'PGRST116') };
    if (data.length === 0 && this.cardinality === 'single') {
      return { data: null, error: dbError('JSON object requested, multiple (or no) rows returned', 'PGRST116') };
    }
    return { data: data[0] ?? null, error: null };
  }
}

// --- Edge Functions -------------------------------------------------------------
class MockFunctions {
  constructor(client) { this.client = client; }
  async invoke(name) {
    await delay();
    const session = this.client.auth.currentSession();
    if (!session) return { data: null, error: { message: 'Unauthorized' } };
    const uid = session.user.id;
    if (name === 'delete-account') {
      withDb((db) => {
        db.users = db.users.filter((u) => u.id !== uid);
        for (const t of Object.keys(db.tables)) db.tables[t] = db.tables[t].filter((r) => r.user_id !== uid);
      });
      return { data: { ok: true }, error: null };
    }
    if (name === 'submit-feedback') {
      console.info('[Vorschau] Feedback empfangen (nicht versendet)');
      return { data: { ok: true }, error: null };
    }
    return { data: null, error: { message: `Function ${name} nicht nachgebaut` } };
  }
}

export function createClient() {
  console.info('%c[Vorschau] Nachgebautes Supabase aktiv - nichts verlässt diesen Rechner.', 'font-weight:bold');
  const client = {};
  client.auth = new MockAuth();
  client.from = (table) => new QueryBuilder(client, table);
  client.functions = new MockFunctions(client);
  client.rpc = async (name) => {
    await delay();
    if (name === 'record_signup_mail_feedback') {
      console.info('[Vorschau] Spam-Rückmeldung empfangen (nicht gespeichert)');
      return { data: null, error: null };
    }
    return { data: null, error: { message: `RPC ${name} nicht nachgebaut` } };
  };
  return client;
}

// Für Startskripte und Screenshots (über window.__logbuchPreview, siehe preview-hook.js).
export const previewAdmin = {
  reset() { localStorage.removeItem(DB_KEY); },
  createConfirmedUser(email, password) {
    return withDb((db) => createUser(db, email, password, { confirmed: true }).id);
  },
  mails() { return loadDb().mails; },
  lastMailLink(kind) { return loadDb().mails.filter((m) => !kind || m.kind === kind).at(-1)?.link ?? null; },
  dump() { return loadDb(); },
  failNextUpdateUser() { withDb((db) => { db.failNextUpdateUser = true; }); },
};
