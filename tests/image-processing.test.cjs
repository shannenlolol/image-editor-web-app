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
]
    // The real Cropper needs a DOM and would replace the fake Cropper below.
    .filter(([, src]) => src !== '/static/vendor/cropper.min.js')
    .map(([, src]) => ({
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

function editor({ webpEncoding = true } = {}) {
    class Element extends EventTarget {
        constructor() {
            super();
            // Custom properties are stored under their own name, like other styles.
            this.style = {
                setProperty(name, value) {
                    this[name] = value;
                },
            };
            this.children = [];
            this.value = '';
            this.dataset = {};
            const classes = new Set();
            this.classList = {
                add: (name) => classes.add(name),
                remove: (name) => classes.delete(name),
                toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
                contains: (name) => classes.has(name),
            };
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
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 800, height: 600 };
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
        canvases = [],
        bitmaps = [];
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
    const documentEvents = new EventTarget();
    const context = vm.createContext({
        document: {
            documentElement: { dataset: {} },
            addEventListener: (...args) => documentEvents.addEventListener(...args),
            getElementById: element,
            querySelector: (selector) => {
                const knownSelectors = [
                    '.cropper-view-box',
                    '.cropper-crop-box',
                    '.cropper-face',
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
                    // Pixel reads return the last drawn source's `pixels`, so tests
                    // can check mask compositing on tiny images.
                    element.draws = [];
                    // Other drawing calls (the brush's paths and transforms) are
                    // recorded as [name, ...args] so tests can check what was painted.
                    element.ops = [];
                    const recordOthers = {
                        get: (target, key) =>
                            key in target ? target[key] : (...args) => element.ops.push([key, ...args]),
                    };
                    element.getContext = () => new Proxy({
                        fillRect() {},
                        clearRect() {},
                        drawImage(source, ...position) {
                            element.renderedFrom = source;
                            element.draws.push({ source, position });
                        },
                        getImageData: (x, y, width, height) => ({
                            data: Uint8ClampedArray.from(
                                element.renderedFrom.pixels ||
                                    new Uint8ClampedArray(width * height * 4),
                            ),
                        }),
                        putImageData(imageData) {
                            element.putPixels = imageData.data;
                        },
                    }, recordOthers);
                    // Browsers without an encoder return a PNG data URL instead.
                    element.toDataURL = (type) =>
                        type === 'image/webp' && webpEncoding
                            ? 'data:image/webp;base64,'
                            : 'data:image/png;base64,';
                    element.toBlob = (callback, type, quality) =>
                        exports.push(
                            Object.assign(callback, { canvas: element, type, quality }),
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
        // Upload preparation and mask compositing decode here; Image.decode is
        // reserved for the editor preview. Files without dimensions stand in for
        // formats the browser cannot decode, which use the server's cut-out.
        createImageBitmap: async (file) => {
            if (!file.width || file.undecodable) throw new Error('InvalidStateError');
            const bitmap = {
                width: file.width,
                height: file.height,
                pixels: file.pixels,
                close() {
                    this.closed = true;
                },
            };
            bitmaps.push(bitmap);
            return bitmap;
        },
        ResizeObserver: class {
            constructor(callback) {
                resizeCanvas = callback;
            }
            observe() {}
        },
        Cropper: class {
            constructor(image, options) {
                this.image = image;
                // `src` is the image the cropper was built on (it sets the natural
                // size); `url` is the one on screen after replace().
                this.src = image.src;
                this.url = image.src;
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
            replace(url, hasSameSize) {
                this.replacements = (this.replacements || 0) + 1;
                this.hasSameSize = hasSameSize;
                this.url = url;
                this.image.src = url;
            }
            setAspectRatio(ratio) {
                this.options.aspectRatio = ratio;
            }
            setDragMode(mode) {
                this.options.dragMode = mode;
            }
            // Tests resize the stage by setting `nextContainer` before resizing.
            resize() {
                this.resizeCount = (this.resizeCount || 0) + 1;
                if (this.nextContainer) this.containerData = this.nextContainer;
            }
            getContainerData() {
                return { ...(this.containerData || { width: 800, height: 600 }) };
            }
            setCanvasData(data) {
                this.canvasData = data;
            }
            setCropBoxData(data) {
                this.cropBoxData = data;
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
                // `displayWidth` is set by tests that check where the image is shown.
                return {
                    naturalWidth: file.width || 640,
                    naturalHeight: file.height || 480,
                    width: this.displayWidth,
                };
            }
            getCanvasData() {
                return this.canvasData;
            }
            getCropBoxData() {
                return this.cropBoxData || {};
            }
            zoomTo(value) {
                this.zoomLevel = value;
            }
            zoom(value) {
                this.zoomLevel = (this.zoomLevel || 0) + value;
            }
            // Tests set `croppedPixels` to check what the download does to them.
            getCroppedCanvas(options) {
                return {
                    pixels: this.croppedPixels,
                    source: urls.get(this.url).name,
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
    // New uploads open with removal off. Turning it on while the original is
    // still loading restarts the load with removal, as a quick user would; this
    // waits for the upload shrinking step, so the request is sent on return.
    async function select(file, removeBackground = true) {
        context.selectedFile = file;
        context.window.ImageEditor.handleFiles([file]);
        await flush();
        if (removeBackground) await toggle(true);
    }
    async function toggle(checked) {
        element('removeBg').checked = checked;
        element('removeBg').dispatchEvent(new Event('change'));
        await flush();
    }
    async function respond(request, blob) {
        request.resolve({ ok: true, blob: () => Promise.resolve(blob) });
        await flush();
    }
    async function decode(task = decodes.at(-1)) {
        task.resolve();
        await flush();
    }
    // Node's Event has no clipboardData, so attach a minimal one.
    async function paste(files) {
        const event = new Event('paste', { cancelable: true });
        event.clipboardData = { files };
        documentEvents.dispatchEvent(event);
        await flush();
        return event.defaultPrevented;
    }
    return {
        paste,
        leavingWouldPrompt: () => {
            const event = new Event('beforeunload', { cancelable: true });
            // BeforeUnloadEvent has a writable returnValue, unlike Node's Event.
            Object.defineProperty(event, 'returnValue', { value: '', writable: true });
            context.window.dispatchEvent(event);
            return event.defaultPrevented;
        },
        upload: (files) => context.window.ImageEditor.handleFiles(files),
        window: context.window,
        download: (all, format) =>
            context.window.ImageEditor.downloadImages(all, format),
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
        bitmaps,
        downloads,
        resizeCanvas: () => resizeCanvas(),
        // Node's EventTarget does not bubble, so present the key as coming from target.
        keydown(key, modifiers = {}, target = context.document.body) {
            const event = Object.assign(
                new Event('keydown', { cancelable: true }),
                { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
                modifiers,
            );
            Object.defineProperty(event, 'target', { value: target });
            documentEvents.dispatchEvent(event);
            return event.defaultPrevented;
        },
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
    await e.select({ name: 'A.png' }, false);
    assert.equal(e.leavingWouldPrompt(), true);
    await e.decode();
    assert.equal(e.leavingWouldPrompt(), true);
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    e.remove(0);
    assert.equal(e.leavingWouldPrompt(), true);
    e.remove(0);
    assert.equal(e.leavingWouldPrompt(), false);
    await e.select({ name: 'C.png' }, false);
    assert.equal(e.leavingWouldPrompt(), true);
});

test('discarding the last failed upload removes the leave warning', async () => {
    const e = editor();
    await e.select({ name: 'broken.png' }, false);
    assert.equal(e.leavingWouldPrompt(), true);
    e.decodes[0].reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.leavingWouldPrompt(), false);
});

test('downloading keeps the leave warning while images remain in the editor', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    const pending = e.download();
    e.exports[0](new Blob(['png'], { type: 'image/png' }));
    await pending;
    assert.equal(e.downloads.length, 1);
    assert.equal(e.leavingWouldPrompt(), true);
});

// The usual flow: the original opens with removal off, then the switch is turned on.
async function openThenRemove(e, file) {
    await e.select(file, false);
    await e.decode();
    await e.toggle(true);
}


test('upload rejection displays the server message and keeps the original to retry', async () => {
    const e = editor();
    const file = { name: 'large.png' };
    await openThenRemove(e, file);
    const cropper = e.cropper();
    e.requests[0].resolve({
        ok: false,
        status: 413,
        json: async () => ({ message: 'Image is too large. Maximum decoded size is 25 megapixels.' }),
    });
    await flush();
    assert.match(e.alerts[0], /25 megapixels/);
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 1);
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.cropper(), cropper);
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('backgroundControls').disabled, false);
    assert.equal(e.element('downloadMenuButton').disabled, false);
    await e.toggle(true);
    assert.equal(e.requests.length, 2);
});

test('non-JSON upload rejection has a useful fallback', async () => {
    const e = editor();
    await openThenRemove(e, { name: 'large.png' });
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
    await e.select({ name: 'large.png' });
    e.requests[0].resolve({ ok: false, status: 413, json: () => body.promise });
    await flush();
    await e.select({ name: 'next.png' }, false);
    body.resolve({ message: 'Image is too large.' });
    await flush();
    assert.deepEqual(e.alerts, []);
    assert.equal(e.loading(), true);
    await e.decode();
    assert.equal(e.filename(), 'next.png');
});

test('network failure keeps the image and lets the switch try again', async () => {
    const e = editor();
    const file = { name: 'A.png' };
    await openThenRemove(e, file);
    e.requests[0].reject(new TypeError('Failed to fetch'));
    await flush();
    assert.match(e.alerts[0], /connection.*try again/);
    assert.equal(e.loading(), false);
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.element('batchImages').children.length, 1);
    assert.equal(e.element('downloadMenuButton').disabled, false);

    await e.toggle(true);
    assert.equal(e.loading(), true);
    assert.equal(e.requests.length, 2);
    await e.respond(e.requests[1], { name: 'recovered' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'recovered');
    assert.equal(e.loading(), false);
    assert.equal(e.element('downloadMenuButton').disabled, false);
    assert.equal(e.alerts.length, 1);
});

test('a removal that fails while the image opens shows the original with removal off', async () => {
    const e = editor();
    const file = { name: 'A.png' };
    await e.select(file);
    e.requests[0].reject(new TypeError('Failed to fetch'));
    await flush();
    assert.match(e.alerts[0], /connection/);
    assert.equal(e.element('removeBg').checked, false);
    await e.decode();
    assert.equal(e.visibleImage(), file);
    assert.equal(e.loading(), false);
    assert.equal(e.element('batchImages').children.length, 1);
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('HTTP server errors never reach decoding and allow retry', async () => {
    const e = editor();
    await openThenRemove(e, { name: 'A.png' });
    e.requests[0].resolve({
        ok: false,
        status: 500,
        json: async () => { throw new SyntaxError('HTML error page'); },
        blob: () => assert.fail('An HTTP error body must not be decoded as an image'),
    });
    await flush();
    assert.match(e.alerts[0], /Background removal failed.*try again/);
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 1);
    await e.toggle(true);
    await e.respond(e.requests[1], { name: 'recovered' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'recovered');
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('a failed response body read clears loading and keeps the original', async () => {
    const e = editor();
    const file = { name: 'A.png' };
    await openThenRemove(e, file);
    e.requests[0].resolve({
        ok: true,
        blob: async () => { throw new TypeError('Connection lost'); },
    });
    await flush();
    assert.match(e.alerts[0], /read the processed image.*try again/);
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 1);
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('invalid local images release their URL and allow selecting a valid image', async () => {
    const e = editor();
    await e.select({ name: 'corrupt.png' }, false);
    const decode = e.decodes[0];
    decode.reject(new Error('EncodingError'));
    await flush();
    assert.match(e.alerts[0], /image could not be opened.*another image/);
    assert.equal(e.revoked.has(decode.url), true);
    assert.equal(e.loading(), false);
    assert.equal(e.cropper(), null);
    assert.equal(e.element('downloadMenuButton').disabled, true);
    await e.select({ name: 'valid.png' }, false);
    await e.decode();
    assert.equal(e.visibleImage().name, 'valid.png');
    assert.equal(e.element('downloadMenuButton').disabled, false);
    assert.equal(e.requests.length, 0);
});

test('a failed lone upload restores the empty editor and releases both image URLs', async () => {
    const e = editor();
    e.element('imageInput').value = 'broken.HEIC';
    await e.select({ name: 'broken.HEIC' }, false);
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
    await e.select({ name: 'valid.png' }, false);
    await e.decode();
    e.element('widthInput').value = '300';
    e.element('heightInput').value = '200';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.element('rotateRight').click();
    await e.select({ name: 'broken.HEIC' }, false);
    e.decodes.at(-1).reject(new Error('EncodingError'));
    await flush();
    assert.equal(e.element('batchImages').children.length, 1);
    assert.equal(e.filename(), 'valid.png');
    // The earlier image is already decoded, so it reopens without loading.
    assert.equal(e.loading(), false);
    assert.equal(e.decodes.length, 2);
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
    const file = { name: 'A.png' };
    await openThenRemove(e, file);
    await e.respond(e.requests[0], { name: 'invalid response' });
    const decode = e.decodes[1];
    decode.reject(new Error('EncodingError'));
    await flush();
    assert.match(e.alerts[0], /processed image could not be opened.*try again/);
    assert.equal(e.revoked.has(decode.url), true);
    assert.equal(e.loading(), false);
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('batchImages').children.length, 1);
    // The server's result is kept, so retrying only decodes it again.
    await e.toggle(true);
    assert.equal(e.requests.length, 1);
    await e.decode();
    assert.equal(e.visibleImage().name, 'invalid response');
    assert.equal(e.element('downloadMenuButton').disabled, false);
});

test('a stale decoding failure cannot interrupt a newer image or its loading indicator', async () => {
    for (const finishNewImage of [false, true]) {
        const e = editor();
        await e.select({ name: 'corrupt.png' }, false);
        const oldDecode = e.decodes[0];
        await e.select({ name: 'valid.png' }, false);
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
    await e.select({ name: 'A.png' });
    await e.select({ name: 'B.png' });
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
    await e.select({ name: 'A.png' });
    await e.select({ name: 'B.png' });
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
    await e.select({ name: 'A.png' });
    e.requests[0].resolve({ ok: true, blob: () => body.promise });
    await flush();
    const b = { name: 'B.png' };
    await e.select(b, false);
    await e.decode();
    body.resolve({ name: 'A result' });
    await flush();
    assert.equal(e.visibleImage(), b);
    assert.equal(e.croppers.length, 1);
});

test('late image decoding cannot change the preview or end newer processing', async () => {
    const e = editor();
    await e.select({ name: 'A.png' });
    await e.respond(e.requests[0], { name: 'A result' });
    const oldDecode = e.decodes[0];
    await e.select({ name: 'B.png' });
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
    await e.select({ name: 'A.png' });
    await e.toggle(false);
    const originalDecode = e.decodes[0];
    await e.toggle(true);
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
    await e.select(file);
    await e.toggle(false);
    await e.decode();
    await e.respond(e.requests[0], { name: 'removed background' });
    assert.equal(e.visibleImage(), file);
});

test('removing the last image invalidates its pending decode', async () => {
    const e = editor();
    await e.select({ name: 'A.png' });
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
    await e.select({ name: 'A.png' });
    await e.select({ name: 'B.png' });
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
    await e.select({ name: 'A.png' });
    await e.select({ name: 'B.png' });
    e.remove(0);
    assert.equal(e.requests[1].options.signal.aborted, false);
    await e.respond(e.requests[1], { name: 'B result' });
    await e.decode();
    assert.equal(e.filename(), 'B.png');
});

test('the previous image cannot be exported while a new selection is processing', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    const previous = e.cropper();
    await e.select({ name: 'B.png' });
    e.element('downloadCurrent').click();
    assert.equal(previous.destroyed, true);
    assert.equal(e.exports.length, 0);
});

test('a current-image download keeps its snapshot when the user selects another image', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('downloadCurrent').click();
    await e.select({ name: 'B.png' });
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

test('the hand pans the crop view, including inside the crop box, and survives a new image', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    assert.equal(e.cropper().options.toggleDragModeOnDblclick, false);
    e.element('panToggle').click();
    assert.equal(e.element('panToggle')['aria-pressed'], 'true');
    assert.equal(e.cropper().options.dragMode, 'move');
    assert.equal(e.element('.cropper-face').dataset.cropperAction, 'move');
    assert.equal(e.element('dropZone').classList.contains('panning'), true);
    // A new cropper starts in crop mode, so the hand is applied again when it is ready.
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    assert.equal(e.cropper().options.dragMode, 'move');
    e.element('panToggle').click();
    assert.equal(e.element('panToggle')['aria-pressed'], 'false');
    assert.equal(e.cropper().options.dragMode, 'crop');
    assert.equal(e.element('.cropper-face').dataset.cropperAction, 'all');
});

test('switching and collapsing tools preserves the active cropper and edits', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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

test('image rail marks the selected image and restores the empty state after removal', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.select({ name: 'B.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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

test('a wider stage keeps the picture\'s size, and a narrower one shrinks it only to fit', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    const cropper = e.cropper();
    cropper.canvasData = { left: 100, top: 50, width: 600, height: 400 };
    cropper.cropBoxData = { left: 150, top: 100, width: 500, height: 300 };
    // Closing the side panel: 200 px wider. Same size, still centred.
    cropper.nextContainer = { width: 1000, height: 600 };
    e.resizeCanvas();
    assert.deepEqual({ ...cropper.canvasData }, { left: 200, top: 50, width: 600, height: 400 });
    assert.deepEqual({ ...cropper.cropBoxData }, { left: 250, top: 100, width: 500, height: 300 });
    // Back to 800 px: it still fits, so nothing shrinks.
    cropper.nextContainer = { width: 800, height: 600 };
    e.resizeCanvas();
    assert.deepEqual({ ...cropper.canvasData }, { left: 100, top: 50, width: 600, height: 400 });
    // 500 px wide: the 600 px picture must shrink to fit 450 px (25 px margins).
    cropper.nextContainer = { width: 500, height: 600 };
    e.resizeCanvas();
    assert.deepEqual({ ...cropper.canvasData }, { left: 25, top: 112.5, width: 450, height: 300 });
    assert.deepEqual({ ...cropper.cropBoxData }, { left: 62.5, top: 150, width: 375, height: 225 });
});

test('resolution inputs apply immediately without Enter, blur, or recreating the cropper', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'square.png', width: 1151, height: 1151 }, false);
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
    await e.select({ name: 'portrait.png', width: 900, height: 1600 }, false);
    await e.decode();
    assert.equal(e.element('widthInput').value, '900');
    assert.equal(e.element('heightInput').value, '1600');
    assert.equal(e.element('aspectRatioPreset').value, 'original');
    assert.equal(e.cropper().options.aspectRatio, 900 / 1600);
    assert.equal(e.cropper().getData().width, 900);
    assert.equal(e.cropper().getData().height, 1600);
});

test('background removal preserves custom dimensions and reset restores native dimensions', async () => {
    const e = editor();
    const file = { name: 'square.png', width: 1151, height: 1151 };
    await e.select(file, false);
    await e.decode();
    e.element('widthInput').value = '700';
    e.element('widthInput').dispatchEvent(new Event('input'));
    await e.toggle(true);
    await e.respond(e.requests[0], file);
    // Decodable images get a mask back, composited onto the original in the browser.
    assert.equal(e.requests[0].url, '/remove-bg/mask');
    await finishCutout(e, file);
    assert.equal(e.element('widthInput').value, '700');
    assert.equal(e.cropper().options.aspectRatio, 700 / 1151);
    e.element('resetButton').click();
    await flush();
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.element('widthInput').value, '1151');
    assert.equal(e.element('heightInput').value, '1151');
    assert.equal(e.element('aspectRatioPreset').value, 'original');
});

test('fixed presets synchronize output fields and exported canvas with the new crop', async () => {
    const e = editor();
    await e.select({ name: 'wide.png', width: 1369, height: 500 }, false);
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
    await e.select({ name: 'wide.png', width: 1369, height: 500 }, false);
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
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('blackBg').click();
    assert.equal(e.cropper().options.fillColor, '#000000');
    await e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    e.element('blackBg').click();
    assert.equal(e.cropper().options.fillColor, '#000000');
    assert.equal(e.element('blackBg')['aria-pressed'], 'true');
    assert.equal(e.element('transparentBg')['aria-pressed'], 'false');
    await e.toggle(false);
    await e.decode();
    assert.equal(e.cropper().options.fillColor, '#000000');
    await e.toggle(true);
    assert.equal(e.requests.length, 1);
    await e.decode();
    assert.equal(e.visibleImage().name, 'cutout');
    assert.equal(e.cropper().options.fillColor, '#000000');
});

test('custom colour previews on input without replacing the cropper, and transparency survives reset', async () => {
    const e = editor();
    await e.select({ name: 'A.png' });
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
    await flush();
    assert.equal(e.requests.length, 1);
    await e.decode();
    assert.equal(e.cropper().options.fillColor, 'transparent');
});

test('custom colour can be chosen before uploading with removal off', async () => {
    const e = editor();
    const picker = e.element('bgColor');
    picker.value = '#1256ab';
    picker.dispatchEvent(new Event('input'));
    await e.select({ name: 'transparent.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.select({ name: 'A.png' }, false);
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
    await e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.cropper().horizontalScale, 1);
    assert.equal(e.cropper().verticalScale, -1);
    e.element('resetButton').click();
    await flush();
    assert.equal(e.requests.length, 1);
    await e.decode();
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.cropper().verticalScale, 1);
    assert.equal(e.element('rotationAngle').value, '0');
});

test('rotations wrap within the slider range and a new image starts untransformed', async () => {
    const e = editor();
    e.element('rotateRight').click();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    for (let i = 0; i < 3; i++) e.element('rotateRight').click();
    assert.equal(e.cropper().rotation, -90);
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.element('rotationSlider').value, '0');
});

const JSZip = require('../static/vendor/jszip.min.js');
const imageFile = (name, contents = 'original bytes') =>
    Object.assign(new Blob([contents], { type: 'image/png' }), { name });

// Resolve the canvas encode at the end of mask compositing, then the preview decode.
async function finishCutout(e, result) {
    e.exports.at(-1)(result);
    await flush();
    await e.decode();
}

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
    await e.select(imageFile('A.png'), false);
    await e.decode();
    e.element('widthInput').value = '300';
    e.element('heightInput').value = '200';
    e.element('widthInput').dispatchEvent(new Event('input'));
    e.element('rotateRight').click();
    e.element('flipHorizontal').click();
    e.element('blackBg').click();
    e.cropper().data = { x: 17, y: 29, width: 300, height: 200 };
    await e.select(imageFile('B.png'), false);
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
    await e.select(imageFile('same.png'), false);
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
    await e.select(imageFile('C.png'), false);
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
    await e.select(imageFile('A.png'), false);
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
    await e.select(imageFile('unfinished.png'));
    await e.select(imageFile('ready.png'), false);
    await e.decode();
    await e.download(true);
    assert.equal(e.downloads.length, 0);
    assert.match(e.element('downloadStatus').textContent, /unfinished.png/);
});

test('background swatches and live custom colours update the visible crop preview', async () => {
    const e = editor();
    await e.select(imageFile('transparent.png'), false);
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

test('large photos are downscaled in the browser before background removal', async () => {
    const e = editor();
    const file = { name: 'phone.jpg', type: 'image/jpeg', width: 4032, height: 3024 };
    await e.select(file);
    assert.equal(e.requests.length, 0);
    const toBlob = e.exports.at(-1);
    assert.equal(toBlob.canvas.width, 2048);
    assert.equal(toBlob.canvas.height, 1536);
    assert.equal(toBlob.canvas.renderedFrom.width, 4032);
    assert.equal(toBlob.type, 'image/jpeg');
    const shrunk = { name: 'shrunk' };
    toBlob(shrunk);
    await flush();
    assert.deepEqual(e.requests[0].options.body.entries.get('file'), {
        value: shrunk,
        filename: 'phone.jpg',
    });
});

test('downscaled images that may be transparent are uploaded as PNG', async () => {
    const e = editor();
    await e.select({ name: 'tall.webp', type: 'image/webp', width: 1000, height: 3000 });
    const toBlob = e.exports.at(-1);
    assert.equal(toBlob.canvas.width, 683);
    assert.equal(toBlob.canvas.height, 2048);
    assert.equal(toBlob.type, 'image/png');
});

test('images within the size limit and undecodable files are uploaded unchanged', async () => {
    for (const file of [
        { name: 'edge.png', width: 2048, height: 1000 },
        { name: 'odd.heic', width: 5000, height: 5000, undecodable: true },
    ]) {
        const e = editor();
        // The brush view's canvases exist from the start; no resize canvas follows.
        const canvases = e.canvases.length;
        await e.select(file);
        assert.equal(e.canvases.length, canvases);
        assert.equal(e.requests[0].options.body.entries.get('file').value, file);
    }
});

test('a failed canvas export falls back to uploading the original', async () => {
    const e = editor();
    const file = { name: 'big.png', width: 3000, height: 3000 };
    await e.select(file);
    e.exports.at(-1)(null);
    await flush();
    assert.equal(e.requests[0].options.body.entries.get('file').value, file);
});

test('switching images while a photo is downscaling skips its upload', async () => {
    const e = editor();
    await e.select({ name: 'big.jpg', type: 'image/jpeg', width: 4000, height: 3000 });
    const toBlob = e.exports.at(-1);
    await e.select({ name: 'next.png' }, false);
    toBlob({ name: 'stale shrunk' });
    await flush();
    assert.equal(e.requests.length, 0);
    assert.equal(e.filename(), 'next.png');
});

test('the mask becomes the alpha channel of the full-resolution original', async () => {
    const e = editor();
    // Two pixels: one opaque, one already half transparent in the original.
    const file = {
        name: 'pair.png',
        type: 'image/png',
        width: 2,
        height: 1,
        pixels: [10, 20, 30, 255, 40, 50, 60, 128],
    };
    await e.select(file);
    const request = e.requests[0];
    assert.equal(request.url, '/remove-bg/mask');
    assert.equal(request.options.body.entries.get('file').value, file);
    await e.respond(request, { width: 2, height: 1, pixels: [255, 255, 255, 255, 64, 64, 64, 255] });
    const encode = e.exports.at(-1);
    const canvas = encode.canvas;
    assert.deepEqual([canvas.width, canvas.height], [2, 1]);
    assert.deepEqual([...canvas.putPixels], [10, 20, 30, 255, 40, 50, 60, 32]);
    assert.equal(e.bitmaps.every((bitmap) => bitmap.closed), true);
    const cutout = { name: 'full-resolution cutout' };
    await finishCutout(e, cutout);
    assert.equal(e.visibleImage(), cutout);
});

test('large photos upload a small copy but keep the original resolution', async () => {
    const e = editor();
    const file = { name: 'wide.jpg', type: 'image/jpeg', width: 3000, height: 10 };
    await e.select(file);
    const shrunk = { name: 'shrunk' };
    e.exports.at(-1)(shrunk);
    await flush();
    assert.equal(e.requests[0].options.body.entries.get('file').value, shrunk);
    await e.respond(e.requests[0], { width: 2048, height: 7 });
    const canvas = e.exports.at(-1).canvas;
    assert.deepEqual([canvas.width, canvas.height], [3000, 10]);
    const [maskDraw, photoDraw] = canvas.draws;
    assert.equal(maskDraw.source.width, 2048);
    assert.deepEqual(maskDraw.position, [0, 0, 3000, 10]);
    assert.equal(photoDraw.source.width, 3000);
});

test('images the browser cannot decode use the server cut-out unchanged', async () => {
    const e = editor();
    const file = { name: 'scan.tiff', type: 'image/tiff', width: 800, height: 600, undecodable: true };
    await e.select(file);
    assert.equal(e.requests[0].url, '/remove-bg');
    const cutout = { name: 'server cutout', width: 800, height: 600 };
    const exportsBefore = e.exports.length;
    await e.respond(e.requests[0], cutout);
    await e.decode();
    assert.equal(e.exports.length, exportsBefore);
    assert.equal(e.visibleImage(), cutout);
});

test('a mask that cannot be applied reports the failure', async () => {
    const e = editor();
    await openThenRemove(e, { name: 'A.png', width: 4, height: 4 });
    await e.respond(e.requests[0], { name: 'not an image' });
    assert.deepEqual(e.alerts, [
        'Could not apply the background removal. Please try again.',
    ]);
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.bitmaps.every((bitmap) => bitmap.closed), true);
});

test('switching images while a mask is applied discards the stale cut-out', async () => {
    const e = editor();
    await e.select({ name: 'A.png', width: 4, height: 4 });
    await e.respond(e.requests[0], { width: 4, height: 4 });
    const staleEncode = e.exports.at(-1);
    await e.select({ name: 'B.png' }, false);
    staleEncode({ name: 'stale cutout' });
    await flush();
    await e.decode();
    assert.equal(e.visibleImage().name, 'B.png');
    assert.equal(e.filename(), 'B.png');
    assert.equal(e.croppers.length, 1);
});

test('switching back to an image reuses its cut-out without uploading or decoding again', async () => {
    const e = editor();
    await e.select({ name: 'A.png', width: 4, height: 4 });
    await e.respond(e.requests[0], { width: 4, height: 4 });
    await finishCutout(e, { name: 'A cutout' });
    await e.select({ name: 'B.png' });
    await e.respond(e.requests[1], { name: 'B cutout' });
    await e.decode();
    const decodes = e.decodes.length;
    const exports = e.exports.length;
    e.element('batchImages').children[0].click();
    await flush();
    assert.equal(e.requests.length, 2);
    assert.equal(e.decodes.length, decodes);
    assert.equal(e.exports.length, exports);
    assert.equal(e.visibleImage().name, 'A cutout');
    assert.equal(e.filename(), 'A.png');
    assert.equal(e.element('removeBg').checked, true);
});

test('each image keeps its own removal setting, and new uploads start with it off', async () => {
    const e = editor();
    await e.select({ name: 'A.png' });
    await e.respond(e.requests[0], { name: 'A cutout' });
    await e.decode();
    await e.select({ name: 'B.png' }, false);
    assert.equal(e.element('removeBg').checked, false);
    await e.decode();
    assert.equal(e.visibleImage().name, 'B.png');
    assert.equal(e.requests.length, 1);
    e.element('batchImages').children[0].click();
    await flush();
    assert.equal(e.element('removeBg').checked, true);
    assert.equal(e.visibleImage().name, 'A cutout');
    e.element('batchImages').children[1].click();
    await flush();
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.visibleImage().name, 'B.png');
});

test('an interrupted removal is not stored, so returning to the image uploads it again', async () => {
    const e = editor();
    await e.select({ name: 'A.png', width: 4, height: 4 });
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    await e.respond(e.requests[0], { width: 4, height: 4 });
    e.element('batchImages').children[0].click();
    await flush();
    assert.equal(e.requests.length, 2);
    assert.equal(e.requests[1].url, '/remove-bg/mask');
});

test('toggling removal on a large photo keeps the crop exactly in place', async () => {
    const e = editor();
    const photo = { name: 'photo.jpg', type: 'image/jpeg', width: 4000, height: 3000 };
    await e.select(photo, false);
    await e.decode();
    e.cropper().data = { x: 1000, y: 600, width: 2000, height: 1500 };
    await e.toggle(true);
    e.exports.at(-1)({ name: 'shrunk' });
    await flush();
    await e.respond(e.requests[0], { width: 2048, height: 1536 });
    // The mask is applied to the original, so the cut-out stays at full size.
    await finishCutout(e, { name: 'cutout', width: 4000, height: 3000 });
    const data = e.cropper().getData();
    assert.deepEqual([data.x, data.y, data.width, data.height], [1000, 600, 2000, 1500]);
});

test('a server cut-out of another size swaps in place, and the crop is rescaled on reopening', async () => {
    const e = editor();
    // Undecodable files use the server cut-out; a smaller one stands in for any size change.
    const scan = { name: 'scan.tiff', type: 'image/tiff', width: 4000, height: 3000, undecodable: true };
    await e.select(scan, false);
    await e.decode();
    e.cropper().data = { x: 1000, y: 600, width: 2000, height: 1500 };
    await e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout', width: 2048, height: 1536 });
    await e.decode();
    // Stretched over the original, so the crop box stays in its pixels.
    assert.equal(e.visibleImage().name, 'cutout');
    assert.equal(e.cropper().hasSameSize, true);
    assert.equal(e.croppers.length, 1);
    const kept = e.cropper().getData();
    assert.deepEqual([kept.x, kept.y, kept.width, kept.height], [1000, 600, 2000, 1500]);
    // Reopened, the cropper is built on the cut-out, so the crop is rescaled to it.
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    e.element('batchImages').children[0].click();
    await flush();
    const shrunk = e.cropper().getData();
    assert.deepEqual(
        [shrunk.x, shrunk.y, shrunk.width, shrunk.height],
        [512, 307.2, 1024, 768],
    );
});

test('reprocessing at the same size leaves the crop untouched', async () => {
    const e = editor();
    const file = { name: 'small.png', width: 800, height: 600, undecodable: true };
    await e.select(file, false);
    await e.decode();
    e.cropper().data = { x: 13, y: 7, width: 333, height: 250 };
    await e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout', width: 800, height: 600 });
    await e.decode();
    const data = e.cropper().getData();
    assert.deepEqual([data.x, data.y, data.width, data.height], [13, 7, 333, 250]);
});

async function editedImage(name = 'A.png') {
    const e = editor();
    await e.select({ name }, false);
    await e.decode();
    return e;
}

function dragCrop(e, data) {
    e.cropper().data = { ...e.cropper().data, ...data };
    e.cropper().options.cropend();
}

test('undo and redo step through crop, transform and background edits', async () => {
    const e = await editedImage();
    const undo = e.element('undoButton'),
        redo = e.element('redoButton');
    assert.equal(undo.disabled, true);
    assert.equal(redo.disabled, true);
    const initial = e.cropper().getData();
    dragCrop(e, { x: 40, width: 200 });
    e.element('rotateRight').click();
    e.element('flipHorizontal').click();
    e.element('blackBg').click();
    assert.equal(undo.disabled, false);

    undo.click();
    assert.equal(e.element('blackBg')['aria-pressed'], 'false');
    assert.equal(e.element('transparentBg')['aria-pressed'], 'true');
    assert.equal(e.cropper().horizontalScale, -1);
    undo.click();
    assert.equal(e.cropper().horizontalScale, 1);
    assert.equal(e.element('flipHorizontal')['aria-pressed'], 'false');
    undo.click();
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.element('rotationAngle').value, '0');
    undo.click();
    assert.deepEqual(e.cropper().getData(), initial);
    assert.equal(undo.disabled, true);
    assert.equal(redo.disabled, false);

    redo.click();
    assert.equal(e.cropper().getData().x, 40);
    assert.equal(e.cropper().getData().width, 200);
    redo.click();
    redo.click();
    redo.click();
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.cropper().horizontalScale, -1);
    assert.equal(e.element('blackBg')['aria-pressed'], 'true');
    assert.equal(redo.disabled, true);
    // Undo works on the live cropper; nothing is reprocessed or rebuilt.
    assert.equal(e.croppers.length, 1);
    assert.equal(e.decodes.length, 1);
});

test('undo restores output size and aspect ratio together', async () => {
    const e = await editedImage();
    e.element('widthInput').value = '300';
    e.element('widthInput').dispatchEvent(new Event('input'));
    // No change event yet: undo must still record the typed width first.
    e.element('undoButton').click();
    assert.equal(e.element('widthInput').value, '640');
    assert.equal(e.element('aspectRatioPreset').value, 'original');
    assert.equal(e.cropper().options.aspectRatio, 640 / 480);
    e.element('redoButton').click();
    assert.equal(e.element('widthInput').value, '300');
    assert.equal(e.element('aspectRatioPreset').value, 'custom');
    assert.equal(e.cropper().options.aspectRatio, 300 / 480);
});

test('continuous controls record one step when they settle', async () => {
    const e = await editedImage();
    const slider = e.element('rotationSlider');
    for (const value of ['10', '20', '30']) {
        slider.value = value;
        slider.dispatchEvent(new Event('input'));
    }
    slider.dispatchEvent(new Event('change'));
    const colour = e.element('bgColor');
    for (const value of ['#111111', '#222222']) {
        colour.value = value;
        colour.dispatchEvent(new Event('input'));
    }
    colour.dispatchEvent(new Event('change'));
    e.element('undoButton').click();
    assert.equal(e.element('transparentBg')['aria-pressed'], 'true');
    assert.equal(e.cropper().rotation, 30);
    e.element('undoButton').click();
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.element('undoButton').disabled, true);
});

test('a new edit after undo discards the redo steps, and no-op edits add none', async () => {
    const e = await editedImage();
    e.element('flipVertical').click();
    e.element('undoButton').click();
    assert.equal(e.element('redoButton').disabled, false);
    e.element('transparentBg').click();
    assert.equal(e.element('redoButton').disabled, false);
    e.element('rotateLeft').click();
    assert.equal(e.element('redoButton').disabled, true);
    e.element('undoButton').click();
    assert.equal(e.element('undoButton').disabled, true);
});

test('history is kept per image across switching', async () => {
    const e = editor();
    const a = { name: 'A.png' };
    await e.select(a, false);
    await e.decode();
    e.element('rotateRight').click();
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    assert.equal(e.element('undoButton').disabled, true);
    e.element('batchImages').children[0].click();
    assert.equal(e.element('undoButton').disabled, true);
    await e.decode();
    assert.equal(e.element('undoButton').disabled, false);
    e.element('undoButton').click();
    assert.equal(e.cropper().rotation, 0);
});

test('switching removal is one undo step that swaps the picture back', async () => {
    const e = editor();
    const file = { name: 'A.png' };
    await e.select(file, false);
    await e.decode();
    e.element('rotateRight').click();
    await e.toggle(true);
    // Undo waits while the cut-out is being made.
    assert.equal(e.element('undoButton').disabled, true);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'cutout');
    assert.equal(e.cropper().rotation, 90);
    e.element('undoButton').click();
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.cropper().rotation, 90);
    e.element('undoButton').click();
    assert.equal(e.cropper().rotation, 0);
    e.element('redoButton').click();
    e.element('redoButton').click();
    assert.equal(e.visibleImage().name, 'cutout');
    assert.equal(e.element('removeBg').checked, true);
    // Both pictures are kept, so switching off and on again is instant.
    await e.toggle(false);
    assert.equal(e.visibleImage(), file);
    await e.toggle(true);
    assert.equal(e.visibleImage().name, 'cutout');
    assert.equal(e.element('undoButton').disabled, false);
    assert.equal(e.loading(), false);
    assert.equal(e.croppers.length, 1);
    assert.equal(e.requests.length, 1);
    assert.equal(e.decodes.length, 2);
});

test('turning removal on while the image opens is an undo step once it loads', async () => {
    const e = editor();
    const file = { name: 'A.png' };
    await e.select(file, false);
    await e.decode();
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    e.element('batchImages').children[0].click();
    await e.toggle(true);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    assert.equal(e.visibleImage().name, 'cutout');
    e.element('undoButton').click();
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('removeBg').checked, false);
});

test('reset restores the original with its background and starts a fresh history', async () => {
    const e = editor();
    const file = { name: 'A.png' };
    await openThenRemove(e, file);
    await e.respond(e.requests[0], { name: 'cutout' });
    await e.decode();
    e.element('rotateRight').click();
    e.element('resetButton').click();
    await flush();
    assert.equal(e.visibleImage(), file);
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.element('undoButton').disabled, true);
    // The cut-out is kept, so turning removal on again is instant.
    await e.toggle(true);
    assert.equal(e.requests.length, 1);
    assert.equal(e.visibleImage().name, 'cutout');
});

test('Apply to all images appears for batches and removes each background once', async () => {
    const e = editor();
    const files = [{ name: 'A.png' }, { name: 'B.png' }, { name: 'C.png' }];
    e.upload(files.slice(0, 1));
    await flush();
    await e.decode();
    assert.equal(e.element('applyRemovalToAll').hidden, true);
    e.upload(files.slice(1));
    await flush();
    await e.decode();
    assert.equal(e.element('applyRemovalToAll').hidden, false);
    // Start from B, opened and edited; A has been opened, C has not.
    e.element('batchImages').children[1].click();
    await flush();
    e.element('rotateRight').click();
    e.element('removeBg').checked = true;
    e.element('applyRemovalToAll').click();
    await flush();
    await e.respond(e.requests[0], { name: 'B cutout' });
    await e.decode();
    assert.equal(e.filename(), 'A.png');
    await e.respond(e.requests[1], { name: 'A cutout' });
    await e.decode();
    assert.equal(e.filename(), 'C.png');
    await e.respond(e.requests[2], { name: 'C cutout' });
    await e.decode();
    assert.equal(e.filename(), 'B.png');
    assert.equal(e.visibleImage().name, 'B cutout');
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.requests.length, 3);
    // Every image's saved export now uses its cut-out.
    const pending = e.download(true);
    for (const index of [0, 1, 2]) {
        assert.match(e.canvases.at(-3 + index).renderedFrom.source, /cutout/);
    }
    pending.catch(() => {});
    // Each image can undo its own change.
    e.element('batchImages').children[0].click();
    await flush();
    e.element('undoButton').click();
    assert.equal(e.visibleImage().name, 'A.png');
});

test('keyboard shortcuts undo and redo outside text fields', async () => {
    const e = await editedImage();
    e.element('rotateRight').click();
    assert.equal(e.keydown('z', { metaKey: true }), true);
    assert.equal(e.cropper().rotation, 0);
    assert.equal(e.keydown('z', { ctrlKey: true, shiftKey: true }), true);
    assert.equal(e.cropper().rotation, 90);
    e.keydown('z', { ctrlKey: true });
    assert.equal(e.keydown('y', { ctrlKey: true }), true);
    assert.equal(e.cropper().rotation, 90);
    assert.equal(e.keydown('z'), false);
    assert.equal(e.keydown('z', { ctrlKey: true, altKey: true }), false);
    const numberField = { matches: (selector) => selector.includes('input[type="number"]') };
    assert.equal(e.keydown('z', { ctrlKey: true }, numberField), false);
    assert.equal(e.cropper().rotation, 90);
});

test('history keeps the most recent 50 steps', async () => {
    const e = await editedImage();
    for (let step = 0; step < 60; step++) e.element('flipVertical').click();
    let undone = 0;
    while (!e.element('undoButton').disabled) {
        e.element('undoButton').click();
        undone++;
    }
    assert.equal(undone, 50);
});

function chooseExport(e, format) {
    e.element('exportFormat').value = format;
    e.element('exportFormat').dispatchEvent(new Event('change'));
}

test('JPEG export uses a fixed quality and a white backdrop for transparency', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    chooseExport(e, 'image/jpeg');
    assert.equal(e.element('exportNote').hidden, false);
    e.element('downloadMenuButton').click();
    e.element('downloadCurrent').click();
    const toBlob = e.exports.at(-1);
    assert.equal(toBlob.type, 'image/jpeg');
    assert.equal(toBlob.quality, 0.9);
    // The edited canvas is drawn onto a fresh, white-filled canvas before encoding.
    const edited = toBlob.canvas.renderedFrom;
    assert.equal(e.canvases.includes(edited), true);
    assert.equal(toBlob.canvas.width, edited.width);
    assert.equal(toBlob.canvas.height, edited.height);
    toBlob(new Blob(['jpeg'], { type: 'image/jpeg' }));
    await flush();
    assert.equal(e.downloads[0].filename, 'edited_A.jpg');
});

test('WebP export keeps transparency and PNG is saved without a quality', async () => {
    for (const [format, filename, quality] of [
        ['image/webp', 'edited_A.webp', 0.9],
        ['image/png', 'edited_A.png', undefined],
    ]) {
        const e = editor();
        await e.select({ name: 'A.png' }, false);
        await e.decode();
        chooseExport(e, format);
        assert.equal(e.element('exportNote').hidden, true);
        e.element('downloadMenuButton').click();
        e.element('downloadCurrent').click();
        const toBlob = e.exports.at(-1);
        assert.equal(toBlob.type, format);
        assert.equal(toBlob.quality, quality);
        // The edited canvas is encoded directly, not copied onto a backdrop.
        assert.equal(e.canvases.includes(toBlob.canvas.renderedFrom), false);
        toBlob(new Blob(['image'], { type: format }));
        await flush();
        assert.equal(e.downloads[0].filename, filename);
    }
});

test('ZIP export applies the format to edited images and keeps untouched originals', async () => {
    const e = editor();
    e.element('removeBg').checked = false;
    e.upload([imageFile('edited.png'), imageFile('original.png', 'untouched image')]);
    await e.decode();
    const pending = e.download(true, { type: 'image/webp', quality: 0.8 });
    assert.equal(e.exports[0].type, 'image/webp');
    assert.equal(e.exports[0].quality, 0.8);
    await encodeExport(e, 0);
    await pending;
    const zip = await JSZip.loadAsync(await e.downloads[0].blob.arrayBuffer());
    assert.deepEqual(Object.keys(zip.files), ['edited_edited.webp', 'original.png']);
});

test('unknown export formats fall back to PNG', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    e.download(false, { type: 'image/gif' });
    await flush();
    assert.equal(e.exports.at(-1).type, 'image/png');
    e.exports.at(-1)(new Blob(['png'], { type: 'image/png' }));
    await flush();
    assert.equal(e.downloads[0].filename, 'edited_A.png');
});

