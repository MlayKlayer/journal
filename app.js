import * as C from './core.js';

// MARK: - Helpers

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  chev: '<path d="M6 9l6 6 6-6"/>',
  updown: '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4z"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  check: '<path d="M6 12.5l4 4L18 8.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  warn: '<path d="M12 3L2 20h20L12 3z" fill="currentColor" stroke="none"/><path d="M12 10v4M12 17v.01" stroke="#fff"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// The iOS app uses SF Symbols for stat icons; the web shows an emoji for the same name.
const STAT_ICONS = {
  'bed.double.fill': '🛏️', 'face.smiling': '🙂', 'figure.walk': '🚶', 'scalemass': '⚖️', 'drop.fill': '💧',
  'flame.fill': '🔥', 'brain.head.profile': '🧠', 'heart.fill': '❤️', 'cup.and.saucer.fill': '☕️', 'chart.xyaxis.line': '📈',
};
const statIcon = s => STAT_ICONS[s.icon] ?? '📈';
const lastGrapheme = s => { const g = [...new Intl.Segmenter().segment(s)]; return g.length ? g.at(-1).segment : ''; };

// MARK: - Storage (IndexedDB; the journal is only ever stored encrypted)

const idb = (() => {
  let db;
  const open = () => db ??= new Promise((res, rej) => {
    const r = indexedDB.open('journal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const store = (await open()).transaction('kv', mode);
    const req = fn(store.objectStore('kv'));
    return new Promise((res, rej) => { store.oncomplete = () => res(req.result); store.onerror = () => rej(store.error); });
  };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)) };
})();

// MARK: - State

let data = null;        // the journal (decrypted, in memory only while unlocked)
let vault = null;       // { mode: 'device', key } or { mode: 'passcode', key, salt }
let months = [];
let today = C.dayKey(new Date());
const rendered = new Set();
const pickedDay = {};   // stat input: month key → day
const pager = $('#pager');
const layers = $('#layers');

// ponytail: re-encrypts and rewrites the whole journal on every change; fine for years of one-liners.
let saving = Promise.resolve();
function save() {
  const text = C.serialize(data), v = vault;
  saving = saving.then(async () => {
    const blob = await C.seal(v.key, text);
    await idb.set('vault', v.mode === 'device' ? { mode: 'device', key: v.key, blob } : { mode: 'passcode', salt: v.salt, blob });
  }).catch(e => info(`Couldn't save: ${e.message}`));
  return saving;
}

// MARK: - Boot & lock

async function boot() {
  navigator.storage?.persist?.(); // ask Safari not to evict the journal
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  const rec = await idb.get('vault');
  if (!rec) {
    vault = { mode: 'device', key: await C.newDeviceKey() };
    data = C.starter();
    await save();
  } else if (rec.mode === 'passcode') {
    return showLock();
  } else {
    vault = { mode: 'device', key: rec.key };
    try {
      data = C.normalize(JSON.parse(await C.open(rec.key, rec.blob)));
    } catch {
      // Never overwrite what we couldn't open: keep it aside, start fresh.
      await idb.set(`vault-unreadable-${Date.now()}`, rec);
      data = C.starter();
      await save();
      setTimeout(() => info('Your journal couldn\'t be opened, so it was set aside. Restore it from an encrypted backup in Settings → Data.'), 300);
    }
  }
  start();
}

function showLock(message = '') {
  $('#lock').hidden = false;
  $('#lock-error').textContent = message;
  const input = $('#lock-pass');
  input.value = '';
  setTimeout(() => input.focus(), 100);
}

