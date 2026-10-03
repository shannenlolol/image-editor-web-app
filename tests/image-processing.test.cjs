const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the page's real script with controllable network and image decoding.
// Fetch intentionally ignores aborts: stale results must be safe even without cancellation.
const html = fs.readFileSync(
    path.join(__dirname, '../templates/index.html'),
    'utf8',
);
const scripts = [
    ...html.matchAll(/<script src="(\/static\/[^" ]+\.js)"><\/script>/g),
].map(([, src]) => ({
    filename: src,
    source: fs.readFileSync(path.join(__dirname, '..', src), 'utf8'),
}));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
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
        appendChild(child) {
            this.children.push(child);
            child.parent = this;
        }
        removeChild(child) {
            this.children.splice(this.children.indexOf(child), 1);
        }
        remove() {
            this.parent.removeChild(this);
        }
        removeAttribute(name) {
            delete this[name];
        }
        setAttribute(name, value) {
            this[name] = value;
        }
        focus() {
            this.focused = true;
        }
        contains(target) {
            return (
                target === this ||
                this.children.some((child) => child.contains(target))
            );
        }
        querySelectorAll() {
            return [];
        }
        get clientWidth() {
            return 800;
        }
        get clientHeight() {
            return 600;
        }
        get firstElementChild() {
            return this.children[0];
        }
        click() {
            const event = new Event('click');
            if (this.onclick) this.onclick(event);
            this.dispatchEvent(event);
        }
    }
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const requests = [],
        decodes = [],
        croppers = [],
        exports = [],
        alerts = [],
        canvases = [];
    const urls = new Map(),
        revoked = new Set();
    const downloads = [];
    let nextUrl = 0;
    let resizeCanvas;
    const urlAPI = {
        createObjectURL(blob) {
            const url = `blob:${++nextUrl}`;
            urls.set(url, blob);
            return url;
        },
        revokeObjectURL(url) {
            revoked.add(url);
        },
    };
    const context = vm.createContext({
        document: {
            documentElement: { dataset: {} },
            addEventListener() {},
            getElementById: element,
            querySelector: (selector) => {
                const knownSelectors = [
                    '.cropper-view-box',
                    '.cropper-crop-box',
                    '.image-container',
                ];
                return knownSelectors.includes(selector) ? element(selector) : null;
            },
            querySelectorAll: () => [],
            createElement: (tag) => {
                const element = new Element();
                if (tag === 'a')
                    element.click = () =>
                        downloads.push({
                            filename: element.download,
                            blob: urls.get(element.href),
                        });
                if (tag === 'canvas') {
                    canvases.push(element);
                    element.getContext = () => ({
                        fillRect() {},
                        drawImage(source) {
                            element.renderedFrom = source;
                        },
                    });
                    element.toBlob = (callback) =>
                        exports.push(
                            Object.assign(callback, { canvas: element }),
                        );
                }
                return element;
            },
            body: new Element(),
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
            constructor(callback) {
                resizeCanvas = callback;
            }
            observe() {}
        },
        Cropper: class {
            constructor(image, options) {
                this.src = image.src;
                this.options = options;
                this.ready = false;
                this.data = { width: 640, height: 480 };
                croppers.push(this);
                queueMicrotask(() => {
                    if (!this.destroyed) {
                        this.ready = true;
                        options.ready();
                    }
                });
            }
            destroy() {
                this.destroyed = true;
            }
            setAspectRatio(ratio) {
                this.options.aspectRatio = ratio;
            }
            resize() {
                this.resizeCount = (this.resizeCount || 0) + 1;
            }
            rotateTo(angle) {
                this.rotation = angle;
            }
            scale(x, y) {
                this.horizontalScale = x;
                this.verticalScale = y;
            }
            scaleX(value) {
                this.horizontalScale = value;
            }
            scaleY(value) {
                this.verticalScale = value;
            }
            getData() {
                return {
                    ...this.data,
                    rotate: this.rotation || 0,
                    scaleX: this.horizontalScale || 1,
                    scaleY: this.verticalScale || 1,
                };
            }
            setData(data) {
                this.data = { ...data };
                this.rotation = data.rotate;
                this.horizontalScale = data.scaleX;
                this.verticalScale = data.scaleY;
            }
            getImageData() {
                const file = urls.get(this.src);
                return { naturalWidth: file.width || 640, naturalHeight: file.height || 480 };
            }
            zoomTo(value) {
                this.zoomLevel = value;
            }
            zoom(value) {
                this.zoomLevel = (this.zoomLevel || 0) + value;
            }
            getCroppedCanvas(options) {
                return {
                    source: urls.get(this.src).name,
                    data: this.getData(),
                    options,
                    toBlob: (callback) => exports.push(callback),
                };
            }
        },
        FormData: class {
            constructor() {
                this.entries = new Map();
            }
            append(key, value, filename) {
                this.entries.set(key, { value, filename });
            }
        },
        Blob,
        ArrayBuffer,
        Uint8Array,
        AbortController,
        Event,
        URL: urlAPI,
        window: Object.assign(new EventTarget(), { URL: urlAPI }),
        fetch(url, options) {
            const task = deferred();
            requests.push({ ...task, url, options });
            return task.promise;
        },
        alert: (message) => alerts.push(message),
        console: { error() {} },
        setTimeout,
        setImmediate,
    });
    for (const script of scripts)
        vm.runInContext(script.source, context, { filename: script.filename });
    function select(file, removeBackground = true) {
        element('removeBg').checked = removeBackground;
        context.selectedFile = file;
        context.window.ImageEditor.handleFiles([file]);
    }
    function toggle(checked) {
        element('removeBg').checked = checked;
        element('removeBg').dispatchEvent(new Event('change'));
    }
    async function respond(request, blob) {
        request.resolve({ ok: true, blob: () => Promise.resolve(blob) });
        await flush();
    }
    async function decode(task = decodes.at(-1)) {
        task.resolve();
        await flush();
    }
    return {
        leavingWouldPrompt: () => {
            const event = new Event('beforeunload', { cancelable: true });
            // BeforeUnloadEvent has a writable returnValue, unlike Node's Event.
            Object.defineProperty(event, 'returnValue', { value: '', writable: true });
            context.window.dispatchEvent(event);
            return event.defaultPrevented;
        },
        upload: (files) => context.window.ImageEditor.handleFiles(files),
        download: (all) => context.window.ImageEditor.downloadImages(all),
        element,
        select,
        toggle,
        respond,
        decode,
        requests,
        decodes,
        croppers,
        exports,
        alerts,
        revoked,
        canvases,
        downloads,
        resizeCanvas: () => resizeCanvas(),
        visibleImage: () => urls.get(element('image').src),
        filename: () => context.window.ImageEditor.selectedFileName,
        cropper: () => context.window.ImageEditor.cropper,
        loading: () => element('loadingOverlay').style.display === 'flex',
        remove: (index) =>
            element('batchImages').children[index].children[1].click(),
    };
}