test('WebP is disabled when the browser cannot encode it', async () => {
    for (const webpEncoding of [true, false]) {
        const e = editor({ webpEncoding });
        await e.select({ name: 'A.png' }, false);
        await e.decode();
        e.element('downloadMenuButton').click();
        const option = e.element('exportFormatWebp');
        assert.equal(Boolean(option.disabled), !webpEncoding);
    }
});

test('arrow keys move between download actions but not inside the export options', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    e.element('downloadMenuButton').click();
    const press = (target) => {
        const event = new Event('keydown', { cancelable: true });
        event.key = 'ArrowDown';
        // Node's EventTarget does not bubble, so present the key as coming from target.
        Object.defineProperty(event, 'target', { value: target });
        e.element('downloadMenu').dispatchEvent(event);
        return event.defaultPrevented;
    };
    assert.equal(press(e.element('exportFormat')), false);
    assert.equal(press(e.element('downloadCurrent')), true);
    assert.equal(e.element('downloadAll').focused, true);
});

test('pasting images adds them like an upload and selects the first', async () => {
    const e = editor();
    const screenshot = { name: 'image.png', type: 'image/png' };
    const photo = { name: 'photo.jpg', type: 'image/jpeg' };
    e.element('removeBg').checked = false;
    assert.equal(
        await e.paste([screenshot, { name: 'notes.txt', type: 'text/plain' }, photo]),
        true,
    );
    assert.equal(e.element('batchImages').children.length, 2);
    assert.equal(e.filename(), 'image.png');
    await e.decode();
    assert.equal(e.visibleImage(), screenshot);
});

