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
        setAttribute(name, value) { this[name] = value; }
        focus() { this.focused = true; }
        contains(target) { return target === this || this.children.some(child => child.contains(target)); }
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
    const requests = [], decodes = [], croppers = [], exports = [], alerts = [], canvases = [];
    const urls = new Map(), revoked = new Set();
    let nextUrl = 0;
    let resizeCanvas;
    const urlAPI = {
        createObjectURL(blob) { const url = `blob:${++nextUrl}`; urls.set(url, blob); return url; },
        revokeObjectURL(url) { revoked.add(url); }
    };
    const context = vm.createContext({
        document: {
            addEventListener() {},
            getElementById: element,
            querySelector: element,
            querySelectorAll: () => [],
            createElement: tag => {
                const element = new Element();
                if (tag === 'canvas') {
                    canvases.push(element);
                    element.getContext = () => ({ fillRect() {}, drawImage() {} });
                    element.toBlob = callback => exports.push(callback);
                }
                return element;
            },
            body: new Element()
        },
        Image: class {
            decode() {
                const file = urls.get(this.src);
                this.naturalWidth = file.width || 640;
                this.naturalHeight = file.height || 480;
                const task = deferred();
                decodes.push({ ...task, url: this.src });
                return task.promise;
            }
        },
        ResizeObserver: class {
            constructor(callback) { resizeCanvas = callback; }
            observe() {}
        },
        Cropper: class {
            constructor(image, options) {
                this.src = image.src;
                this.options = options;
                this.ready = true;
                croppers.push(this);
            }
            destroy() { this.destroyed = true; }
            setAspectRatio(ratio) { this.options.aspectRatio = ratio; }
            resize() { this.resizeCount = (this.resizeCount || 0) + 1; }
            rotateTo(angle) { this.rotation = angle; }
            scale(x, y) { this.horizontalScale = x; this.verticalScale = y; }
            scaleX(value) { this.horizontalScale = value; }
            scaleY(value) { this.verticalScale = value; }
            getData() { return { width: 640, height: 480 }; }
            getCroppedCanvas() { return { toBlob: callback => exports.push(callback) }; }
        },
        FormData: class {
            constructor() { this.entries = new Map(); }
            append(key, value, filename) { this.entries.set(key, { value, filename }); }
        },
        AbortController,
        Event,
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
        element, select, toggle, respond, decode, requests, decodes, croppers, exports, alerts, revoked, canvases,
        resizeCanvas: () => resizeCanvas(),
        applyImageTransform: () => vm.runInContext('applyImageTransform()', context),
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

test('switching and collapsing tools preserves the active cropper and edits', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const cropper = e.cropper();
    e.element('widthInput').value = '640';
    e.element('heightInput').value = '480';
    e.element('backgroundTool').click();
    assert.equal(e.element('cropPanel').hidden, true);
    assert.equal(e.element('backgroundPanel').hidden, false);
    assert.equal(e.element('backgroundTool')['aria-expanded'], 'true');
    e.element('backgroundTool').click();
    assert.equal(e.element('toolPanel').hidden, true);
    assert.equal(e.element('backgroundTool')['aria-expanded'], 'false');
    e.element('cropTool').click();
    assert.equal(e.element('toolPanel').hidden, false);
    assert.equal(e.element('cropPanel').hidden, false);
    assert.equal(e.element('widthInput').value, '640');
    assert.equal(e.element('heightInput').value, '480');
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
    assert.equal(e.requests.length, 0);
});

test('close and Escape collapse the panel and restore focus to its tool', () => {
    const e = editor();
    e.element('closeToolPanel').click();
    assert.equal(e.element('toolPanel').hidden, true);
    assert.equal(e.element('cropTool').focused, true);
    e.element('backgroundTool').click();
    const escape = new Event('keydown', { cancelable: true });
    escape.key = 'Escape';
    e.element('toolPanel').dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(e.element('toolPanel').hidden, true);
    assert.equal(e.element('backgroundTool').focused, true);
});

test('aspect-ratio dropdown updates the existing cropper without reloading the image', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const cropper = e.cropper();
    const preset = e.element('aspectRatioPreset');
    preset.value = '0.8';
    preset.dispatchEvent(new Event('change'));
    assert.equal(cropper.options.aspectRatio, 0.8);
    preset.value = 'free';
    preset.dispatchEvent(new Event('change'));
    assert.equal(Number.isNaN(cropper.options.aspectRatio), true);
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
});