$('#lock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#lock-form button');
  btn.disabled = true;
  try {
    const rec = await idb.get('vault');
    const key = await C.passwordKey($('#lock-pass').value, rec.salt);
    let text;
    try { text = await C.open(key, rec.blob); } catch { return showLock('Wrong passcode'); }
    vault = { mode: 'passcode', key, salt: rec.salt };
    data = C.normalize(JSON.parse(text));
    $('#lock').hidden = true;
    start();
  } catch (err) {
    showLock(`Couldn't open the journal: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

/** Forgets the key and everything decrypted, so a locked journal really is unreadable. */
async function lockNow() {
  await saving;
  data = null;
  vault = null;
  pager.innerHTML = '';
  rendered.clear();
  layers.innerHTML = '';
  sheets.length = 0;
  showLock();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (vault?.mode === 'passcode') lockNow();
    return;
  }
  // The app can sit in the background overnight; on return, jump to the new day.
  if (data && C.dayKey(new Date()) !== today) {
    today = C.dayKey(new Date());
    buildPager();
    go(C.Month.current(), false);
  }
});

function start() {
  applyTheme();
  buildPager();
  go(C.Month.current(), false);
}

function applyTheme() {
  const a = data.appearance;
  if (a === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = a;
}

// MARK: - Pager (one page per screen: Sep journal → Sep tracker → Oct journal …)

const io = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting && !rendered.has(e.target.dataset.month)) renderMonth(C.Month.parse(e.target.dataset.month));
}, { root: pager, rootMargin: '0px 100% 0px 100%' });

/** Months shown: from the earliest entry (or a year back) to next month. */
function monthRange() {
  const cur = C.Month.current();
  let start = cur.adding(-12);
  const first = Object.keys(data.entries).sort()[0];
  if (first && first < start.dayKey(1)) start = C.Month.parse(first);
  const out = [start];
  while (!out.at(-1).equals(cur.adding(1))) out.push(out.at(-1).adding(1));
  return out;
}

function buildPager() {
  months = monthRange();
  io.disconnect();
  rendered.clear();
  pager.innerHTML = months.map(m =>
    `<section class="page" data-month="${m.key}" data-side="J"></section><section class="page" data-month="${m.key}" data-side="T"></section>`).join('');
  pager.querySelectorAll('.page').forEach(p => io.observe(p));
  $('#month-select').innerHTML = [...months].reverse().map(m => `<option value="${m.key}">${esc(m.title)}</option>`).join('');
}

const pageIndex = () => Math.round(pager.scrollLeft / pager.clientWidth);
const currentPage = () => { const i = pageIndex(); return { month: months[Math.min(i >> 1, months.length - 1)], tracker: i % 2 === 1 }; };

function go(month, tracker, smooth = false) {
  const mi = months.findIndex(m => m.equals(month));
  if (mi < 0) return;
  if (!rendered.has(month.key)) renderMonth(month);
  pager.scrollTo({ left: (mi * 2 + (tracker ? 1 : 0)) * pager.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  updateHeader();
}

let headerFrame = 0;
pager.addEventListener('scroll', () => { cancelAnimationFrame(headerFrame); headerFrame = requestAnimationFrame(updateHeader); }, { passive: true });
addEventListener('resize', () => { const p = currentPage(); go(p.month, p.tracker); });

function updateHeader() {
  if (!months.length) return;
  const { month, tracker } = currentPage();
  $('#t-month').textContent = month.name;
  $('#t-year').textContent = month.year;
  $('#t-side').textContent = tracker ? 'Tracker' : 'Journal';
  $('#topbar').classList.toggle('on-tracker', tracker);
  $('#month-select').value = month.key;
}

$('#month-select').addEventListener('change', e => go(C.Month.parse(e.target.value), currentPage().tracker));

const pagesOf = key => pager.querySelectorAll(`.page[data-month="${key}"]`);

function renderMonth(m, { journal = true, tracker = true } = {}) {
  const [jp, tp] = pagesOf(m.key);
  if (!jp) return;
  const first = !rendered.has(m.key);
  rendered.add(m.key);
  if (journal) jp.innerHTML = journalHTML(m);
  if (tracker) tp.innerHTML = trackerHTML(m);
  if (first && m.today) scrollToDay(jp, m.today);
}

/** Re-renders the visible month and its neighbours; others re-render when scrolled to. */
function refreshPages() {
  const cur = months.indexOf(currentPage().month);
  for (const key of [...rendered]) {
    const i = months.findIndex(m => m.key === key);
    if (Math.abs(i - cur) <= 1) renderMonth(months[i]);
    else rendered.delete(key);
  }
}

function scrollToDay(page, day) {
  const row = page.querySelector(`.row[data-day="${day}"]`);
  if (row) page.scrollTop = row.offsetTop - page.clientHeight / 2 + row.offsetHeight / 2;
  return row;
}

// MARK: - Journal page

function journalHTML(m) {
  const quote = data.quotes[m.key];
  const quoteCard = !data.showQuote ? '' : `
    <div class="quote">
      <svg class="mountains" viewBox="0 0 200 70" preserveAspectRatio="none" aria-hidden="true">
        <circle cx="160" cy="18" r="9" class="sun"/>
        <path d="M110 70 L144 31 L160 42 L180 21 L200 38 L200 70Z" class="m1"/>
        <path d="M124 70 L156 45 L176 52 L200 42 L200 70Z" class="m2"/>
      </svg>
      <div class="quote-label"><span class="q">❝</span> MONTHLY QUOTE</div>
      <p class="quote-text ${quote ? '' : 'placeholder'}">${esc(quote ?? "Tap the pencil to set this month's motto.")}</p>
      <button class="quote-edit" data-act="edit-quote" aria-label="Edit quote">${icon('pencil')}</button>
    </div>`;
  return `<div class="stack">${quoteCard}<div class="card rows">${m.days.map(d => rowHTML(m, d)).join('')}</div></div>`;
}

function rowHTML(m, d) {
  const key = m.dayKey(d);
  const text = data.entries[key] ?? '';
  const isToday = m.today === d;
  const future = m.isFuture || (m.today != null && d > m.today);
  return `<div class="row ${isToday ? 'today' : ''} ${future && !text ? 'future' : ''}" data-act="edit-entry" data-day="${d}" data-key="${key}">
    <div class="daybox"><b>${d}</b><small>${esc(m.weekday(d))}</small></div>
    <div class="entry ${text ? '' : 'empty'}">${esc(text || (future ? '' : 'Write about your day…'))}</div>
  </div>`;
}

function setEntry(key, text) {
  if (text.trim()) data.entries[key] = text; else delete data.entries[key];
  save();
}

/** Soft one-line entry: one truncated line; tap to edit the whole thing. Return finishes. */
function startEdit(row) {
  if (row.querySelector('textarea')) return;
  const key = row.dataset.key;
  const ta = document.createElement('textarea');
  ta.className = 'entry-input';
  ta.rows = 1;
  ta.placeholder = 'Write about your day…';
  ta.value = data.entries[key] ?? '';
  row.querySelector('.entry').replaceWith(ta);
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  fit();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('input', () => {
    if (ta.value.includes('\n')) ta.value = ta.value.replace(/\n/g, ' ');
    setEntry(key, ta.value);
    fit();
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ta.blur(); } });
  ta.addEventListener('blur', () => {
    const [m, d] = C.parseDayKey(key);
    const tpl = document.createElement('template');
    tpl.innerHTML = rowHTML(m, d);
    row.replaceWith(tpl.content.firstElementChild);
    renderMonth(m, { journal: false }); // insights count entries
  }, { once: true });
  // Keep the row above the on-screen keyboard.
  setTimeout(() => row.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
}

// MARK: - Tracker page

function trackerHTML(m) {
  const mode = C.pageMode(data, m);
  const stat = C.currentStat(data);
  return `<div class="stack">
    ${stat ? statCardHTML(m, stat) : ''}
    ${m.isFuture ? '' : insightsHTML(m)}
    <div class="segmented">${C.PAGE_MODES.map(([v, l]) => `<button class="${mode === v ? 'on' : ''}" data-act="mode" data-mode="${v}">${l}</button>`).join('')}</div>
    ${mode !== 'checklist' ? habitGridHTML(m) : ''}
    ${mode !== 'habits' ? checklistHTML(m) : ''}
  </div>`;
}

const lastDay = m => m.today ?? m.dayCount;
const statDay = m => Math.min(pickedDay[m.key] ?? lastDay(m), lastDay(m));
const dayLabel = (m, d) => d === m.today ? 'Today' : m.date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });

function niceStep(range) {
  const raw = range / 6, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

/** Display-only chart: green/red zones, dots joined in day order. */
function chartSVG(m, s) {
  const W = 340, H = 212, L = 36, R = 334, T = 8, B = 186;
  const [lo, hi] = C.statDomain(s);
  const n = m.dayCount;
  const x = v => L + (v - 0.5) / n * (R - L);
  const y = v => B - (v - lo) / (hi - lo) * (B - T);
  const clamp = v => Math.min(Math.max(v, lo), hi);
  const zone = (a, b, cls) => { const y1 = y(clamp(b)), y2 = y(clamp(a)); return y2 > y1 ? `<rect x="${L}" y="${y1}" width="${R - L}" height="${y2 - y1}" class="${cls}"/>` : ''; };
  const step = niceStep(hi - lo);
  const yTicks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) yTicks.push(+v.toFixed(6));
  const pts = m.days.filter(d => s.values[m.dayKey(d)] != null).map(d => [x(d), y(s.values[m.dayKey(d)])]);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.name)} chart">
    ${zone(lo, s.greenLow, 'z-red')}${zone(s.greenLow, s.greenHigh, 'z-green')}${zone(s.greenHigh, hi, 'z-red')}
    ${yTicks.map(v => `<line x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 5}" y="${y(v) + 3.5}" class="ylab">${esc(C.fmtNum(v) + s.unit)}</text>`).join('')}
    ${[1, 5, 10, 15, 20, 25].map(d => `<line x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${B}" class="grid"/><text x="${x(d)}" y="${B + 16}" class="xlab">${d}</text>`).join('')}
    ${pts.length > 1 ? `<polyline points="${pts.map(p => p.join(',')).join(' ')}" class="line"/>` : ''}
    ${pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="4" class="pt"/>`).join('')}
  </svg>`;
}

function statCardHTML(m, s) {
  const day = statDay(m);
  const value = s.values[m.dayKey(day)];
  const input = m.isFuture ? '' : `
    <div class="stat-input">
      <label class="capsule">${esc(dayLabel(m, day))} ${icon('updown', 'sm')}
        <select data-change="stat-day" aria-label="Day">${Array.from({ length: lastDay(m) }, (_, i) => lastDay(m) - i)
          .map(d => `<option value="${d}" ${d === day ? 'selected' : ''}>${esc(dayLabel(m, d))}</option>`).join('')}</select>
      </label>
      <span class="grow"></span>
      <button class="round" data-act="stat-nudge" data-dir="-1" aria-label="Less">${icon('minus')}</button>
      <button class="stat-value ${value == null ? 'empty' : ''}" data-act="stat-type">${value == null ? '—' : esc(C.fmtNum(value) + s.unit)}</button>
      <button class="round" data-act="stat-nudge" data-dir="1" aria-label="More">${icon('plus')}</button>
      <button class="clear ${value == null ? 'hidden' : ''}" data-act="stat-clear" aria-label="Clear">${icon('x')}</button>
    </div>`;
  return `<div class="card stat">
    <label class="stat-head">
      <span class="stat-icon">${statIcon(s)}</span><span class="h2">${esc(s.name)}</span>${icon('chev', 'sm muted')}
      <select data-change="stat" aria-label="Stat">${data.stats.map(x => `<option value="${x.id}" ${x.id === s.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    </label>
    ${chartSVG(m, s)}
    ${input}
  </div>`;
}

function insightsHTML(m) {
  const soFar = lastDay(m);
  const keys = Array.from({ length: soFar }, (_, i) => m.dayKey(i + 1));
  const isCurrent = m.equals(C.Month.current());
  const streak = n => n > 1 ? ` · 🔥 ${n} in a row` : '';
  const row = (ic, name, value) => `<div class="ins-row"><span class="ins-icon">${ic}</span><span class="ins-name">${esc(name)}</span><span class="ins-val">${esc(value)}</span></div>`;
  const written = keys.filter(k => data.entries[k]).length;
  let html = row('✍️', 'Journal', `${written}/${soFar} days` + (isCurrent ? streak(C.streak(k => !!data.entries[k])) : ''));
  const s = C.currentStat(data);
  if (s) {
    const vals = keys.map(k => s.values[k]).filter(v => v != null);
    const green = vals.filter(v => v >= s.greenLow && v <= s.greenHigh).length;
    const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '';
    html += row('📈', s.name, vals.length ? `avg ${avg}${s.unit} · ${green}/${vals.length} in green` : 'no data yet');
  }
  for (const h of data.habits) {
    html += row(h.icon, h.name, `${keys.filter(k => h.done.includes(k)).length}×` + (isCurrent ? streak(C.streak(k => h.done.includes(k))) : ''));
  }
  return `<div class="card insights"><div class="h3">This month</div>${html}</div>`;
}

function habitGridHTML(m) {
  if (!data.habits.length) return `<div class="card"><div class="h2">Habits</div><p class="muted">No habits yet — add some in Settings.</p></div>`;
  const cols = `grid-template-columns: 52px repeat(${data.habits.length}, 1fr)`;
  const isCurrent = m.equals(C.Month.current());
  const head = data.habits.map(h => {
    let badge = '';
    if (C.hasGoal(h) && isCurrent) { // a rolling goal only means something on the current month
      const met = C.goalMet(h, new Date());
      badge = `<span class="badge ${met ? 'met' : 'behind'}">${met ? '' : icon('warn', 'xs')}${C.windowCount(h, new Date())}/${h.windowTarget}</span>`;
    }
    return `<button class="hcol" data-act="habit-open" data-id="${h.id}"><span class="hicon">${esc(h.icon)}</span><span class="hname">${esc(h.name)}</span>${badge}</button>`;
  }).join('');
  const rows = m.days.map(d => {
    const key = m.dayKey(d);
    return `<div class="grow-row ${m.today === d ? 'today' : ''}" style="${cols}">
      <span class="gday"><b>${d}</b> <small>${esc(m.shortName)}</small></span>
      ${data.habits.map(h => {
        const done = h.done.includes(key);
        return `<button class="tick ${done ? 'done' : ''}" data-act="tick" data-id="${h.id}" data-key="${key}" aria-label="${esc(h.name)} ${d}" aria-pressed="${done}">${done ? icon('check') : ''}</button>`;
      }).join('')}
    </div>`;
  }).join('');
  return `<div class="card habits"><div class="h2">Habits</div><div class="ghead" style="${cols}"><span></span>${head}</div>${rows}</div>`;
}

function checklistHTML(m) {
  return `<div class="card checklist"><div class="h2">Checklist</div>${m.days.map(d => {
    const items = data.todos[m.dayKey(d)] ?? [];
    const done = items.filter(i => i.done).length;
    return `<button class="crow ${m.today === d ? 'today' : ''}" data-act="open-checklist" data-day="${d}">
      <span class="cday">${d}</span>
      <span class="ctext ${items.length ? '' : 'muted'}">${items.length ? esc(items.map(i => (i.done ? '✓ ' : '○ ') + i.text).join('   ')) : '—'}</span>
      ${items.length ? `<span class="ccount ${done === items.length ? 'all' : ''}">${done}/${items.length}</span>` : ''}
    </button>`;
  }).join('')}</div>`;
}

// MARK: - Sheets & dialogs

const sheets = [];

function openSheet({ title, left, right, render, onMount, ctx = {} }) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true">
    <header class="sheet-bar"><div class="bar-l"></div><h2></h2><div class="bar-r"></div></header>
    <div class="sheet-body"></div></div>`;
  const sheet = { wrap, ctx, title, left, right, render };
  sheet.bar = () => {
    $('h2', wrap).textContent = typeof sheet.title === 'function' ? sheet.title() : sheet.title;
    for (const [side, b] of [['.bar-l', sheet.left], ['.bar-r', sheet.right]]) {
      const slot = $(side, wrap);
      slot.innerHTML = '';
      const btn = typeof b === 'function' ? b() : b;
      if (!btn) continue;
      const el = document.createElement('button');
      el.className = 'bar-btn' + (btn.bold ? ' bold' : '');
      el.innerHTML = btn.html ?? esc(btn.label);
      el.onclick = btn.onClick;
      slot.append(el);
    }
  };
  sheet.update = () => { sheet.bar(); if (render) $('.sheet-body', wrap).innerHTML = render(sheet); };
  $('.backdrop', wrap).onclick = () => closeSheet(sheet);
  layers.append(wrap);
  sheets.push(sheet);
  sheet.update();
  onMount?.(sheet);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return sheet;
}

function closeSheet(sheet = sheets.at(-1)) {
  if (!sheet) return;
  sheets.splice(sheets.indexOf(sheet), 1);
  sheet.wrap.classList.remove('open');
  setTimeout(() => sheet.wrap.remove(), 250);
}
const closeAllSheets = () => [...sheets].reverse().forEach(closeSheet);
const refreshSheets = () => sheets.forEach(s => s.update());
const topSheet = () => sheets.at(-1);

/** Alert with optional text fields. Resolves to the field values (or true), or null on cancel. */
function ask({ title, message = '', fields = [], ok = 'OK', cancel = 'Cancel', destructive = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-wrap';
    wrap.innerHTML = `<form class="dialog" role="alertdialog" aria-modal="true">
      <h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
      ${fields.map(f => `<input type="${f.type ?? 'text'}" placeholder="${esc(f.placeholder ?? '')}" value="${esc(f.value ?? '')}"
        ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} autocomplete="off" autocapitalize="sentences">`).join('')}
      <div class="dialog-btns">${cancel ? `<button type="button" class="cancel">${esc(cancel)}</button>` : ''}
        <button type="submit" class="${destructive ? 'destructive' : 'default'}">${esc(ok)}</button></div>
    </form>`;
    const done = v => { wrap.remove(); resolve(v); };
    $('form', wrap).onsubmit = e => {
      e.preventDefault();
      done(fields.length ? [...wrap.querySelectorAll('input')].map(i => i.value) : true);
    };
    $('.cancel', wrap)?.addEventListener('click', () => done(null));
    layers.append(wrap);
    wrap.querySelector('input')?.focus();
  });
}
const info = message => ask({ title: 'Journal', message, cancel: null });