test('leaving warns only while uploaded images remain, including during processing', async () => {
    const e = editor();
    assert.equal(e.leavingWouldPrompt(), false);
    e.select({ name: 'A.png' }, false);
    assert.equal(e.leavingWouldPrompt(), true);
    await e.decode();
    assert.equal(e.leavingWouldPrompt(), true);
    e.select({ name: 'B.png' }, false);
    await e.decode();
    e.remove(0);
    assert.equal(e.leavingWouldPrompt(), true);
    e.remove(0);
    assert.equal(e.leavingWouldPrompt(), false);
    e.select({ name: 'C.png' }, false);
    assert.equal(e.leavingWouldPrompt(), true);
});

test('discarding the last failed upload removes the leave warning', async () => {
    const e = editor();
    e.select({ name: 'broken.png' }, false);
    assert.equal(e.leavingWouldPrompt(), true);
    e.decodes[0].reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.leavingWouldPrompt(), false);
});

test('downloading keeps the leave warning while images remain in the editor', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    const pending = e.download();
    e.exports[0](new Blob(['png'], { type: 'image/png' }));
    await pending;
    assert.equal(e.downloads.length, 1);
    assert.equal(e.leavingWouldPrompt(), true);
});

test('upload rejection displays the server message and permits selecting another image', async () => {
    const e = editor();
    e.select({ name: 'large.png' });
    e.requests[0].resolve({
        ok: false,
        status: 413,
        json: async () => ({ message: 'Image is too large. Maximum decoded size is 25 megapixels.' }),
    });
    await flush();
    assert.match(e.alerts[0], /25 megapixels/);
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 0);
    e.select({ name: 'valid.png' }, false);
    await e.decode();
    assert.equal(e.filename(), 'valid.png');
    assert.equal(e.loading(), false);
});