test('image rail marks the selected image and restores the empty state after removal', () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    e.select({ name: 'B.png' }, false);
    const rail = e.element('batchImages');
    assert.equal(rail.children[0].firstElementChild['aria-pressed'], 'false');
    assert.equal(rail.children[1].firstElementChild['aria-pressed'], 'true');
    e.remove(1);
    assert.equal(rail.children[0].firstElementChild['aria-pressed'], 'true');
    assert.equal(rail.children[0].firstElementChild.focused, true);
    e.remove(0);
    assert.equal(e.element('batchEmptyState').hidden, false);
    assert.equal(e.element('batchUploadButton').focused, true);
});

test('canvas resizing waits for Cropper readiness and reuses the instance', async () => {
    const e = editor();
    e.resizeCanvas();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const cropper = e.cropper();
    cropper.ready = false;
    e.resizeCanvas();
    assert.equal(cropper.resizeCount, undefined);
    cropper.ready = true;
    e.element('cropTool').click();
    e.resizeCanvas();
    assert.equal(cropper.resizeCount, 1);
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
});

test('resolution inputs apply immediately without Enter, blur, or recreating the cropper', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const cropper = e.cropper();
    const width = e.element('widthInput');
    const height = e.element('heightInput');
    width.value = '1920';
    height.value = '700';
    height.dispatchEvent(new Event('input'));
    assert.equal(cropper.options.aspectRatio, 1920 / 700);
    assert.equal(e.element('aspectRatioPreset').value, 'custom');
    width.value = '700';
    width.dispatchEvent(new Event('input'));
    assert.equal(cropper.options.aspectRatio, 1);
    assert.equal(e.element('aspectRatioPreset').value, '1');
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
    assert.deepEqual(e.alerts, []);
});

test('incomplete or invalid resolution input leaves the last valid crop intact', async () => {
    const e = editor();
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const width = e.element('widthInput');
    const height = e.element('heightInput');
    width.value = '800';
    height.value = '1000';
    width.dispatchEvent(new Event('input'));
    for (const value of ['', '0', '-2', '2.5', 'invalid', 'Infinity']) {
        width.value = value;
        width.dispatchEvent(new Event('input'));
        assert.equal(e.cropper().options.aspectRatio, 0.8);
    }
    width.value = '900';
    width.dispatchEvent(new Event('input'));
    assert.equal(e.cropper().options.aspectRatio, 0.9);
    assert.deepEqual(e.alerts, []);
});

test('uploads and image switches initialize native dimensions with no preset', async () => {
    const e = editor();
    e.select({ name: 'square.png', width: 1151, height: 1151 }, false);
    await e.decode();
    assert.equal(e.element('widthInput').value, '1151');
    assert.equal(e.element('heightInput').value, '1151');
    assert.equal(e.element('aspectRatioPreset').value, 'free');
    assert.equal(Number.isNaN(e.cropper().options.aspectRatio), true);
    e.element('widthInput').value = '700';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.select({ name: 'portrait.png', width: 900, height: 1600 }, false);
    await e.decode();
    assert.equal(e.element('widthInput').value, '900');
    assert.equal(e.element('heightInput').value, '1600');
    assert.equal(e.element('aspectRatioPreset').value, 'free');
});

test('background reprocessing preserves custom dimensions and reset restores native dimensions', async () => {
    const e = editor();
    const file = { name: 'square.png', width: 1151, height: 1151 };
    e.select(file, false);
    await e.decode();
    e.element('widthInput').value = '700';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.toggle(true);
    await e.respond(e.requests[0], file);
    await e.decode();
    assert.equal(e.element('widthInput').value, '700');
    assert.equal(e.cropper().options.aspectRatio, 700 / 1151);
    e.element('resetButton').click();
    await e.respond(e.requests[1], file);
    await e.decode();
    assert.equal(e.element('widthInput').value, '1151');
    assert.equal(e.element('heightInput').value, '1151');
    assert.equal(e.element('aspectRatioPreset').value, 'free');
});