// MARK: - Search sheet

const TIPS = [
  ['pizza', 'words in entries and checklists'],
  ['workout september', 'days you ticked Workout in September'],
  ['sleep<6', 'nights under 6 hours (any stat works)'],
  ['-workout monday', 'Mondays without a workout'],
];

function openSearch() {
  openSheet({
    title: 'Search',
    right: { label: 'Done', bold: true, onClick: () => closeSheet() },
    render: () => `<div class="search-box">${icon('search', 'sm muted')}<input type="search" id="q" placeholder="Entries, habits, sleep<6, September…" autocomplete="off" autocorrect="off" spellcheck="false"></div><div id="results"></div>`,
    onMount: () => {
      const q = $('#q');
      const show = () => { $('#results').innerHTML = resultsHTML(q.value); };
      q.addEventListener('input', show);
      show();
      setTimeout(() => q.focus(), 50);
    },
  });
}

function resultsHTML(query) {
  if (!query.trim()) {
    return `<div class="group-title">Try</div><div class="group">${TIPS.map(([q, d]) =>
      `<button class="cell tip" data-act="tip" data-q="${esc(q)}"><code>${esc(q)}</code><small>${esc(d)}</small></button>`).join('')}</div>`;
  }
  const hits = C.search(data, query);
  if (!hits.length) return `<div class="empty-state">${icon('search', 'lg muted')}<b>No Results for “${esc(query)}”</b><span>Check the spelling or try a new search.</span></div>`;
  const words = query.split(/\s+/).filter(w => w && !w.startsWith('-') && !/[<>=]/.test(w)).map(C.fold);
  return `<div class="group-title">${hits.length} result${hits.length === 1 ? '' : 's'}</div><div class="group">${hits.map(h => `
    <button class="cell result" data-act="result" data-month="${h.month.key}" data-day="${h.day ?? ''}">
      <small class="rdate">${esc(h.day ? h.month.date(h.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : h.month.title)}</small>
      ${h.text ? `<span class="rtext">${highlight(h.text, words)}</span>` : ''}
      ${h.details.length ? `<small class="rdetails">${esc(h.details.join('  ·  '))}</small>` : ''}
    </button>`).join('')}</div>`;
}

/** Marks the first match of each word, ignoring case and accents. */
function highlight(text, words) {
  const folded = [...text].map(ch => C.fold(ch));
  const marks = new Array(folded.length).fill(false);
  for (const w of words) {
    const flat = folded.join('');
    const at = flat.indexOf(w);
    if (at < 0) continue;
    let pos = 0;
    folded.forEach((f, i) => { if (pos >= at && pos < at + w.length) marks[i] = true; pos += f.length; });
  }
  let out = '', open = false;
  [...text].forEach((ch, i) => {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(ch);
  });
  return out + (open ? '</mark>' : '');
}

function jumpTo(month, day) {
  go(month, false);
  if (!day) return;
  requestAnimationFrame(() => {
    const row = scrollToDay(pagesOf(month.key)[0], day);
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 1400);
  });
}

