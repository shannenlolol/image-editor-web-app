const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the page's real script with controllable network and image decoding.
// Fetch intentionally ignores aborts: stale results must be safe even without cancellation.
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function editor() {
    class Element extends EventTarget {
        constructor() {
            super();
            this.style = {};
            this.children = [];
            this.value = '';
            this.classList = { add() {}, remove() {} };
        }
        appendChild(child) { this.children.push(child); child.parent = this; }
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
        remove() { this.parent.removeChild(this); }
        removeAttribute(name) { delete this[name]; }
        get firstElementChild() { return this.children[0]; }
        click() {
            const event = new Event('click');
            if (this.onclick) this.onclick(event);
            this.dispatchEvent(event);
        }
    }
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const requests = [], decodes = [], croppers = [], exports = [], alerts = [];
    const urls = new Map(), revoked = new Set();
    let nextUrl = 0;
    const urlAPI = {
        createObjectURL(blob) { const url = `blob:${++nextUrl}`; urls.set(url, blob); return url; },
        revokeObjectURL(url) { revoked.add(url); }
    };
    const context = vm.createContext({
        document: {
            getElementById: element,
            querySelector: element,
            querySelectorAll: () => [],
            createElement: () => new Element(),
            body: new Element()
        },
        Image: class {
            decode() {
                const task = deferred();
                decodes.push({ ...task, url: this.src });
                return task.promise;
            }
        },
        Cropper: class {
            constructor(image, options) {
                this.src = image.src;
                this.options = options;
                croppers.push(this);
            }
            destroy() { this.destroyed = true; }
            getCroppedCanvas() { return { toBlob: callback => exports.push(callback) }; }
        },
        FormData: class {
            constructor() { this.entries = new Map(); }
            append(key, value, filename) { this.entries.set(key, { value, filename }); }
        },
        AbortController,
        URL: urlAPI,
        window: { URL: urlAPI },
        fetch(url, options) {
            const task = deferred();
            requests.push({ ...task, url, options });
            return task.promise;
        },
        alert: message => alerts.push(message),
        console: { error() {} },
        setTimeout
    });
    vm.runInContext(script, context);
    function select(file, removeBackground = true) {
        element('removeBg').checked = removeBackground;
        context.selectedFile = file;
        vm.runInContext('handleFiles([selectedFile])', context);
    }
    function toggle(checked) {
        element('removeBg').checked = checked;
        element('removeBg').dispatchEvent(new Event('change'));
    }
    async function respond(request, blob) {
        request.resolve({ blob: () => Promise.resolve(blob) });
        await flush();
    }
    async function decode(task = decodes.at(-1)) { task.resolve(); await flush(); }
    return {
        element, select, toggle, respond, decode, requests, decodes, croppers, exports, alerts, revoked,
        visibleImage: () => urls.get(element('image').src),
        filename: () => vm.runInContext('currentFileName', context),
        cropper: () => vm.runInContext('cropper', context),
        loading: () => element('loadingOverlay').style.display === 'flex',
        remove: index => element('batchImages').children[index].children[1].click()
    };
}

test('an older response cannot replace the latest image or filename', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.select({ name: 'B.png' });
    assert.equal(e.requests[0].options.signal.aborted, true);
    const result = { name: 'B without background' };
    await e.respond(e.requests[1], result);
    await e.decode();
    await e.respond(e.requests[0], { name: 'A without background' });
    assert.equal(e.visibleImage(), result);
    assert.equal(e.filename(), 'B.png');
    assert.equal(e.croppers.length, 1);
    assert.equal(e.loading(), false);
});

test('an older failure cannot dismiss the latest loading indicator or show an alert', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.select({ name: 'B.png' });
    e.requests[0].reject(new Error('Network failure'));
    await flush();
    assert.equal(e.loading(), true);
    assert.deepEqual(e.alerts, []);
    await e.respond(e.requests[1], { name: 'B result' });
    await e.decode();
    assert.equal(e.loading(), false);
});