test('fixed presets synchronize output fields and exported canvas with the new crop', async () => {
    const e = editor();
    e.select({ name: 'wide.png', width: 1369, height: 500 }, false);
    await e.decode();
    const cropper = e.cropper();
    cropper.getData = () => ({ width: 499.6, height: 499.6 });
    const preset = e.element('aspectRatioPreset');
    for (const [value, width, height] of [['1', 500, 500], ['0.8', 500, 625], ['0.5625', 500, 889]]) {
        preset.value = value;
        preset.dispatchEvent(new Event('change'));
        assert.equal(e.element('widthInput').value, String(width));
        assert.equal(e.element('heightInput').value, String(height));
        assert.equal(preset.value, value);
        assert.equal(cropper.options.aspectRatio, Number(value));
        e.element('cropButton').click();
        assert.equal(e.canvases.at(-1).width, width);
        assert.equal(e.canvases.at(-1).height, height);
    }
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
});

test('Original restores native dimensions and None leaves output dimensions unchanged', async () => {
    const e = editor();
    e.select({ name: 'wide.png', width: 1369, height: 500 }, false);
    await e.decode();
    const preset = e.element('aspectRatioPreset');
    preset.value = '1';
    preset.dispatchEvent(new Event('change'));
    const width = e.element('widthInput').value;
    const height = e.element('heightInput').value;
    preset.value = 'free';
    preset.dispatchEvent(new Event('change'));
    assert.equal(e.element('widthInput').value, width);
    assert.equal(e.element('heightInput').value, height);
    assert.equal(Number.isNaN(e.cropper().options.aspectRatio), true);
    preset.value = 'original';
    preset.dispatchEvent(new Event('change'));
    assert.equal(e.element('widthInput').value, '1369');
    assert.equal(e.element('heightInput').value, '500');
    assert.equal(e.cropper().options.aspectRatio, 1369 / 500);
});

test('background swatches work without removal and preserve the selection across toggles', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('blackBg').click();
    assert.equal(e.cropper().options.fillColor, '#000000');
    e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    e.element('blackBg').click();
    assert.equal(e.cropper().options.fillColor, '#000000');
    assert.equal(e.element('blackBg')['aria-pressed'], 'true');
    assert.equal(e.element('transparentBg')['aria-pressed'], 'false');
    e.toggle(false);
    await e.decode();
    assert.equal(e.cropper().options.fillColor, '#000000');
    e.toggle(true);
    await e.respond(e.requests[1], { name: 'cutout again' });
    await e.decode();
    assert.equal(e.cropper().options.fillColor, '#000000');
});

test('custom colour previews on input without replacing the cropper, and transparency survives reset', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    const cropper = e.cropper();
    const picker = e.element('bgColor');
    let opened = false;
    picker.addEventListener('click', () => { opened = true; });
    e.element('customBg').click();
    assert.equal(opened, true);
    picker.value = '#e34a60';
    picker.dispatchEvent(new Event('input'));
    assert.equal(cropper.options.fillColor, '#e34a60');
    assert.equal(e.element('customBg')['aria-pressed'], 'true');
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
    e.element('whiteBg').click();
    assert.equal(cropper.options.fillColor, '#ffffff');
    e.element('transparentBg').click();
    assert.equal(cropper.options.fillColor, 'transparent');
    e.element('resetButton').click();
    await e.respond(e.requests[1], { name: 'reset cutout' });
    await e.decode();
    assert.equal(e.cropper().options.fillColor, 'transparent');
});


test('custom colour can be chosen before uploading with removal off', async () => {
    const e = editor();
    const picker = e.element('bgColor');
    picker.value = '#1256ab';
    picker.dispatchEvent(new Event('input'));
    e.select({ name: 'transparent.png' }, false);
    await e.decode();
    assert.equal(e.cropper().options.fillColor, '#1256ab');
    picker.value = '#abcdef';
    picker.dispatchEvent(new Event('input'));
    assert.equal(e.cropper().options.fillColor, '#abcdef');
    e.element('transparentBg').click();
    assert.equal(e.cropper().options.fillColor, 'transparent');
});