// MARK: - Checklist sheet

function openChecklist(m, day) {
  const key = m.dayKey(day);
  let editing = false;
  const sheet = openSheet({
    title: `${day} ${m.name}`,
    left: () => ({ label: editing ? 'Done' : 'Edit', onClick: () => { editing = !editing; sheet.update(); } }),
    right: { label: 'Done', bold: true, onClick: () => closeSheet() },
    ctx: { key, month: m },
    render: () => {
      const items = data.todos[key] ?? [];
      return `<div class="group">${items.map((it, i) => `
        <div class="cell todo" data-id="${it.id}">
          <button class="todo-check ${it.done ? 'done' : ''}" data-act="todo-toggle" aria-label="Done">${it.done ? icon('check') : ''}</button>
          <input class="todo-text ${it.done ? 'struck' : ''}" value="${esc(it.text)}" data-bind="todo-text" aria-label="Item">
          ${editing ? `<button class="mini" data-act="todo-move" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon('up')}</button>
            <button class="mini" data-act="todo-move" data-dir="1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Move down">${icon('down')}</button>
            <button class="mini danger" data-act="todo-del" aria-label="Delete">${icon('x')}</button>` : ''}
        </div>`).join('')}
        <div class="cell todo add"><span class="plus-dot">${icon('plus')}</span><input id="todo-add" placeholder="Add item" enterkeyhint="next" autocomplete="off"></div>
      </div>`;
    },
  });
  layers.addEventListener('keydown', function onKey(e) {
    if (!sheets.includes(sheet)) return layers.removeEventListener('keydown', onKey);
    if (e.target.id !== 'todo-add' || e.key !== 'Enter') return;
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    (data.todos[key] ??= []).push(C.newTodo(text));
    save();
    sheet.update();
    renderMonth(m, { journal: false });
    $('#todo-add').focus();
  });
  if (!(data.todos[key] ?? []).length) setTimeout(() => $('#todo-add')?.focus(), 50);
}

