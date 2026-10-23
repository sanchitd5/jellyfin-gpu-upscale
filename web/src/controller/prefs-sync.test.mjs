// Run: node web/src/controller/prefs-sync.test.mjs   (no framework; exits non-zero on failure)
// Integration test of controller/prefs-sync.js with a fake localStorage and a fake jellyfin-web UserSettings.
import assert from 'node:assert/strict';

class FakeStorage {
    constructor() { this.m = new Map(); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
}
const ls = new FakeStorage();
globalThis.window = globalThis;
globalThis.Storage = FakeStorage;
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });

const timers = [];
let nextId = 1;
globalThis.setTimeout = (fn, ms) => { const t = { id: nextId++, fn, ms }; timers.push(t); return t.id; };
globalThis.clearTimeout = (id) => { const t = timers.find((x) => x.id === id); if (t) t.fn = null; };
function runTimers() { let n = 0; while (timers.length) { const t = timers.shift(); if (t.fn) { t.fn(); n++; } } return n; }

const { noteUserSettings, installPrefsSync } = await import('./prefs-sync.js');
const { state } = await import('../model/state.js');
const { encode } = await import('../model/prefs-sync.js');

let passed = 0;
async function t(name, fn) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

function makeSettings() {
    const sets = [];
    const s = {
        currentUserId: null,
        displayPrefs: null,
        saved: sets,
        setUserInfo(uid) { s.currentUserId = uid; s.displayPrefs = { CustomPrefs: Object.assign({}, s.server || {}) }; return Promise.resolve(); },
        get() {}, loadQuerySettings() {},
        set(k, v) { sets.push([k, v]); s.displayPrefs.CustomPrefs[k] = v; s.server = Object.assign(s.server || {}, { [k]: v }); },
        server: {}
    };
    return s;
}

const inst = makeSettings();
const KEY = 'jellyfinPlusPrefs';

// Module export objects as webpack would hand them: the instance sits under some minified name.
await t('noteUserSettings finds the instance by shape, among unrelated exports', () => {
    noteUserSettings({ a: 1, b: () => 1, c: {} });
    noteUserSettings({ x: { setUserInfo() {}, get() {} }, ay: inst, z: 5 });
    installPrefsSync();
    assert.equal(timers.length >= 1, true);
});

const sig = (o) => JSON.stringify(o);

await t('boot: nothing runs against the network and localStorage is untouched until a user is set', () => {
    runTimers();
    assert.equal(inst.saved.length, 0);
});

// Device already has prefs, server has none -> after setUserInfo the local value is pushed once.
ls.setItem(KEY, sig({ stage: 'custom', upscale: '1080', pos: { x: 5, y: 6 } }));
await t('first login, server empty: local prefs are pushed, without the panel position', async () => {
    await inst.setUserInfo('u1');
    // setUserInfo wrapped? call through the wrapped one
    inst.displayPrefs = null;
    await inst.setUserInfo('u1');
    runTimers();
    const pushed = inst.saved.filter(([k]) => k === 'jellyfinPlus.prefs');
    assert.equal(pushed.length, 1);
    const env = JSON.parse(pushed[0][1]);
    assert.equal(JSON.parse(env.v).pos, undefined);
    assert.equal(JSON.parse(env.v).upscale, '1080');
    assert.ok(env.t > 0);
});

await t('a position-only change (panel drag) does not push', () => {
    inst.saved.length = 0;
    ls.setItem(KEY, sig({ stage: 'custom', upscale: '1080', pos: { x: 99, y: 99 } }));
    runTimers();
    assert.equal(inst.saved.length, 0);
});

await t('a real change pushes once, after the debounce, with a fresh time', () => {
    inst.saved.length = 0;
    ls.setItem(KEY, sig({ stage: 'custom', upscale: '2160', pos: { x: 99, y: 99 } }));
    assert.equal(inst.saved.length, 0, 'not synchronously');
    runTimers();
    assert.equal(inst.saved.length, 1);
    assert.equal(JSON.parse(JSON.parse(inst.saved[0][1]).v).upscale, '2160');
});

await t('server newer than local: adopted on the next login, the local panel position kept, state reloaded', async () => {
    inst.saved.length = 0;
    const theirs = { stage: 'unset', upscale: '720' };
    inst.server['jellyfinPlus.prefs'] = encode(JSON.stringify(theirs), Date.now() + 60000);
    await inst.setUserInfo('u1');
    runTimers();
    const now = JSON.parse(ls.getItem(KEY));
    assert.equal(now.upscale, '720');
    assert.deepEqual(now.pos, { x: 99, y: 99 });
    assert.equal(state.prefs.upscale, '720');
    assert.equal(inst.saved.length, 0, 'adopting must not push back');
});

await t('local newer than server: pushed on login', async () => {
    inst.saved.length = 0;
    inst.server['jellyfinPlus.prefs'] = encode(JSON.stringify({ stage: 'unset', upscale: '480' }), 1000);
    inst.displayPrefs = null;                                       // offline edit: nothing can be pushed yet
    ls.setItem(KEY, sig({ stage: 'custom', upscale: '1440' }));   // local write now (meta = now)
    runTimers();
    assert.equal(inst.saved.length, 0);
    await inst.setUserInfo('u1');
    runTimers();
    assert.ok(inst.saved.some(([k, v]) => k === 'jellyfinPlus.prefs' && JSON.parse(JSON.parse(v).v).upscale === '1440'));
});

await t('another user on the same browser has their own record: their server copy is adopted, not overwritten', async () => {
    inst.saved.length = 0;
    inst.server['jellyfinPlus.prefs'] = encode(JSON.stringify({ stage: 'unset', upscale: '300' }), 5);
    await inst.setUserInfo('u2');
    runTimers();
    assert.equal(JSON.parse(ls.getItem(KEY)).upscale, '300');
    assert.equal(inst.saved.length, 0);
});

await t('search paging: cleared locally (removeItem) syncs as null; empty string is kept distinct', async () => {
    inst.saved.length = 0;
    ls.setItem('jellyfinPlus.searchPaging', 'paged');
    runTimers();
    assert.deepEqual(JSON.parse(inst.saved.at(-1)[1]).v, 'paged');
    inst.saved.length = 0;
    ls.setItem('jellyfinPlus.searchPaging', '');
    runTimers();
    assert.equal(JSON.parse(inst.saved.at(-1)[1]).v, '');
    inst.saved.length = 0;
    ls.removeItem('jellyfinPlus.searchPaging');
    runTimers();
    assert.equal(JSON.parse(inst.saved.at(-1)[1]).v, null);
});

await t('keys that are not synced never reach the server', () => {
    inst.saved.length = 0;
    ls.setItem('jellyfinPlusOpen', '{}');
    ls.setItem('jellyfinPlus.searchExclude', 'x');
    ls.setItem('somethingElse', '1');
    runTimers();
    assert.equal(inst.saved.length, 0);
});

await t('garbage on the server is ignored, not adopted', async () => {
    inst.saved.length = 0;
    const before = ls.getItem('jellyfinPlus.searchPageSize');
    inst.server['jellyfinPlus.searchPageSize'] = 'not an envelope';
    await inst.setUserInfo('u2');
    runTimers();
    assert.equal(ls.getItem('jellyfinPlus.searchPageSize'), before);
});

await t('a storage that throws never breaks the write', () => {
    const orig = ls.getItem;
    ls.getItem = () => { throw new Error('denied'); };
    assert.doesNotThrow(() => ls.setItem(KEY, '{"stage":"x"}'));
    ls.getItem = orig;
    runTimers();
});

console.log(passed + ' passed');
