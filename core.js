// Pure logic shared by the UI and the test: dates, data model, search, insights, encryption.
// The JSON shape and the backup file format match the iOS app exactly, so backups move both ways.

// MARK: - Dates

export const pad2 = n => String(n).padStart(2, '0');
/** Days are local-calendar strings ("2026-09-15") so timezones/DST never shift an entry. */
export const dayKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export class Month {
  constructor(year, month) { this.year = year; this.month = month; } // month: 1–12
  static of(date) { return new Month(date.getFullYear(), date.getMonth() + 1); }
  static current() { return Month.of(new Date()); }
  static parse(key) { return new Month(Number(key.slice(0, 4)), Number(key.slice(5, 7))); }

  get key() { return `${this.year}-${pad2(this.month)}`; }
  get dayCount() { return new Date(this.year, this.month, 0).getDate(); }
  get days() { return Array.from({ length: this.dayCount }, (_, i) => i + 1); }
  date(day) { return new Date(this.year, this.month - 1, day); }
  dayKey(day) { return `${this.key}-${pad2(day)}`; }
  adding(n) { return Month.of(new Date(this.year, this.month - 1 + n, 1)); }
  equals(o) { return o && o.year === this.year && o.month === this.month; }

  get name() { return this.date(1).toLocaleDateString(undefined, { month: 'long' }); }
  get shortName() { return this.date(1).toLocaleDateString(undefined, { month: 'short' }); }
  get title() { return this.date(1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  weekday(day) { return this.date(day).toLocaleDateString(undefined, { weekday: 'short' }); }

  /** Day number of today if today is in this month. */
  get today() { return this.equals(Month.current()) ? new Date().getDate() : null; }
  get isFuture() { const c = Month.current(); return this.year * 12 + this.month > c.year * 12 + c.month; }
}

/** Splits "2026-09-15" into (Month, 15). */
export function parseDayKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  return [Month.parse(key), Number(key.slice(8))];
}

export const fmtNum = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

// MARK: - Data

export const uuid = () => crypto.randomUUID().toUpperCase(); // same style as Swift's UUID strings
export const PAGE_MODES = [['habits', 'Habits'], ['checklist', 'Checklist'], ['both', 'Both']];

export const newHabit = (name = 'New habit', icon = '⭐️', windowDays = 0, windowTarget = 0) =>
  ({ id: uuid(), name, icon, windowDays, windowTarget, done: [] });

export const newStat = (name = 'New stat', icon = 'chart.xyaxis.line', unit = '', min = 0, max = 10, greenLow = 4, greenHigh = 7, step = 1) =>
  ({ id: uuid(), name, icon, unit, min, max, greenLow, greenHigh, step, values: {} });

export const newTodo = text => ({ id: uuid(), text, done: false });

export function starter() {
  return {
    entries: {}, quotes: {}, todos: {}, pageModes: {},
    habits: [newHabit('Workout', '🏋️', 7, 3), newHabit('100 pushups', '💪'), newHabit('1h book', '📖')],
    stats: [newStat('Sleep', 'bed.double.fill', 'h', 1, 12, 6, 8, 0.5), newStat('Mood', 'face.smiling', '', 1, 10, 6, 10, 1)],
    selectedStat: null, defaultPageMode: 'habits', showQuote: true, appearance: 'system',
    appLock: false, reminderOn: false, reminderMinutes: 20 * 60 + 30,
  };
}

// A missing field falls back to its default (old files keep working), but a field that's present
// and unreadable throws: better to stop than to silently empty part of the journal.
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isBool = v => typeof v === 'boolean';
const mapOf = ok => v => isObj(v) && Object.values(v).every(ok);
const arrOf = ok => v => Array.isArray(v) && v.every(ok);
const oneOf = (...xs) => v => xs.includes(v);

function field(o, key, fallback, ok) {
  if (!(key in o) || o[key] === null) return fallback;
  if (!ok(o[key])) throw new Error(`Unreadable field "${key}"`);
  return o[key];
}

const object = parse => v => { if (!isObj(v)) throw new Error('Unreadable item'); return parse(v); };

const habit = object(h => ({
  id: field(h, 'id', uuid(), isStr), name: field(h, 'name', '', isStr), icon: field(h, 'icon', '⭐️', isStr),
  windowDays: field(h, 'windowDays', 0, isNum), windowTarget: field(h, 'windowTarget', 0, isNum),
  done: field(h, 'done', [], arrOf(isStr)),
}));

const stat = object(s => ({
  id: field(s, 'id', uuid(), isStr), name: field(s, 'name', '', isStr), icon: field(s, 'icon', 'chart.xyaxis.line', isStr),
  unit: field(s, 'unit', '', isStr), min: field(s, 'min', 0, isNum), max: field(s, 'max', 10, isNum),
  greenLow: field(s, 'greenLow', 4, isNum), greenHigh: field(s, 'greenHigh', 7, isNum), step: field(s, 'step', 1, isNum),
  values: field(s, 'values', {}, mapOf(isNum)),
}));

const todo = object(t => ({ id: field(t, 'id', uuid(), isStr), text: field(t, 'text', '', isStr), done: field(t, 'done', false, isBool) }));

export function normalize(raw) {
  if (!isObj(raw)) throw new Error('Not a journal');
  const todos = field(raw, 'todos', {}, isObj);
  return {
    entries: field(raw, 'entries', {}, mapOf(isStr)),
    quotes: field(raw, 'quotes', {}, mapOf(isStr)),
    todos: Object.fromEntries(Object.entries(todos).map(([k, v]) => {
      if (!Array.isArray(v)) throw new Error('Unreadable field "todos"');
      return [k, v.map(todo)];
    })),
    pageModes: field(raw, 'pageModes', {}, mapOf(oneOf('habits', 'checklist', 'both'))),
    habits: field(raw, 'habits', [], Array.isArray).map(habit),
    stats: field(raw, 'stats', [], Array.isArray).map(stat),
    selectedStat: field(raw, 'selectedStat', null, isStr),
    defaultPageMode: field(raw, 'defaultPageMode', 'habits', oneOf('habits', 'checklist', 'both')),
    showQuote: field(raw, 'showQuote', true, isBool),
    appearance: field(raw, 'appearance', 'system', oneOf('system', 'light', 'dark')),
    appLock: field(raw, 'appLock', false, isBool),
    reminderOn: field(raw, 'reminderOn', false, isBool),
    reminderMinutes: field(raw, 'reminderMinutes', 20 * 60 + 30, isNum),
  };
}

/** JSON for storage/backup; Swift omits nil optionals, so do we. */
export function serialize(d) {
  const out = { ...d };
  if (out.selectedStat == null) delete out.selectedStat;
  return JSON.stringify(out);
}

export const pageMode = (d, m) => d.pageModes[m.key] ?? d.defaultPageMode;
export const currentStat = d => d.stats.find(s => s.id === d.selectedStat) ?? d.stats[0] ?? null;

// MARK: - Habits & stats

export const hasGoal = h => h.windowDays > 0 && h.windowTarget > 0;

/** Completions in the windowDays days ending on `date` (inclusive, crosses month boundaries). */
export function windowCount(h, date) {
  let n = 0;
  for (let i = 0; i < h.windowDays; i++) if (h.done.includes(dayKey(addDays(date, -i)))) n++;
  return n;
}
export const goalMet = (h, date) => !hasGoal(h) || windowCount(h, date) >= h.windowTarget;

/** Guards against min >= max typed in Settings. */
export const statDomain = s => [s.min, Math.max(s.max, s.min + Math.max(s.step, 0.1))];

/** Rounds to the step and keeps the value on the scale. */
export function snapped(s, v) {
  const step = Math.max(s.step, 0.1);
  const [lo, hi] = statDomain(s);
  return Math.min(Math.max(Math.round(v / step) * step, lo), hi);
}

/** Where −/+ start on an empty day: the most recent earlier value, else the middle of the green zone. */
export function startValue(s, key) {
  const earlier = Object.keys(s.values).filter(k => k < key).sort();
  return earlier.length ? s.values[earlier.at(-1)] : snapped(s, (s.greenLow + s.greenHigh) / 2);
}

/** Consecutive days ending today (or yesterday, if today isn't done yet). */
export function streak(has, from = new Date()) {
  let d = has(dayKey(from)) ? from : addDays(from, -1);
  let n = 0;
  while (has(dayKey(d))) { n++; d = addDays(d, -1); }
  return n;
}

// MARK: - Search

export const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Every word must appear somewhere in the day: entry, checklist, ticked habits, stats logged,
 * or the date itself ("monday", "september", "2026"). "-word" excludes, and "sleep<6",
 * "mood>=8" filter by stat value (stat name can be abbreviated).
 */
export function search(d, query) {
  const q = fold(query).replace(/\s*(<=|>=|<|>|=)\s*/g, '$1');
  const words = [], excluded = [], filters = [];
  for (const t of q.split(/\s+/).filter(Boolean)) {
    const m = t.match(/^(\p{L}+)(<=|>=|<|>|=)(\d+(?:[.,]\d+)?)$/u);
    const s = m && d.stats.find(s => fold(s.name).startsWith(m[1]));
    if (s) filters.push({ s, op: m[2], v: Number(m[3].replace(',', '.')) });
    else if (t.startsWith('-') && t.length > 1) excluded.push(t.slice(1));
    else words.push(t);
  }
  if (!words.length && !excluded.length && !filters.length) return [];

  const matches = blob => words.every(w => blob.includes(w)) && !excluded.some(w => blob.includes(w));
  const passes = (v, op, x) => v != null && ({ '<': v < x, '<=': v <= x, '>': v > x, '>=': v >= x, '=': v === x })[op];

  const keys = new Set([...Object.keys(d.entries), ...Object.keys(d.todos)]);
  d.habits.forEach(h => h.done.forEach(k => keys.add(k)));
  d.stats.forEach(s => Object.keys(s.values).forEach(k => keys.add(k)));

  const hits = [];
  for (const key of [...keys].sort().reverse()) {
    const parsed = parseDayKey(key);
    if (!parsed) continue;
    const [month, day] = parsed;
    const done = d.habits.filter(h => h.done.includes(key));
    const logged = d.stats.filter(s => s.values[key] != null);
    const items = d.todos[key] ?? [];
    const date = month.date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const blob = fold([d.entries[key] ?? '', key, date, ...items.map(i => i.text), ...done.map(h => h.name), ...logged.map(s => s.name)].join(' '));
    if (!matches(blob) || !filters.every(f => passes(f.s.values[key], f.op, f.v))) continue;
    hits.push({
      id: key, month, day, text: d.entries[key] ?? '',
      details: [...done.map(h => `${h.icon} ${h.name}`), ...logged.map(s => `${s.name} ${fmtNum(s.values[key])}${s.unit}`),
        ...items.map(i => (i.done ? '✓ ' : '○ ') + i.text)],
    });
  }
  if (!filters.length) {
    for (const mk of Object.keys(d.quotes).sort().reverse()) {
      const month = Month.parse(mk);
      if (matches(fold(d.quotes[mk] + ' ' + month.title))) {
        hits.push({ id: 'quote-' + mk, month, day: null, text: d.quotes[mk], details: [`Quote for ${month.title}`] });
      }
    }
  }
  return hits.slice(0, 300);
}

// MARK: - Encryption

const enc = new TextEncoder(), dec = new TextDecoder();
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

/** Device key for the journal: AES-256, non-extractable, so page code can use it but never read it out. */
export const newDeviceKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

/** PBKDF2-HMAC-SHA256 → AES-256 key (passcode lock and backups). */
export async function passwordKey(password, salt, rounds = 310_000) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** AES-GCM "combined" layout, same as CryptoKit: 12-byte nonce + ciphertext + 16-byte tag. */
export async function seal(key, text) {
  const iv = randomBytes(12);
  return concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text))));
}
export async function open(key, bytes) {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
}

// Backup file: "JRNLBK1" + 16-byte salt + AES-GCM box — identical to the iOS app's format.
const MAGIC = enc.encode('JRNLBK1');
export const isBackup = bytes => bytes.length > 23 && MAGIC.every((b, i) => bytes[i] === b);

export async function sealBackup(text, password) {
  const salt = randomBytes(16);
  return concat(MAGIC, salt, await seal(await passwordKey(password, salt), text));
}
export async function openBackup(bytes, password) {
  if (!isBackup(bytes)) throw new Error('Not a backup');
  return open(await passwordKey(password, bytes.slice(7, 23)), bytes.slice(23)); // throws on a wrong password
}