function todoOf(el) {
  const { key } = topSheet().ctx;
  const items = data.todos[key] ?? [];
  const i = items.findIndex(t => t.id === el.closest('[data-id]').dataset.id);
  return { key, items, i };
}

function todosChanged() {
  const { key, month } = topSheet().ctx;
  if (!data.todos[key]?.length) delete data.todos[key];
  save();
  topSheet().update();
  renderMonth(month, { journal: false });
}

// MARK: - Settings

let settingsEditing = false;

function openSettings() {
  settingsEditing = false;
  const sheet = openSheet({
    title: 'Settings',
    left: () => ({ label: settingsEditing ? 'Done' : 'Edit', onClick: () => { settingsEditing = !settingsEditing; sheet.update(); } }),
    right: { label: 'Done', bold: true, onClick: () => closeSheet() },
    render: settingsHTML,
  });
}

const toggle = (change, on, label) => `<label class="cell switch-cell"><span>${esc(label)}</span><input type="checkbox" class="switch" data-change="${change}" ${on ? 'checked' : ''}></label>`;
const select = (change, value, options, label) => `<label class="cell select-cell"><span>${esc(label)}</span><span class="select-wrap"><select data-change="${change}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${icon('updown', 'sm')}</span></label>`;
const section = (title, body, footer = '') => `<div class="group-title">${esc(title)}</div><div class="group">${body}</div>${footer ? `<p class="group-footer">${esc(footer)}</p>` : ''}`;