test('non-JSON upload rejection has a useful fallback', async () => {
    const e = editor();
    e.select({ name: 'large.png' });
    e.requests[0].resolve({
        ok: false,
        status: 413,
        json: async () => { throw new SyntaxError('HTML response'); },
    });
    await flush();
    assert.match(e.alerts[0], /too large/);
    assert.equal(e.loading(), false);
});

test('a delayed validation error cannot interrupt a newer selection', async () => {
    const e = editor();
    const body = deferred();
    e.select({ name: 'large.png' });
    e.requests[0].resolve({ ok: false, status: 413, json: () => body.promise });
    await flush();
    e.select({ name: 'next.png' }, false);
    body.resolve({ message: 'Image is too large.' });
    await flush();
    assert.deepEqual(e.alerts, []);
    assert.equal(e.loading(), true);
    await e.decode();
    assert.equal(e.filename(), 'next.png');
});

test('network failure clears the failed upload and allows uploading it again', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.requests[0].reject(new TypeError('Failed to fetch'));
    await flush();
    assert.match(e.alerts[0], /connection.*upload the image again/);
    assert.equal(e.loading(), false);
    assert.equal(e.cropper(), null);
    assert.equal(e.element('downloadMenuButton').disabled, true);

    assert.equal(e.element('batchImages').children.length, 0);
    e.select({ name: 'A.png' });
    assert.equal(e.loading(), true);
    assert.equal(e.requests.length, 2);
    await e.respond(e.requests[1], { name: 'recovered' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'recovered');
    assert.equal(e.loading(), false);
    assert.equal(e.element('downloadMenuButton').disabled, false);
    assert.equal(e.alerts.length, 1);
});

test('HTTP server errors never reach decoding and allow retry', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.requests[0].resolve({
        ok: false,
        status: 500,
        json: async () => { throw new SyntaxError('HTML error page'); },
        blob: () => assert.fail('An HTTP error body must not be decoded as an image'),
    });
    await flush();
    assert.match(e.alerts[0], /Background removal failed.*try again/);
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 0);
    assert.equal(e.element('batchImages').children.length, 0);
    e.select({ name: 'A.png' });
    await e.respond(e.requests[1], { name: 'recovered' });
    await e.decode();
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('a failed response body read clears loading and allows selecting another image', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    e.requests[0].resolve({
        ok: true,
        blob: async () => { throw new TypeError('Connection lost'); },
    });
    await flush();
    assert.match(e.alerts[0], /read the processed image.*retry/);
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 0);
    e.select({ name: 'B.png' }, false);
    await e.decode();
    assert.equal(e.filename(), 'B.png');
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('invalid local images release their URL and allow selecting a valid image', async () => {
    const e = editor();
    e.select({ name: 'corrupt.png' }, false);
    const decode = e.decodes[0];
    decode.reject(new Error('EncodingError'));
    await flush();
    assert.match(e.alerts[0], /image could not be opened.*another image/);
    assert.equal(e.revoked.has(decode.url), true);
    assert.equal(e.loading(), false);
    assert.equal(e.cropper(), null);
    assert.equal(e.element('downloadMenuButton').disabled, true);
    e.select({ name: 'valid.png' }, false);
    await e.decode();
    assert.equal(e.visibleImage().name, 'valid.png');
    assert.equal(e.element('downloadMenuButton').disabled, false);
    assert.equal(e.requests.length, 0);
});