test('pasting text or nothing is left to the browser', async () => {
    const e = editor();
    assert.equal(await e.paste([]), false);
    assert.equal(await e.paste([{ name: 'notes.txt', type: 'text/plain' }]), false);
    assert.equal(e.element('batchImages').children.length, 0);
    assert.equal(e.decodes.length, 0);
});

// The brush view is fitted to the 800 × 600 container, so a 4 × 4 image is shown
// at 135 screen pixels per image pixel, offset by (130, 30).
const BRUSH_SCALE = 135;
const brushLayer = (e, className) =>
    e.element('dropZone').children.find((child) => child.className.startsWith(className));
// The brush view's top canvas, which takes the pointer and dims around the crop box.
const brushCanvas = (e) => brushLayer(e, 'brush-canvas');
const atPixel = (x, y) => [130 + x * BRUSH_SCALE, 30 + y * BRUSH_SCALE];

// Pointer positions go through an inverted matrix, so allow rounding error.
function assertNear(actual, expected) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) =>
        assert.ok(Math.abs(value - expected[index]) < 1e-9, `${actual} ≉ ${expected}`),
    );
}

function pointer(target, type, [clientX, clientY], extra = {}) {
    const event = Object.assign(
        new Event(type, { cancelable: true }),
        { clientX, clientY, pointerId: 1, button: 0 },
        extra,
    );
    target.dispatchEvent(event);
}