test('a delayed response body cannot replace a newer completed selection', async () => {
    const e = editor(), body = deferred();
    e.select({ name: 'A.png' });
    e.requests[0].resolve({ blob: () => body.promise });
    await flush();
    const b = { name: 'B.png' };
    e.select(b, false);
    await e.decode();
    body.resolve({ name: 'A result' });
    await flush();
    assert.equal(e.visibleImage(), b);
    assert.equal(e.croppers.length, 1);
});

test('late image decoding cannot change the preview or end newer processing', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    await e.respond(e.requests[0], { name: 'A result' });
    const oldDecode = e.decodes[0];
    e.select({ name: 'B.png' });
    await e.decode(oldDecode);
    assert.equal(e.visibleImage(), undefined);
    assert.equal(e.loading(), true);
    assert.equal(e.revoked.has(oldDecode.url), true);
    await e.respond(e.requests[1], { name: 'B result' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'B result');
});

test('rapid on/off/on toggles use the latest setting, even for the same file', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.toggle(false);
    const originalDecode = e.decodes[0];
    e.toggle(true);
    await e.respond(e.requests[1], { name: 'latest removed background' });
    await e.decode();
    await e.decode(originalDecode);
    await e.respond(e.requests[0], { name: 'outdated removed background' });
    assert.equal(e.visibleImage().name, 'latest removed background');
    assert.equal(e.croppers.length, 1);
});

test('switching removal off keeps the original when the old request finishes', async () => {
    const e = editor(), file = { name: 'A.png' };
    e.select(file);
    e.toggle(false);
    await e.decode();
    await e.respond(e.requests[0], { name: 'removed background' });
    assert.equal(e.visibleImage(), file);
});

test('removing the last image invalidates its pending decode', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    await e.respond(e.requests[0], { name: 'A result' });
    e.remove(0);
    await e.decode();
    assert.equal(e.cropper(), null);
    assert.equal(e.filename(), '');
    assert.equal(e.visibleImage(), undefined);
    assert.equal(e.loading(), false);
    assert.equal(e.element('uploadPlaceholder').style.display, 'flex');
});

test('removing the selected image selects a remaining image and ignores the old request', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.select({ name: 'B.png' });
    e.remove(1);
    assert.equal(e.filename(), 'A.png');
    await e.respond(e.requests[1], { name: 'B result' });
    assert.equal(e.loading(), true);
    await e.respond(e.requests[2], { name: 'new A result' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'new A result');
});

test('removing an unselected thumbnail does not cancel the current request', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.select({ name: 'B.png' });
    e.remove(0);
    assert.equal(e.requests[1].options.signal.aborted, false);
    await e.respond(e.requests[1], { name: 'B result' });
    await e.decode();
    assert.equal(e.filename(), 'B.png');
});

test('the previous image cannot be exported while a new selection is processing', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const previous = e.cropper();
    e.select({ name: 'B.png' });
    e.element('cropButton').click();
    assert.equal(previous.destroyed, true);
    assert.equal(e.exports.length, 0);
});

test('a pending canvas export is discarded after selecting another image', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('cropButton').click();
    e.select({ name: 'B.png' });
    e.exports[0]({ name: 'A export' });
    assert.equal(e.requests.filter(r => r.url === '/upload-edited').length, 0);
});

test('a previous download cannot clear loading for a newly selected image', async () => {
    const e = editor();
    e.select({ name: 'A.jpg' }, false);
    await e.decode();
    e.element('cropButton').click();
    e.exports[0]({ name: 'A export' });
    const download = e.requests[0];
    assert.equal(download.options.body.entries.get('editedImage').filename, 'edited_A.png');
    e.select({ name: 'B.png' });
    await e.respond(download, { name: 'A download' });
    assert.equal(e.loading(), true);
    assert.equal(e.filename(), 'B.png');
});