test('a failed lone upload restores the empty editor and releases both image URLs', async () => {
    const e = editor();
    e.element('imageInput').value = 'broken.HEIC';
    e.select({ name: 'broken.HEIC' }, false);
    const thumbnailUrl = e.element('batchImages').firstElementChild.firstElementChild.firstElementChild.src;
    const decode = e.decodes[0];
    e.element('widthInput').value = '123';
    e.element('heightInput').value = '456';
    decode.reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.element('batchImages').children.length, 0);
    assert.equal(e.element('batchImages').hidden, true);
    assert.equal(e.element('batchEmptyState').hidden, false);
    assert.equal(e.element('uploadPlaceholder').style.display, 'flex');
    assert.equal(e.element('widthInput').value, '');
    assert.equal(e.element('heightInput').value, '');
    assert.equal(e.element('aspectRatioPreset').value, 'original');
    assert.equal(e.element('imageInput').value, '');
    assert.equal(e.filename(), '');
    assert.equal(e.loading(), false);
    assert.equal(e.element('cropControls').disabled, true);
    assert.equal(e.element('downloadMenuButton').disabled, true);
    assert.equal(e.revoked.has(thumbnailUrl), true);
    assert.equal(e.revoked.has(decode.url), true);
});

test('discarding a failed upload preserves another image and its saved edits', async () => {
    const e = editor();
    e.select({ name: 'valid.png' }, false);
    await e.decode();
    e.element('widthInput').value = '300';
    e.element('heightInput').value = '200';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.element('rotateRight').click();
    e.select({ name: 'broken.HEIC' }, false);
    e.decodes.at(-1).reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.element('batchImages').children.length, 1);
    assert.equal(e.filename(), 'valid.png');
    assert.equal(e.loading(), true);
    await e.decode();
    assert.equal(e.visibleImage().name, 'valid.png');
    assert.equal(e.element('widthInput').value, '300');
    assert.equal(e.element('heightInput').value, '200');
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.element('uploadPlaceholder').style.display, 'none');
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('a batch of invalid uploads eventually restores the upload overlay', async () => {
    const e = editor();
    e.element('removeBg').checked = false;
    e.upload([{ name: 'bad1.png' }, { name: 'bad2.png' }]);
    e.decodes[0].reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.filename(), 'bad2.png');
    assert.equal(e.loading(), true);
    e.decodes[1].reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.element('batchImages').children.length, 0);
    assert.equal(e.element('uploadPlaceholder').style.display, 'flex');
    assert.equal(e.loading(), false);
});