function drawStroke(e, ...pixels) {
    const canvas = brushCanvas(e);
    pointer(canvas, 'pointerdown', atPixel(...pixels[0]));
    for (const pixel of pixels.slice(1)) pointer(canvas, 'pointermove', atPixel(...pixel));
    pointer(canvas, 'pointerup', atPixel(...pixels.at(-1)));
}

// The full-size coverage canvas the brush paints on.
const coverageCanvas = (e) =>
    e.canvases.filter((canvas) => canvas.width === 4 && canvas.ops.some(([op]) => op === 'arc')).at(-1);

async function cutoutImage(file = { name: 'A.png', width: 4, height: 4 }) {
    const e = editor();
    await e.select(file, false);
    await e.decode();
    await e.toggle(true);
    await e.respond(e.requests[0], { width: 4, height: 4 });
    await finishCutout(e, { name: 'cutout', width: 4, height: 4 });
    return e;
}

async function openBrushTool(e) {
    e.element('brushTool').click();
    await flush();
}

// Closing the panel bakes the strokes into a new cut-out: encode, then decode.
async function closeBrushTool(e, result = { name: 'brushed', width: 4, height: 4 }) {
    e.element('closeToolPanel').click();
    await flush();
    await finishCutout(e, result);
}

test('the Cutout panel hides the brush until removal is on and leaves the cropper in place', async () => {
    const e = editor();
    await e.select({ name: 'A.png', width: 4, height: 4 }, false);
    await e.decode();
    await openBrushTool(e);
    assert.equal(e.element('toolPanelTitle').textContent, 'Cutout');
    assert.equal(e.element('brushHint').hidden, true);
    assert.equal(e.element('brushOptions').hidden, true);
    assert.equal(brushCanvas(e).hidden, true);
});