function listRows(items, kind, label, detail) {
  return items.map((x, i) => `<div class="cell list-row" data-id="${x.id}">
    ${settingsEditing ? `<button class="mini danger" data-act="${kind}-del" aria-label="Delete">${icon('minus')}</button>` : ''}
    <button class="list-main" data-act="${kind}-open">${label(x)}<span class="detail">${esc(detail(x))}</span>${settingsEditing ? '' : `<span class="chev-r">›</span>`}</button>
    ${settingsEditing ? `<button class="mini" data-act="${kind}-move" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon('up')}</button>
      <button class="mini" data-act="${kind}-move" data-dir="1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Move down">${icon('down')}</button>` : ''}
  </div>`).join('');
}

function settingsHTML() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return [
    section('Privacy', toggle('lock', vault.mode === 'passcode', 'Lock with passcode'),
      vault.mode === 'passcode'
        ? 'The passcode is what decrypts your journal, so while it\'s locked nothing is readable. If you forget it, the journal can\'t be recovered: keep an encrypted backup.'
        : 'Your journal is encrypted on this device (AES-256) and never leaves it. A passcode adds a lock screen and makes the encryption depend on something only you know.'),
    section('Appearance', select('appearance', data.appearance, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], 'Theme') + toggle('showQuote', data.showQuote, 'Monthly quote card')),
    section('Tracker', select('defaultMode', data.defaultPageMode, C.PAGE_MODES, 'Right page shows'), 'Default for new months. Each month can be switched on its tracker page.'),
    section('Habits', listRows(data.habits, 'habit', h => `<span class="li-icon">${esc(h.icon)}</span><span class="li-name">${esc(h.name)}</span>`,
      h => C.hasGoal(h) ? `${h.windowTarget}× / ${h.windowDays}d` : '') +
      `<button class="cell add-row" data-act="habit-add">${icon('plus')} Add habit</button>`, 'Deleting a habit deletes its history too. Use Edit to reorder.'),
    section('Stats', listRows(data.stats, 'stat', s => `<span class="li-icon">${statIcon(s)}</span><span class="li-name">${esc(s.name)}</span>`, () => '') +
      `<button class="cell add-row" data-act="stat-add">${icon('plus')} Add stat</button>`, 'Pick which stat the chart shows by tapping its name on the tracker page.'),
    section('Data', `<button class="cell add-row" data-act="export">🔒 Export encrypted backup</button><button class="cell add-row" data-act="import">⬇︎ Import backup</button>`,
      'Backups are protected with a password you choose. Without it, nobody (including you) can open the file. They also open in the iPhone app.'),
    standalone ? '' : `<p class="group-footer install">To install: tap Share, then “Add to Home Screen”. It then works fully offline.</p>`,
  ].join('');
}

// Habit editor

function openHabitEditor(id) {
  openSheet({
    title: () => data.habits.find(h => h.id === id)?.name || 'Habit',
    left: { html: `${icon('back', 'sm')} Back`, onClick: () => closeSheet() },
    ctx: { id },
    render: () => {
      const h = data.habits.find(h => h.id === id);
      if (!h) return '<p class="group-footer">This habit was deleted.</p>';
      const goal = C.hasGoal(h);
      return section('Habit', `<label class="cell field"><span>Name</span><input data-bind="habit-name" value="${esc(h.name)}"></label>
          <label class="cell field"><span>Icon</span><input data-bind="habit-icon" value="${esc(h.icon)}" class="emoji-input" aria-label="Icon (emoji)"></label>`) +
        section('Goal', toggle('habit-goal', goal, 'Rolling goal') + (goal ? `
          <div class="cell stepper"><span>At least ${h.windowTarget}×</span><span class="steps"><button data-act="habit-step" data-field="windowTarget" data-dir="-1" aria-label="Fewer">${icon('minus')}</button><button data-act="habit-step" data-field="windowTarget" data-dir="1" aria-label="More">${icon('plus')}</button></span></div>
          <div class="cell stepper"><span>in the last ${h.windowDays} days</span><span class="steps"><button data-act="habit-step" data-field="windowDays" data-dir="-1" aria-label="Fewer days">${icon('minus')}</button><button data-act="habit-step" data-field="windowDays" data-dir="1" aria-label="More days">${icon('plus')}</button></span></div>` : ''),
        "Counts backwards from today. When you're behind, the habit shows ⚠ on this month's tracker.") +
        `<div class="group"><button class="cell add-row danger" data-act="habit-del">Delete habit</button></div>`;
    },
  });
}

// Stat editor

function openStatEditor(id) {
  const num = (field, label) => {
    const s = data.stats.find(s => s.id === id);
    return `<label class="cell field"><span>${label}</span><input inputmode="decimal" data-bind="stat-num" data-field="${field}" value="${esc(C.fmtNum(s[field]))}"></label>`;
  };
  openSheet({
    title: () => data.stats.find(s => s.id === id)?.name || 'Stat',
    left: { html: `${icon('back', 'sm')} Back`, onClick: () => closeSheet() },
    ctx: { id },
    render: () => {
      const s = data.stats.find(s => s.id === id);
      if (!s) return '<p class="group-footer">This stat was deleted.</p>';
      return section('Stat', `<label class="cell field"><span>Name</span><input data-bind="stat-text" data-field="name" value="${esc(s.name)}"></label>
          <label class="cell field"><span>Unit</span><input data-bind="stat-text" data-field="unit" value="${esc(s.unit)}" placeholder="e.g. h, kg"></label>` +
          select('stat-icon', s.icon, Object.entries(STAT_ICONS).map(([k, e]) => [k, e]), 'Icon')) +
        section('Scale', num('min', 'Minimum') + num('max', 'Maximum') + num('step', 'Step')) +
        section('Green zone', num('greenLow', 'Green from') + num('greenHigh', 'Green to'), 'Values outside the green zone sit in the red zone.') +
        `<div class="group"><button class="cell add-row danger" data-act="stat-del">Delete stat</button></div>`;
    },
  });
}