test('an invalid processed image releases its URL and can be retried', async () => {
    const e = editor();
    e.select({ name: 'A.png' });
    await e.respond(e.requests[0], { name: 'invalid response' });
    const decode = e.decodes[0];
    decode.reject(new Error('EncodingError'));
    await flush();
    assert.match(e.alerts[0], /processed image could not be opened.*retry/);
    assert.equal(e.revoked.has(decode.url), true);
    assert.equal(e.loading(), false);
    assert.equal(e.cropper(), null);
    assert.equal(e.element('batchImages').children.length, 0);
    e.select({ name: 'A.png' });
    await e.respond(e.requests[1], { name: 'valid response' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'valid response');
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('a stale decoding failure cannot interrupt a newer image or its loading indicator', async () => {
    for (const finishNewImage of [false, true]) {
        const e = editor();
        e.select({ name: 'corrupt.png' }, false);
        const oldDecode = e.decodes[0];
        e.select({ name: 'valid.png' }, false);
        const newDecode = e.decodes[1];
        if (finishNewImage) await e.decode(newDecode);
        oldDecode.reject(new Error('EncodingError'));
        await flush();
        assert.deepEqual(e.alerts, []);
        assert.equal(e.loading(), !finishNewImage);
        assert.equal(e.revoked.has(oldDecode.url), true);
        assert.equal(e.revoked.has(newDecode.url), false);
        if (!finishNewImage) await e.decode(newDecode);
        assert.equal(e.visibleImage().name, 'valid.png');
        assert.equal(e.element('downloadMenuButton').disabled, false);
    }
});

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
    const e = editor(),
        body = deferred();
    e.select({ name: 'A.png' });
    e.requests[0].resolve({ ok: true, blob: () => body.promise });
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
    const e = editor(),
        file = { name: 'A.png' };
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
    e.element('downloadCurrent').click();
    assert.equal(previous.destroyed, true);
    assert.equal(e.exports.length, 0);
});

test('a current-image download keeps its snapshot when the user selects another image', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('downloadCurrent').click();
    e.select({ name: 'B.png' });
    const blob = new Blob(['A export']);
    e.exports[0](blob);
    await flush();
    assert.equal(e.downloads[0].filename, 'edited_A.png');
    assert.equal(e.downloads[0].blob, blob);
    assert.equal(e.loading(), true);
    assert.equal(e.filename(), 'B.png');
    assert.equal(
        e.requests.filter((r) => r.url === '/upload-edited').length,
        0,
    );
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

test('new uploads initialize native dimensions and the Original preset', async () => {
    const e = editor();
    e.select({ name: 'square.png', width: 1151, height: 1151 }, false);
    await e.decode();
    assert.equal(e.element('widthInput').value, '1151');
    assert.equal(e.element('heightInput').value, '1151');
    assert.equal(e.element('aspectRatioPreset').value, 'original');
    assert.equal(e.cropper().options.aspectRatio, 1);
    assert.equal(e.element('presetValue').textContent, 'Original');
    assert.equal(e.cropper().getData().x, 0);
    assert.equal(e.cropper().getData().y, 0);
    assert.equal(e.cropper().getData().width, 1151);
    assert.equal(e.cropper().getData().height, 1151);
    e.element('widthInput').value = '700';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.select({ name: 'portrait.png', width: 900, height: 1600 }, false);
    await e.decode();
    assert.equal(e.element('widthInput').value, '900');
    assert.equal(e.element('heightInput').value, '1600');
    assert.equal(e.element('aspectRatioPreset').value, 'original');
    assert.equal(e.cropper().options.aspectRatio, 900 / 1600);
    assert.equal(e.cropper().getData().width, 900);
    assert.equal(e.cropper().getData().height, 1600);
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
    assert.equal(e.element('aspectRatioPreset').value, 'original');
});

test('fixed presets synchronize output fields and exported canvas with the new crop', async () => {
    const e = editor();
    e.select({ name: 'wide.png', width: 1369, height: 500 }, false);
    await e.decode();
    const cropper = e.cropper();
    cropper.getData = () => ({ width: 499.6, height: 499.6 });
    const preset = e.element('aspectRatioPreset');
    for (const [value, width, height] of [
        ['1', 500, 500],
        ['0.8', 500, 625],
        ['0.5625', 500, 889],
    ]) {
        preset.value = value;
        preset.dispatchEvent(new Event('change'));
        assert.equal(e.element('widthInput').value, String(width));
        assert.equal(e.element('heightInput').value, String(height));
        assert.equal(preset.value, value);
        assert.equal(cropper.options.aspectRatio, Number(value));
        e.element('downloadCurrent').click();
        assert.equal(e.canvases.at(-1).width, width);
        assert.equal(e.canvases.at(-1).height, height);
        e.exports.at(-1)(new Blob(['png']));
        await flush();
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
    picker.addEventListener('click', () => {
        opened = true;
    });
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

test('a touch blur does not dismiss the preset before its click', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('presetTrigger').click();
    const blur = new Event('focusout');
    blur.relatedTarget = null;
    e.element('presetDropdown').dispatchEvent(blur);
    assert.equal(e.element('presetMenu').hidden, false);
    e.element('presetPortrait').click();
    assert.equal(e.element('aspectRatioPreset').value, '0.8');
    assert.equal(e.element('presetMenu').hidden, true);
});

test('a touch blur does not dismiss the download option before its click', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('downloadMenuButton').click();
    const blur = new Event('focusout');
    blur.relatedTarget = null;
    e.element('downloadControl').dispatchEvent(blur);
    assert.equal(e.element('downloadMenu').hidden, false);
    e.element('downloadCurrent').click();
    assert.equal(e.exports.length, 1);
    e.exports[0](new Blob(['png'], { type: 'image/png' }));
    await flush();
    assert.equal(e.downloads.length, 1);
    assert.equal(e.downloads[0].filename, 'edited_A.png');
    assert.equal(e.element('downloadMenu').hidden, true);
});

test('menus still close when keyboard focus moves to another control', async () => {
    const e = editor();
    e.select({ name: 'A.png' }, false);
    await e.decode();
    for (const [trigger, container, menu] of [
        ['presetTrigger', 'presetDropdown', 'presetMenu'],
        ['downloadMenuButton', 'downloadControl', 'downloadMenu'],
    ]) {
        e.element(trigger).click();
        const blur = new Event('focusout');
        blur.relatedTarget = e.element('zoomIn');
        e.element(container).dispatchEvent(blur);
        assert.equal(e.element(menu).hidden, true);
        assert.equal(e.element(trigger)['aria-expanded'], 'false');
    }
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
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.cropper().horizontalScale, 1);
    assert.equal(e.cropper().verticalScale, -1);
    e.element('resetButton').click();
    await e.respond(e.requests[1], { name: 'reset' });
    await e.decode();
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
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.element('rotationSlider').value, '0');
});

const JSZip = require('../static/vendor/jszip.min.js');
const imageFile = (name, contents = 'original bytes') =>
    Object.assign(new Blob([contents], { type: 'image/png' }), { name });

async function encodeExport(e, index) {
    const { canvas } = e.exports[index];
    const payload = JSON.stringify({
        width: canvas.width,
        height: canvas.height,
        ...canvas.renderedFrom,
    });
    e.exports[index](new Blob([payload], { type: 'image/png' }));
    await flush();
}

test('switching images restores each image’s dimensions, crop, rotation, flip, and background', async () => {
    const e = editor();
    e.select(imageFile('A.png'), false);
    await e.decode();
    e.element('widthInput').value = '300';
    e.element('heightInput').value = '200';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.element('rotateRight').click();
    e.element('flipHorizontal').click();
    e.element('blackBg').click();
    e.cropper().data = { x: 17, y: 29, width: 300, height: 200 };
    e.select(imageFile('B.png'), false);
    await e.decode();
    e.element('whiteBg').click();
    e.element('batchImages').children[0].click();
    await e.decode();
    assert.equal(e.element('widthInput').value, '300');
    assert.equal(e.element('heightInput').value, '200');
    assert.equal(e.element('rotationAngle').value, '90');
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.cropper().horizontalScale, -1);
    assert.equal(e.cropper().options.fillColor, '#000000');
    assert.equal(e.element('blackBg')['aria-pressed'], 'true');
    assert.equal(e.cropper().getData().x, 17);
    assert.equal(e.cropper().getData().y, 29);
});