test('the removal switch in the Cutout panel opens and closes the brush, keeping strokes', async () => {
    const e = editor();
    await e.select({ name: 'A.png', width: 4, height: 4 }, false);
    await e.decode();
    await openBrushTool(e);
    await e.toggle(true);
    await e.respond(e.requests[0], { width: 4, height: 4 });
    await finishCutout(e, { name: 'cutout', width: 4, height: 4 });
    await flush();
    assert.equal(e.element('brushOptions').hidden, false);
    assert.equal(brushCanvas(e).hidden, false);
    drawStroke(e, [1, 1]);
    await e.toggle(false);
    assert.equal(brushCanvas(e).hidden, true);
    assert.equal(e.element('brushOptions').hidden, true);
    // Turning it on again rebuilds the cut-out with the stroke, then reopens the brush.
    await e.toggle(true);
    await finishCutout(e, { name: 'brushed', width: 4, height: 4 });
    await flush();
    assert.equal(e.requests.length, 1);
    assert.equal(brushCanvas(e).hidden, false);
});

test('the brush is not offered for files that use the server cut-out', async () => {
    const e = editor();
    await e.select({ name: 'scan.tiff', width: 4, height: 4, undecodable: true }, false);
    await e.decode();
    await e.toggle(true);
    await e.respond(e.requests[0], { name: 'server cutout', width: 4, height: 4 });
    await e.decode();
    await openBrushTool(e);
    assert.match(e.element('brushHint').textContent, /not available/);
    assert.equal(brushCanvas(e).hidden, true);
});