const ctxId = () => topSheet()?.ctx.id;
const habitAt = el => data.habits.find(h => h.id === (el.closest('[data-id]')?.dataset.id ?? ctxId()));
const statAt = el => data.stats.find(s => s.id === (el.closest('[data-id]')?.dataset.id ?? ctxId()));

function move(list, item, dir) {
  const i = list.indexOf(item), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

/** After any change: save, redraw pages and open sheets. */
function changed() { save(); refreshPages(); refreshSheets(); }

// MARK: - Lock settings, backup

async function setLock(on) {
  if (on) {
    const r = await ask({
      title: 'Set a passcode', message: 'You\'ll enter it each time you open the journal. If you forget it, the journal can\'t be recovered.',
      fields: [{ type: 'password', placeholder: 'Passcode (4+ characters)' }, { type: 'password', placeholder: 'Repeat passcode' }], ok: 'Turn On',
    });
    if (!r) return refreshSheets();
    if (r[0].length < 4) { await info('Use at least 4 characters.'); return refreshSheets(); }
    if (r[0] !== r[1]) { await info('The passcodes don\'t match.'); return refreshSheets(); }
    const salt = C.randomBytes(16);
    vault = { mode: 'passcode', key: await C.passwordKey(r[0], salt), salt };
    data.appLock = true;
  } else {
    const r = await ask({ title: 'Turn off the lock?', message: 'Enter your passcode to confirm.', fields: [{ type: 'password', placeholder: 'Passcode' }], ok: 'Turn Off' });
    if (!r) return refreshSheets();
    const key = await C.passwordKey(r[0], vault.salt);
    try { await C.open(key, (await idb.get('vault')).blob); } catch { await info('Wrong passcode.'); return refreshSheets(); }
    vault = { mode: 'device', key: await C.newDeviceKey() };
    data.appLock = false;
  }
  await save(); // re-encrypts with the new key
  refreshSheets();
}

async function exportBackup() {
  const r = await ask({
    title: 'Backup password', message: 'You\'ll need this password to restore the backup.',
    fields: [{ type: 'password', placeholder: 'Password (6+ characters)' }, { type: 'password', placeholder: 'Repeat password' }], ok: 'Export',
  });
  if (!r) return;
  if (r[0].length < 6) return info('Use at least 6 characters.');
  if (r[0] !== r[1]) return info('The passwords don\'t match.');
  const bytes = await C.sealBackup(C.serialize(data), r[0]);
  const file = new File([bytes], `Journal backup ${C.dayKey(new Date())}.journalbackup`, { type: 'application/octet-stream' });
  // Sharing needs a fresh tap after the (slow, on purpose) key derivation.
  if (!await ask({ title: 'Backup ready', message: 'Save it somewhere safe, like Files or iCloud Drive.', ok: 'Save…' })) return;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  let incoming;
  if (C.isBackup(bytes)) {
    const r = await ask({ title: 'Backup password', fields: [{ type: 'password', placeholder: 'Password' }], ok: 'Open' });
    if (!r) return;
    try { incoming = C.normalize(JSON.parse(await C.openBackup(bytes, r[0]))); } catch { return info('Wrong password, or the file is damaged.'); }
  } else {
    try {
      incoming = C.normalize(JSON.parse(new TextDecoder().decode(bytes))); // an old unencrypted export
      if (!Object.keys(incoming.entries).length && !incoming.habits.length) throw new Error();
    } catch { return info('That isn\'t a Journal backup.'); }
  }
  const n = Object.keys(incoming.entries).length;
  if (!await ask({
    title: 'Replace your journal?', ok: 'Replace', destructive: true,
    message: `Everything in this app is replaced by the backup (${n} entr${n === 1 ? 'y' : 'ies'}). A copy of the current journal is kept on this device.`,
  })) return;
  await idb.set(`vault-before-import-${Date.now()}`, await idb.get('vault'));
  incoming.appLock = vault.mode === 'passcode';
  data = incoming;
  await save();
  closeAllSheets();
  applyTheme();
  buildPager();
  go(C.Month.current(), false);
});

// MARK: - Events

const monthOf = el => C.Month.parse(el.closest('[data-month]').dataset.month);