test('preset popup selects a ratio, updates dimensions, and returns focus to the field', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('presetTrigger').click();
    assert.equal(e.element('presetMenu').hidden, false);
    assert.equal(e.element('presetTrigger')['aria-expanded'], 'true');
    e.element('presetSquare').click();
    assert.equal(e.element('aspectRatioPreset').value, '1');
    assert.equal(e.element('widthInput').value, e.element('heightInput').value);
    assert.equal(e.element('presetValue').textContent, '1:1 (Square)');
    assert.equal(e.element('presetSquare')['aria-selected'], 'true');
    assert.equal(e.element('presetMenu').hidden, true);
    assert.equal(e.element('presetTrigger').focused, true);
});

test('preset popup supports arrow navigation and Escape without changing the selection', () => {
    const e = editor();
    e.element('presetTrigger').click();
    const down = new Event('keydown', { cancelable: true });
    down.key = 'ArrowDown';
    e.element('presetMenu').dispatchEvent(down);
    assert.equal(e.element('presetOriginal').focused, true);
    const escape = new Event('keydown', { cancelable: true });
    escape.key = 'Escape';
    e.element('presetMenu').dispatchEvent(escape);
    assert.equal(e.element('presetMenu').hidden, true);
    assert.equal(e.element('presetTrigger')['aria-expanded'], 'false');
    assert.equal(e.element('presetTrigger').focused, true);
});

test('rotation menu supports quarter turns and live precise angles without rebuilding the cropper', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const cropper = e.cropper();
    e.element('rotationTool').click();
    assert.equal(e.element('rotationPanel').hidden, false);
    assert.equal(e.element('toolPanelTitle').textContent, 'Rotate & flip');
    e.element('rotateRight').click();
    assert.equal(cropper.rotation, 90);
    assert.equal(e.element('rotationSlider').value, '90');
    e.element('rotateLeft').click();
    assert.equal(cropper.rotation, 0);
    const slider = e.element('rotationSlider');
    slider.value = '12.3';
    slider.dispatchEvent(new Event('input'));
    assert.equal(cropper.rotation, 12.3);
    assert.equal(e.element('rotationAngle').value, '12.3');
    const angle = e.element('rotationAngle');
    angle.value = '-7.5';
    angle.dispatchEvent(new Event('input'));
    assert.equal(cropper.rotation, -7.5);
    assert.equal(slider.value, '-7.5');
    for (const value of ['', '181', 'bad']) {
        angle.value = value;
        angle.dispatchEvent(new Event('input'));
        assert.equal(cropper.rotation, -7.5);
    }
    assert.equal(e.cropper(), cropper);
    assert.equal(cropper.destroyed, undefined);
});

test('flip controls toggle independently and background reprocessing preserves transforms', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('rotateRight').click();
    e.element('flipHorizontal').click();
    e.element('flipVertical').click();
    assert.equal(e.cropper().horizontalScale, -1);
    assert.equal(e.cropper().verticalScale, -1);
    e.element('flipHorizontal').click();
    assert.equal(e.cropper().horizontalScale, 1);
    assert.equal(e.element('flipHorizontal')['aria-pressed'], 'false');
    assert.equal(e.element('flipVertical')['aria-pressed'], 'true');
    e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    e.applyImageTransform();
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.cropper().horizontalScale, 1);
    assert.equal(e.cropper().verticalScale, -1);
    e.element('resetButton').click();
    await e.respond(e.requests[1], { name: 'reset' });
    await e.decode();
    e.applyImageTransform();
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.cropper().verticalScale, 1);
    assert.equal(e.element('rotationAngle').value, '0');
});

test('rotations wrap within the slider range and a new image starts untransformed', async () => {
    const e = editor();
    e.element('rotateRight').click();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    for (let i = 0; i < 3; i++) e.element('rotateRight').click();
    assert.equal(e.cropper().rotation, -90);
    e.select({ name: 'B.png' }, false);
    await e.decode();
    e.applyImageTransform();
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.element('rotationSlider').value, '0');
});