test('painting erases along the stroke in image pixels and is one undo step', async () => {
    const e = await cutoutImage();
    await openBrushTool(e);
    assert.equal(e.element('brushHint').hidden, true);
    assert.equal(e.element('brushOptions').hidden, false);
    assert.equal(brushCanvas(e).hidden, false);
    assert.equal(e.element('redoButton').disabled, true);
    drawStroke(e, [1, 2], [3, 2]);
    const ops = coverageCanvas(e).ops;
    // The default 40 px brush is 40 / 135 image pixels wide at this zoom.
    const dot = ops.find(([op]) => op === 'arc');
    assertNear(dot.slice(1, 4), [1, 2, 40 / BRUSH_SCALE / 2]);
    assertNear(ops.find(([op]) => op === 'lineTo').slice(1), [3, 2]);
    e.element('undoButton').click();
    assert.equal(e.element('redoButton').disabled, false);
    // Undoing the stroke leaves the earlier removal step in place.
    assert.equal(e.element('removeBg').checked, true);
    assert.equal(brushCanvas(e).hidden, false);
    // Nothing is uploaded again, and the cropper is kept for later.
    assert.equal(e.requests.length, 1);
    assert.equal(e.croppers.length, 1);
});

test('restore mode and brush size apply to the next stroke, and zoom maps the pointer', async () => {
    const e = await cutoutImage();
    await openBrushTool(e);
    e.element('brushRestore').click();
    assert.equal(e.element('brushRestore')['aria-pressed'], 'true');
    assert.equal(e.element('brushErase')['aria-pressed'], 'false');
    const size = e.element('brushSize');
    size.value = '27';
    size.dispatchEvent(new Event('input'));
    assert.equal(e.element('brushSizeValue').textContent, '27 px');
    // Zooming in about the centre doubles the scale; the image's (2, 2) stays put.
    const cropperZoom = e.cropper().zoomLevel;
    e.element('zoomIn').click();
    e.element('zoomIn').click();
    assert.equal(e.cropper().zoomLevel, cropperZoom);
    pointer(brushCanvas(e), 'pointerdown', atPixel(2, 2));
    pointer(brushCanvas(e), 'pointerup', atPixel(2, 2));
    const dot = coverageCanvas(e).ops.filter(([op]) => op === 'arc').at(-1);
    assert.deepEqual(dot.slice(1, 3), [2, 2]);
    assert.ok(Math.abs(dot[3] - 27 / (BRUSH_SCALE * 1.5625) / 2) < 1e-9);
    // The hand beside the zoom buttons pans instead of painting.
    e.element('panToggle').click();
    const arcs = coverageCanvas(e).ops.length;
    pointer(brushCanvas(e), 'pointerdown', [400, 300]);
    pointer(brushCanvas(e), 'pointermove', [450, 300]);
    pointer(brushCanvas(e), 'pointerup', [450, 300]);
    assert.equal(coverageCanvas(e).ops.length, arcs);
});

