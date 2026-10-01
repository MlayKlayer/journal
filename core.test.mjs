// node web/core.test.mjs [path-to-ios-backup password]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from './core.js';

const m = new C.Month(2026, 9);

// Rolling window crosses month boundaries
const h = C.newHabit('Workout', '', 7, 3);
h.done = ['2026-08-27', '2026-08-31', '2026-09-02'];
assert.equal(C.windowCount(h, m.date(2)), 3);
assert.equal(C.windowCount(h, m.date(3)), 2);
assert.ok(!C.goalMet(h, m.date(3)));
assert.equal(new C.Month(2026, 2).dayCount, 28);
assert.equal(m.dayKey(5), '2026-09-05');

// Streaks
const done = new Set(['2026-09-28', '2026-09-29']);
assert.equal(C.streak(k => done.has(k), m.date(30)), 2);
assert.equal(C.streak(k => done.has(k), m.date(27)), 0);

// Search
const d = C.starter();
d.entries = { [m.dayKey(1)]: 'Pizza night with friends', [m.dayKey(2)]: 'Café by the river' };
d.stats[0].values = { [m.dayKey(1)]: 5, [m.dayKey(2)]: 8 };
d.habits[0].done = [m.dayKey(2)];
const days = q => C.search(d, q).map(x => x.day);
assert.deepEqual(days('pizza'), [1]);
assert.deepEqual(days('cafe'), [2]);
assert.deepEqual(days('sleep < 6'), [1]);
assert.deepEqual(days('sl>=8 workout'), [2]);
assert.deepEqual(days('-workout september'), [1]);
assert.deepEqual(days(''), []);

// Stat input
const sleep = C.starter().stats[0];
assert.equal(C.startValue(sleep, m.dayKey(5)), 7);
sleep.values = { [m.dayKey(2)]: 5.5, [m.dayKey(9)]: 9 };
assert.equal(C.startValue(sleep, m.dayKey(5)), 5.5);
assert.equal(C.snapped(sleep, 12.3), 12);
assert.equal(C.snapped(sleep, 0), 1);
assert.equal(C.snapped(sleep, 6.3), 6.5);

// Decoding: missing → defaults, present-but-broken → error
assert.ok(C.normalize({}));
assert.throws(() => C.normalize({ pageModes: { '2026-09': 'nope' } }));
assert.throws(() => C.normalize({ stats: [{ values: { x: 'seven' } }] }));
const roundTrip = C.normalize(JSON.parse(C.serialize({ ...d, pageModes: { [m.key]: 'both' } })));
assert.deepEqual(roundTrip.stats[0].values, d.stats[0].values);
assert.equal(roundTrip.pageModes[m.key], 'both');

// Encryption
const key = await C.newDeviceKey();
assert.equal(await C.open(key, await C.seal(key, 'hello')), 'hello');
const file = await C.sealBackup('hello', 'correct horse');
assert.equal(await C.openBackup(file, 'correct horse'), 'hello');
await assert.rejects(C.openBackup(file, 'wrong'));

// Optional: open a backup made by the iOS app
const [iosFile, password] = process.argv.slice(2);
if (iosFile) {
  const j = C.normalize(JSON.parse(await C.openBackup(new Uint8Array(readFileSync(iosFile)), password)));
  console.log('iOS backup opened:', Object.keys(j.entries).length, 'entries,', j.habits.map(h => h.name).join(', '),
    '| sleep', JSON.stringify(j.stats[0].values), '| pageModes', JSON.stringify(j.pageModes));
}
console.log('core: all checks passed');