const ACTIONS = {
  search: openSearch,
  settings: openSettings,
  today: () => go(C.Month.current(), currentPage().tracker, true),

  'edit-entry': el => startEdit(el),
  'edit-quote': async el => {
    const m = monthOf(el);
    const r = await ask({ title: `Quote for ${m.name}`, fields: [{ placeholder: 'Small steps every day…', value: data.quotes[m.key] ?? '' }], ok: 'Save' });
    if (!r) return;
    if (r[0].trim()) data.quotes[m.key] = r[0].trim(); else delete data.quotes[m.key];
    save();
    renderMonth(m, { tracker: false });
  },

  'stat-nudge': el => {
    const m = monthOf(el), s = C.currentStat(data), key = m.dayKey(statDay(m)), v = s.values[key];
    // First press on an empty day starts from your previous value; after that, one step per press.
    s.values[key] = v == null ? C.startValue(s, key) : C.snapped(s, v + Number(el.dataset.dir) * s.step);
    save();
    renderMonth(m, { journal: false });
  },
  'stat-type': async el => {
    const m = monthOf(el), s = C.currentStat(data), day = statDay(m), key = m.dayKey(day);
    const r = await ask({ title: `${s.name} · ${dayLabel(m, day)}`, fields: [{ placeholder: s.unit ? `Value in ${s.unit}` : 'Value', inputmode: 'decimal', value: s.values[key] != null ? C.fmtNum(s.values[key]) : '' }], ok: 'Save' });
    const v = r && Number(r[0].replace(',', '.'));
    if (r && r[0].trim() && Number.isFinite(v)) { s.values[key] = C.snapped(s, v); save(); renderMonth(m, { journal: false }); }
  },
  'stat-clear': el => {
    const m = monthOf(el);
    delete C.currentStat(data).values[m.dayKey(statDay(m))];
    save();
    renderMonth(m, { journal: false });
  },

  mode: el => { const m = monthOf(el); data.pageModes[m.key] = el.dataset.mode; save(); renderMonth(m, { journal: false }); },
  tick: el => {
    const h = data.habits.find(h => h.id === el.dataset.id), key = el.dataset.key;
    h.done = h.done.includes(key) ? h.done.filter(k => k !== key) : [...h.done, key];
    save();
    refreshPages(); // goal badges look across month boundaries
  },
  'open-checklist': el => openChecklist(monthOf(el), Number(el.dataset.day)),

  'todo-toggle': el => { const { items, i } = todoOf(el); items[i].done = !items[i].done; todosChanged(); },
  'todo-del': el => { const { items, i } = todoOf(el); items.splice(i, 1); todosChanged(); },
  'todo-move': el => { const { items, i } = todoOf(el); move(items, items[i], Number(el.dataset.dir)); todosChanged(); },

  tip: el => { const q = $('#q'); q.value = el.dataset.q; q.dispatchEvent(new Event('input')); },
  result: el => { closeAllSheets(); jumpTo(C.Month.parse(el.dataset.month), Number(el.dataset.day) || null); },

  'habit-open': el => openHabitEditor(el.closest('[data-id]').dataset.id),
  'habit-add': () => { const h = C.newHabit(); data.habits.push(h); changed(); openHabitEditor(h.id); },
  'habit-move': el => { move(data.habits, habitAt(el), Number(el.dataset.dir)); changed(); },
  'habit-step': el => {
    const h = habitAt(el), d = Number(el.dataset.dir);
    if (el.dataset.field === 'windowTarget') h.windowTarget = Math.min(Math.max(h.windowTarget + d, 1), h.windowDays);
    else h.windowDays = Math.min(Math.max(h.windowDays + d, Math.max(2, h.windowTarget)), 60);
    changed();
  },
  'habit-del': async el => {
    const h = habitAt(el);
    if (!await ask({ title: `Delete “${h.name}”?`, message: 'Its history is deleted too.', ok: 'Delete', destructive: true })) return;
    data.habits = data.habits.filter(x => x !== h);
    if (topSheet()?.ctx.id === h.id) closeSheet();
    changed();
  },

  'stat-open': el => openStatEditor(el.closest('[data-id]').dataset.id),
  'stat-add': () => { const s = C.newStat(); data.stats.push(s); changed(); openStatEditor(s.id); },
  'stat-move': el => { move(data.stats, statAt(el), Number(el.dataset.dir)); changed(); },
  'stat-del': async el => {
    const s = statAt(el);
    if (!await ask({ title: `Delete “${s.name}”?`, message: 'All its values are deleted too.', ok: 'Delete', destructive: true })) return;
    data.stats = data.stats.filter(x => x !== s);
    if (topSheet()?.ctx.id === s.id) closeSheet();
    changed();
  },

  export: exportBackup,
  import: () => $('#import-file').click(),
};

const CHANGES = {
  stat: el => { data.selectedStat = el.value; save(); refreshPages(); },
  'stat-day': el => { const m = monthOf(el); pickedDay[m.key] = Number(el.value); renderMonth(m, { journal: false }); },
  appearance: el => { data.appearance = el.value; applyTheme(); changed(); },
  showQuote: el => { data.showQuote = el.checked; changed(); },
  defaultMode: el => { data.defaultPageMode = el.value; changed(); },
  lock: el => setLock(el.checked),
  'habit-goal': el => { const h = habitAt(el); [h.windowDays, h.windowTarget] = el.checked ? [7, 3] : [0, 0]; changed(); },
  'stat-icon': el => { statAt(el).icon = el.value; changed(); },
};

// Typing in a sheet: save and redraw the pages, but leave the sheet alone so the field keeps focus.
const BINDS = {
  'habit-name': el => { habitAt(el).name = el.value; },
  'habit-icon': el => { const g = lastGrapheme(el.value); habitAt(el).icon = g || '⭐️'; if (el.value !== g) el.value = g; },
  'stat-text': el => { statAt(el)[el.dataset.field] = el.value; },
  'stat-num': el => {
    const v = Number(el.value.replace(',', '.'));
    if (!el.value.trim() || !Number.isFinite(v)) return false;
    statAt(el)[el.dataset.field] = el.dataset.field === 'step' ? Math.max(v, 0.1) : v; // a zero step would break −/+
  },
  'todo-text': el => { const { items, i } = todoOf(el); items[i].text = el.value; },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) ACTIONS[el.dataset.act]?.(el, e);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el) CHANGES[el.dataset.change]?.(el);
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-bind]');
  if (!el || BINDS[el.dataset.bind]?.(el) === false) return;
  save();
  refreshPages();
  sheets.forEach(s => s.bar()); // titles follow the name
  if (el.dataset.bind === 'todo-text') renderMonth(topSheet().ctx.month, { journal: false });
});
// Redraw sheets after a field is left, so lists (e.g. habit names in Settings) catch up.
document.addEventListener('focusout', e => { if (e.target.closest?.('[data-bind]')) setTimeout(() => sheets.slice(0, -1).forEach(s => s.update())); });

boot();