test('the brush view opens where the crop view shows the image', async () => {
    const e = await cutoutImage();
    // The crop view shows the 4 px image 400 px wide, centred at (300, 250).
    e.cropper().canvasData = { left: 100, top: 50, width: 400, height: 400 };
    e.cropper().displayWidth = 400;
    await openBrushTool(e);
    // Pointer positions map through the crop view's scale of 100 px per image pixel.
    const canvas = brushCanvas(e);
    pointer(canvas, 'pointerdown', [100 + 3 * 100, 50 + 1 * 100]);
    pointer(canvas, 'pointerup', [100 + 3 * 100, 50 + 1 * 100]);
    const dot = coverageCanvas(e).ops.filter(([op]) => op === 'arc').at(-1);
    assertNear(dot.slice(1, 4), [3, 1, 40 / 100 / 2]);
});

test('the brush view shows the crop box and the rotation, as the crop view does', async () => {
    const e = await cutoutImage();
    e.element('rotateRight').click();
    e.cropper().canvasData = { left: 100, top: 50, width: 400, height: 400 };
    e.cropper().displayWidth = 400;
    e.cropper().cropBoxData = { left: 150, top: 100, width: 200, height: 100 };
    await openBrushTool(e);
    // Everything outside the crop box is dimmed, so the box is cut out of the dimming.
    assert.ok(brushCanvas(e).ops.some((op) => op.join() === 'rect,150,100,200,100'));
    // Turned 90° clockwise about the image's centre (300, 250): the pixel one to
    // the right of the centre, (3, 2), is shown 100 px below it.
    pointer(brushCanvas(e), 'pointerdown', [300, 350]);
    pointer(brushCanvas(e), 'pointerup', [300, 350]);
    const dot = coverageCanvas(e).ops.filter(([op]) => op === 'arc').at(-1);
    assertNear(dot.slice(1, 3), [3, 2]);
});

test('closing the brush bakes the strokes into the cut-out the cropper shows', async () => {
    const e = await cutoutImage();
    const cropper = e.cropper();
    await openBrushTool(e);
    drawStroke(e, [1, 1]);
    await closeBrushTool(e);
    assert.equal(brushCanvas(e).hidden, true);
    assert.equal(e.cropper(), cropper);
    assert.equal(e.visibleImage().name, 'brushed');
    assert.equal(e.requests.length, 1);
    assert.equal(e.loading(), false);
    // Undo outside the brush rebuilds the cut-out without the stroke.
    e.element('undoButton').click();
    await flush();
    assert.equal(e.loading(), true);
    await finishCutout(e, { name: 'unbrushed', width: 4, height: 4 });
    assert.equal(e.visibleImage().name, 'unbrushed');
    assert.equal(e.loading(), false);
});

test('turning removal off and on keeps the brush edits without rebuilding', async () => {
    const e = await cutoutImage();
    await openBrushTool(e);
    drawStroke(e, [1, 1]);
    await closeBrushTool(e);
    const exports = e.exports.length;
    await e.toggle(false);
    assert.equal(e.visibleImage().name, 'A.png');
    await e.toggle(true);
    assert.equal(e.visibleImage().name, 'brushed');
    assert.equal(e.exports.length, exports);
    assert.equal(e.loading(), false);
});

test('reset discards brush edits and rebuilds the plain cut-out without uploading', async () => {
    const e = await cutoutImage();
    await openBrushTool(e);
    drawStroke(e, [1, 1]);
    await closeBrushTool(e);
    await openBrushTool(e);
    e.element('resetButton').click();
    await flush();
    assert.equal(brushCanvas(e).hidden, true);
    assert.equal(e.element('removeBg').checked, false);
    assert.equal(e.element('brushOptions').hidden, true);
    assert.equal(e.element('undoButton').disabled, true);
    e.element('backgroundTool').click();
    await e.toggle(true);
    // Rebuilt from the stored mask, not the brushed cut-out.
    const [maskDraw] = e.exports.at(-1).canvas.draws;
    assert.equal(maskDraw.source.width, 4);
    await finishCutout(e, { name: 'plain cutout', width: 4, height: 4 });
    assert.equal(e.visibleImage().name, 'plain cutout');
    assert.equal(e.requests.length, 1);
});

test('switching images or downloading while brushing bakes the strokes first', async () => {
    const e = await cutoutImage();
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    e.element('batchImages').children[0].click();
    await flush();
    await openBrushTool(e);
    drawStroke(e, [1, 1]);
    e.element('batchImages').children[1].click();
    await flush();
    assert.equal(e.filename(), 'A.png');
    await finishCutout(e, { name: 'brushed A', width: 4, height: 4 });
    assert.equal(e.filename(), 'B.png');
    // A's saved export uses the brushed cut-out.
    e.element('batchImages').children[0].click();
    await flush();
    assert.equal(e.visibleImage().name, 'brushed A');
    drawStroke(e, [2, 2]);
    const pending = e.download();
    await flush();
    await finishCutout(e, { name: 'brushed again', width: 4, height: 4 });
    e.exports.at(-1)(new Blob(['png']));
    await pending;
    assert.equal(e.downloads.length, 1);
    assert.equal(e.canvases.at(-1).draws[0].source.source, 'brushed again');
});

// Pick a background photo through the hidden file input, then decode it.
async function choosePhoto(e, file = { name: 'beach.jpg', width: 8, height: 4 }) {
    const input = e.element('bgPhotoInput');
    input.files = [file];
    input.dispatchEvent(new Event('change'));
    await flush();
    await e.decode();
}