test('ZIP contains per-image edits, unique filenames, and untouched original files', async () => {
    const e = editor();
    const original = imageFile('original.png', 'untouched image');
    e.element('removeBg').checked = false;
    e.upload([imageFile('same.png'), original]);
    await e.decode();
    e.element('widthInput').value = '300';
    e.element('heightInput').value = '200';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.element('blackBg').click();
    e.element('rotateRight').click();
    e.select(imageFile('same.png'), false);
    await e.decode();
    e.element('whiteBg').click();
    const active = e.cropper();
    const pending = e.download(true);
    assert.equal(e.element('downloadMenuButton').disabled, true);
    await encodeExport(e, 0);
    await encodeExport(e, 1);
    await pending;
    assert.equal(
        e.downloads.length,
        1,
        e.element('downloadStatus').textContent,
    );
    assert.equal(e.downloads[0].filename, 'edited_images.zip');
    const zip = await JSZip.loadAsync(await e.downloads[0].blob.arrayBuffer());
    assert.deepEqual(Object.keys(zip.files), [
        'edited_same.png',
        'original.png',
        'edited_same (2).png',
    ]);
    const first = JSON.parse(await zip.file('edited_same.png').async('string'));
    const second = JSON.parse(
        await zip.file('edited_same (2).png').async('string'),
    );
    assert.equal(first.width, 300);
    assert.equal(first.height, 200);
    assert.equal(first.options.fillColor, '#000000');
    assert.equal(first.data.rotate, 90);
    assert.equal(second.width, 640);
    assert.equal(second.options.fillColor, '#ffffff');
    assert.equal(second.data.rotate, 0);
    assert.equal(
        await zip.file('original.png').async('string'),
        'untouched image',
    );
    assert.equal(e.cropper(), active);
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('ZIP export is a snapshot and ignores duplicate submissions and later batch mutations', async () => {
    const e = editor();
    e.element('removeBg').checked = false;
    e.upload([imageFile('A.png'), imageFile('B.png', 'B original')]);
    await e.decode();
    const pending = e.download(true);
    await e.download(true);
    assert.equal(e.exports.length, 1);
    e.remove(1);
    e.select(imageFile('C.png'), false);
    await e.decode();
    await encodeExport(e, 0);
    await pending;
    const zip = await JSZip.loadAsync(await e.downloads[0].blob.arrayBuffer());
    assert.deepEqual(Object.keys(zip.files), ['edited_A.png', 'B.png']);
    assert.equal(e.filename(), 'C.png');
});

test('failed or incomplete exports report an error and never download a partial archive', async () => {
    const e = editor();
    await e.download(true);
    assert.equal(e.exports.length, 0);
    e.select(imageFile('A.png'), false);
    await e.decode();
    const pending = e.download(true);
    e.exports[0](null);
    await pending;
    assert.equal(e.downloads.length, 0);
    assert.match(e.element('downloadStatus').textContent, /encode/);
    assert.equal(e.element('downloadMenuButton').disabled, false);
    e.element('widthInput').value = '';
    await e.download(true);
    assert.equal(e.downloads.length, 0);
    assert.match(e.element('downloadStatus').textContent, /valid dimensions/);
});

test('a batch with interrupted background processing cannot silently export the original', async () => {
    const e = editor();
    e.select(imageFile('unfinished.png'));
    e.select(imageFile('ready.png'), false);
    await e.decode();
    await e.download(true);
    assert.equal(e.downloads.length, 0);
    assert.match(e.element('downloadStatus').textContent, /unfinished.png/);
});

test('background swatches and live custom colours update the visible crop preview', async () => {
    const e = editor();
    e.select(imageFile('transparent.png'), false);
    await e.decode();
    const preview = e.element('.cropper-view-box');
    e.element('blackBg').click();
    assert.equal(preview.style.background, '#000000');
    e.element('whiteBg').click();
    assert.equal(preview.style.background, '#ffffff');
    const picker = e.element('bgColor');
    picker.value = '#8c52ff';
    picker.dispatchEvent(new Event('input'));
    assert.equal(preview.style.background, '#8c52ff');
    assert.equal(e.cropper().options.fillColor, '#8c52ff');
    e.element('transparentBg').click();
    assert.match(preview.style.background, /repeating-conic-gradient/);
    assert.equal(e.cropper().options.fillColor, 'transparent');
});
