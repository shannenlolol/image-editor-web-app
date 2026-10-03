const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../static/theme.js'), 'utf8');

function page({ saved = null, dark = false, blocked = false } = {}) {
    const root = { dataset: {} };
    const toggle = new EventTarget();
    toggle.setAttribute = (key, value) => { toggle[key] = value; };
    const system = new EventTarget();
    system.matches = dark;
    let ready;
    let mounted = false;
    const storage = {
        getItem: () => { if (blocked) throw Error('Storage blocked'); return saved; },
        setItem: (_, value) => { if (blocked) throw Error('Storage blocked'); saved = value; },
    };
    vm.runInNewContext(source, {
        window: { matchMedia: () => system },
        localStorage: storage,
        document: {
            documentElement: root,
            getElementById: () => mounted ? toggle : null,
            addEventListener: (_, callback) => { ready = callback; },
        },
    });
    const initial = root.dataset.theme;
    mounted = true;
    ready();
    return {
        root, toggle, initial,
        saved: () => saved,
        click: () => toggle.dispatchEvent(new Event('click')),
        systemChange: (dark) => {
            system.matches = dark;
            system.dispatchEvent(new Event('change'));
        },
    };
}

test('system theme is applied before the toggle exists and follows system changes', () => {
    const p = page({ dark: true });
    assert.equal(p.initial, 'dark');
    assert.equal(p.toggle['aria-pressed'], 'true');
    p.systemChange(false);
    assert.equal(p.root.dataset.theme, 'light');
    assert.equal(p.toggle['aria-pressed'], 'false');
});

test('explicit selection persists across reloads and overrides the system', () => {
    const p = page();
    p.click();
    assert.equal(p.saved(), 'dark');
    assert.equal(p.toggle.title, 'Switch to light mode');
    p.systemChange(false);
    assert.equal(p.root.dataset.theme, 'dark');
    const reload = page({ saved: p.saved() });
    assert.equal(reload.initial, 'dark');
    reload.click();
    assert.equal(reload.saved(), 'light');
    assert.equal(reload.toggle['aria-pressed'], 'false');
});

test('blocked storage does not prevent switching themes', () => {
    const p = page({ blocked: true, dark: true });
    p.click();
    assert.equal(p.root.dataset.theme, 'light');
    p.systemChange(true);
    assert.equal(p.root.dataset.theme, 'light');
});

test('invalid saved preferences fall back to the system theme', () => {
    assert.equal(page({ saved: 'invalid', dark: true }).initial, 'dark');
    assert.equal(page({ saved: 'light', dark: true }).initial, 'light');
});