test('the Photo swatch picks a photo, which fills the crop box cover-fitted', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    let opened = 0;
    e.element('bgPhotoInput').addEventListener('click', () => (opened += 1));
    e.element('photoBg').click();
    assert.equal(opened, 1);
    await choosePhoto(e);
    assert.equal(e.element('photoBg')['aria-pressed'], 'true');
    assert.equal(e.element('photoBg').classList.contains('has-photo'), true);
    assert.equal(e.cropper().options.fillColor, 'transparent');
    assert.match(e.element('.cropper-view-box').style.background, /^url\("blob:\d+"\) center \/ cover/);
    // Another background, then the swatch switches back without asking again.
    e.element('whiteBg').click();
    e.element('photoBg').click();
    assert.equal(opened, 1);
    assert.equal(e.element('photoBg')['aria-pressed'], 'true');
    // Clicking it while chosen picks a new photo.
    e.element('photoBg').click();
    assert.equal(opened, 2);
    // Each choice is an undo step.
    e.element('undoButton').click();
    assert.equal(e.element('whiteBg')['aria-pressed'], 'true');
    e.element('redoButton').click();
    assert.equal(e.element('photoBg')['aria-pressed'], 'true');
});

test('downloading draws the photo cover-fitted under the image', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    await choosePhoto(e);
    e.download(false);
    await flush();
    const [photo, image] = e.exports.at(-1).canvas.draws;
    // An 8 × 4 photo covering 640 × 480 is scaled by 120, so its middle
    // 5⅓ × 4 pixels fill the frame.
    assertNear(photo.position, [4 / 3, 0, 16 / 3, 4, 0, 0, 640, 480]);
    assert.equal(image.source.options.fillColor, 'transparent');
});

test('new uploads start with the photo background, and a photo that fails to open changes nothing', async () => {
    const e = editor();
    await e.select({ name: 'A.png' }, false);
    await e.decode();
    await choosePhoto(e);
    const photoUrl = e.element('.cropper-view-box').style.background;
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    assert.equal(e.element('photoBg')['aria-pressed'], 'true');
    assert.equal(e.element('.cropper-view-box').style.background, photoUrl);
    e.element('blackBg').click();
    const input = e.element('bgPhotoInput');
    input.files = [{ name: 'broken.heic', width: 8, height: 4 }];
    input.dispatchEvent(new Event('change'));
    await flush();
    e.decodes.at(-1).reject(new Error('EncodingError'));
    await flush();
    assert.match(e.alerts.at(-1), /could not be opened/);
    assert.equal(e.element('blackBg')['aria-pressed'], 'true');
});

test('the brush view draws the photo behind the cut-out', async () => {
    const e = await cutoutImage();
    await choosePhoto(e);
    await openBrushTool(e);
    // The 8 × 4 photo is drawn on the backdrop, under the cut-out's own canvas.
    assert.ok(brushLayer(e, 'brush-backdrop').draws.some(({ source }) => source.naturalWidth === 8));
    assert.ok(brushLayer(e, 'brush-picture').draws.length > 0);
    assert.ok(!brushLayer(e, 'brush-picture').draws.some(({ source }) => source.naturalWidth === 8));
});

function slide(e, name, value) {
    const slider = e.element(`adjust-${name}`);
    slider.value = String(value);
    slider.dispatchEvent(new Event('input'));
}

test('adjustment sliders preview on the picture and record one step when they settle', async () => {
    const e = await editedImage();
    const stage = e.element('dropZone');
    assert.equal(stage.style['--adjust-filter'], 'none');
    assert.equal(e.element('resetAdjustments').disabled, true);
    for (const value of [10, 20, 40]) slide(e, 'brightness', value);
    e.element('adjust-brightness').dispatchEvent(new Event('change'));
    slide(e, 'warmth', -50);
    e.element('adjust-warmth').dispatchEvent(new Event('change'));
    assert.equal(stage.style['--adjust-filter'], 'brightness(1.2) url(#adjustWarmth)');
    // Cooling scales red down and blue up by half of 20%.
    assert.equal(
        e.element('adjustWarmthMatrix').values,
        '0.9 0 0 0 0  0 1 0 0 0  0 0 1.1 0 0  0 0 0 1 0',
    );
    assert.equal(e.element('adjust-warmth-value').textContent, '−50');
    assert.equal(e.element('adjust-brightness-value').textContent, '+40');
    assert.equal(e.element('resetAdjustments').disabled, false);

    e.element('undoButton').click();
    assert.equal(stage.style['--adjust-filter'], 'brightness(1.2)');
    assert.equal(e.element('adjust-warmth').value, '0');
    e.element('undoButton').click();
    assert.equal(stage.style['--adjust-filter'], 'none');
    assert.equal(e.element('adjust-brightness').value, '0');
    assert.equal(e.element('undoButton').disabled, true);
    e.element('redoButton').click();
    assert.equal(e.element('adjust-brightness').value, '40');
    // Nothing is reprocessed or rebuilt.
    assert.equal(e.croppers.length, 1);
});

test('Reset adjustments is one undo step, and the image Reset clears them too', async () => {
    const e = await editedImage();
    slide(e, 'sharpen', 50);
    e.element('adjust-sharpen').dispatchEvent(new Event('change'));
    assert.equal(e.element('adjustSharpenKernel').kernelMatrix, '0 -0.5 0 -0.5 3 -0.5 0 -0.5 0');
    e.element('resetAdjustments').click();
    assert.equal(e.element('adjust-sharpen').value, '0');
    assert.equal(e.element('dropZone').style['--adjust-filter'], 'none');
    e.element('undoButton').click();
    assert.equal(e.element('adjust-sharpen').value, '50');
    e.element('resetButton').click();
    await e.decode();
    assert.equal(e.element('adjust-sharpen').value, '0');
    assert.equal(e.element('dropZone').style['--adjust-filter'], 'none');
});

test('each image keeps its own adjustments, and new uploads start without any', async () => {
    const e = await editedImage('A.png');
    slide(e, 'contrast', 30);
    e.element('adjust-contrast').dispatchEvent(new Event('change'));
    await e.select({ name: 'B.png' }, false);
    await e.decode();
    assert.equal(e.element('adjust-contrast').value, '0');
    assert.equal(e.element('dropZone').style['--adjust-filter'], 'none');
    e.element('batchImages').children[0].click();
    await flush();
    await e.decode();
    assert.equal(e.element('adjust-contrast').value, '30');
    assert.equal(e.element('dropZone').style['--adjust-filter'], 'contrast(1.15)');
});

test('downloading adjusts the picture only, with the background drawn underneath', async () => {
    const e = await editedImage();
    e.element('blackBg').click();
    slide(e, 'brightness', 100);
    e.element('adjust-brightness').dispatchEvent(new Event('change'));
    // One opaque grey pixel and one transparent one.
    e.cropper().croppedPixels = [100, 100, 100, 255, 0, 0, 0, 0];
    e.download(false);
    await flush();
    const [image] = e.exports.at(-1).canvas.draws;
    // The crop has no fill, so the black is not brightened with the picture.
    const adjusted = image.source;
    assert.equal(adjusted.draws[0].source.options.fillColor, 'transparent');
    assert.deepEqual([...adjusted.putPixels], [150, 150, 150, 255, 0, 0, 0, 0]);
});

test('downloading without adjustments draws the crop unchanged', async () => {
    const e = await editedImage();
    e.element('blackBg').click();
    e.download(false);
    await flush();
    const [image] = e.exports.at(-1).canvas.draws;
    assert.equal(image.source.options.fillColor, '#000000');
});

test('dragging a two-way slider near the middle sticks at 0, but arrow keys step past it', async () => {
    const e = await editedImage();
    const buzzes = [];
    e.window.navigator = { vibrate: (ms) => buzzes.push(ms) };
    const slider = e.element('adjust-brightness');
    slider.dispatchEvent(new Event('pointerdown'));
    slide(e, 'brightness', 20);
    assert.equal(slider.style['--from'], '0.5');
    assert.equal(slider.style['--to'], '0.6');
    assert.equal(slider.classList.contains('at-zero'), false);
    slide(e, 'brightness', -3);
    assert.equal(slider.value, '0');
    assert.equal(e.element('adjust-brightness-value').textContent, '0');
    assert.equal(slider.classList.contains('at-zero'), true);
    assert.deepEqual(buzzes, [10]);
    // Staying at 0 does not buzz again.
    slide(e, 'brightness', 2);
    assert.deepEqual(buzzes, [10]);
    slide(e, 'brightness', -40);
    assert.equal(slider.style['--from'], '0.3');
    assert.equal(slider.style['--to'], '0.5');
    e.window.dispatchEvent(new Event('pointerup'));
    // Without a drag, a small value (such as one arrow-key step) is kept.
    slide(e, 'brightness', 1);
    assert.equal(slider.value, '1');
    // Sharpen starts at 0, so it fills from the left and never snaps.
    const sharpen = e.element('adjust-sharpen');
    sharpen.dispatchEvent(new Event('pointerdown'));
    slide(e, 'sharpen', 3);
    assert.equal(sharpen.value, '3');
    assert.equal(sharpen.style['--from'], '0');
    assert.equal(sharpen.style['--to'], '0.03');
});
