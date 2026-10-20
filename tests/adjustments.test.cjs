const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// The pixel formulas run on their own, without the page.
const context = vm.createContext({ window: {} });
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../static/adjustments.js'), 'utf8'),
    context,
    { filename: '/static/adjustments.js' },
);
const { NEUTRAL, adjustPixels, cssFilter, isNeutral } = context.window.ImageAdjustments;

const adjust = (pixels, changes, width = pixels.length / 4, height = 1) =>
    [...adjustPixels(Uint8ClampedArray.from(pixels), width, height, { ...NEUTRAL, ...changes })];

test('no adjustments leave the pixels and the preview alone', () => {
    assert.equal(isNeutral(NEUTRAL), true);
    assert.equal(isNeutral({ ...NEUTRAL, sharpen: 1 }), false);
    assert.equal(cssFilter(NEUTRAL), 'none');
    assert.deepEqual(adjust([12, 34, 56, 255], {}), [12, 34, 56, 255]);
});

test('brightness and contrast follow the CSS filters, clamped between steps', () => {
    // brightness(1.5): 100 → 150, and 200 → 300, clamped to 255.
    assert.deepEqual(adjust([100, 200, 0, 255], { brightness: 100 }), [150, 255, 0, 255]);
    // contrast(0.5) halves the distance from mid-grey (127.5).
    assert.deepEqual(adjust([255, 0, 128, 255], { contrast: -100 }), [191, 64, 128, 255]);
    // Brightened to 255 first, so contrast(1.5) cannot pull it back below.
    assert.deepEqual(adjust([200, 200, 200, 255], { brightness: 100, contrast: 100 }), [255, 255, 255, 255]);
    assert.equal(cssFilter({ ...NEUTRAL, brightness: 100, contrast: -100 }), 'brightness(1.5) contrast(0.5)');
});

test('saturation follows the CSS saturate matrix, and −100 is grey', () => {
    const [r, g, b] = adjust([255, 0, 0, 255], { saturation: -100 });
    // saturate(0) gives the luminance, 0.213 × 255, in every channel.
    assert.deepEqual([r, g, b], [54, 54, 54]);
    // saturate(2) pushes red further from grey.
    assert.deepEqual(adjust([200, 100, 100, 255], { saturation: 100 }), [255, 79, 79, 255]);
});

test('warmth scales red up and blue down, and the reverse for cool', () => {
    assert.deepEqual(adjust([100, 100, 100, 255], { warmth: 100 }), [120, 100, 80, 255]);
    assert.deepEqual(adjust([100, 100, 100, 255], { warmth: -50 }), [90, 100, 110, 255]);
    assert.equal(cssFilter({ ...NEUTRAL, warmth: 10 }), 'url(#adjustWarmth)');
});

test('sharpen pushes a pixel away from its neighbours and keeps alpha', () => {
    // A 3 × 1 strip: the brighter middle pixel gets brighter, at full amount
    // 5 × 120 − (100 + 100 + 120 + 120) = 160; the edges repeat themselves.
    const pixels = adjust([100, 100, 100, 200, 120, 120, 120, 255, 100, 100, 100, 200], { sharpen: 100 });
    assert.deepEqual(pixels.slice(4, 8), [160, 160, 160, 255]);
    assert.deepEqual(pixels.slice(0, 4), [80, 80, 80, 200]);
    assert.equal(cssFilter({ ...NEUTRAL, sharpen: 10 }), 'url(#adjustSharpen)');
});

test('transparent pixels are skipped and do not darken a cut-out edge', () => {
    // The transparent neighbour holds black; it counts as the pixel itself.
    const pixels = adjust([0, 0, 0, 0, 120, 120, 120, 255], { sharpen: 100, brightness: 50 });
    assert.deepEqual(pixels.slice(0, 4), [0, 0, 0, 0]);
    // brightness(1.25): 120 → 150, then sharpening an even area changes nothing.
    assert.deepEqual(pixels.slice(4, 8), [150, 150, 150, 255]);
});
