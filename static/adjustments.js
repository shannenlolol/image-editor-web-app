// Brightness, contrast, saturation, warmth and sharpen. The preview uses a CSS
// filter on the shown picture; the download runs the same formulas over its
// pixels, so the two match without relying on the canvas `filter` property.
window.ImageAdjustments = (() => {
    'use strict';

    // Each slider runs from −100 to 100 (sharpen from 0), with 0 meaning no change.
    const NEUTRAL = Object.freeze({
        brightness: 0,
        contrast: 0,
        saturation: 0,
        warmth: 0,
        sharpen: 0,
    });
    const NAMES = Object.keys(NEUTRAL);
    // The lowest slider value; all go up to 100.
    const MINIMUM = { brightness: -100, contrast: -100, saturation: -100, warmth: -100, sharpen: 0 };

    function isNeutral(adjustments) {
        return !adjustments || NAMES.every((name) => !adjustments[name]);
    }

    // Slider values as the factors of the CSS filter functions: brightness and
    // contrast from 0.5 to 1.5, saturation from 0 (grey) to 2.
    function factors(adjustments) {
        return {
            brightness: 1 + adjustments.brightness / 200,
            contrast: 1 + adjustments.contrast / 200,
            saturation: 1 + adjustments.saturation / 100,
            // Warmth scales red up and blue down by up to 20% (the reverse to cool).
            warmth: (adjustments.warmth / 100) * 0.2,
            // The centre weight of a 3 × 3 sharpen kernel is 1 + 4 × this.
            sharpen: adjustments.sharpen / 100,
        };
    }

    // The preview's CSS filter. Warmth and sharpen have no CSS function, so
    // they refer to the page's SVG filters, which syncPreviewFilters updates.
    function cssFilter(adjustments) {
        if (isNeutral(adjustments)) return 'none';
        const f = factors(adjustments);
        const parts = [];
        if (adjustments.brightness) parts.push(`brightness(${f.brightness})`);
        if (adjustments.contrast) parts.push(`contrast(${f.contrast})`);
        if (adjustments.saturation) parts.push(`saturate(${f.saturation})`);
        if (adjustments.warmth) parts.push('url(#adjustWarmth)');
        if (adjustments.sharpen) parts.push('url(#adjustSharpen)');
        return parts.join(' ');
    }

    function warmthMatrix(adjustments) {
        const { warmth } = factors(adjustments);
        return `${1 + warmth} 0 0 0 0  0 1 0 0 0  0 0 ${1 - warmth} 0 0  0 0 0 1 0`;
    }

    function sharpenKernel(adjustments) {
        const amount = factors(adjustments).sharpen;
        return `0 ${-amount} 0 ${-amount} ${1 + 4 * amount} ${-amount} 0 ${-amount} 0`;
    }

    // Update the SVG filters the CSS filter refers to.
    function syncPreviewFilters(adjustments, warmthElement, sharpenElement) {
        warmthElement.setAttribute('values', warmthMatrix(adjustments));
        sharpenElement.setAttribute('kernelMatrix', sharpenKernel(adjustments));
    }

    const clamp = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

    // Adjust RGBA pixels in place. Each step is clamped before the next, as
    // a chain of CSS filters is: brightness, contrast, saturation, warmth,
    // then sharpen. Alpha is left alone.
    function adjustPixels(pixels, width, height, adjustments) {
        if (isNeutral(adjustments)) return pixels;
        const f = factors(adjustments);
        // Brightness and contrast act on each channel alone, so look them up.
        const levels = new Float32Array(256);
        for (let value = 0; value < 256; value++) {
            const bright = clamp(value * f.brightness);
            levels[value] = clamp((bright - 127.5) * f.contrast + 127.5);
        }
        // The CSS saturate() matrix, from the Filter Effects specification.
        const s = f.saturation;
        const m = [
            0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
            0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
            0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
        ];
        const warmRed = 1 + f.warmth;
        const warmBlue = 1 - f.warmth;
        for (let index = 0; index < pixels.length; index += 4) {
            if (!pixels[index + 3]) continue;
            const r = levels[pixels[index]];
            const g = levels[pixels[index + 1]];
            const b = levels[pixels[index + 2]];
            pixels[index] = clamp(clamp(m[0] * r + m[1] * g + m[2] * b) * warmRed);
            pixels[index + 1] = m[3] * r + m[4] * g + m[5] * b;
            pixels[index + 2] = clamp(clamp(m[6] * r + m[7] * g + m[8] * b) * warmBlue);
        }
        if (f.sharpen) sharpen(pixels, width, height, f.sharpen);
        return pixels;
    }

    // A 3 × 3 sharpen: each pixel moves away from the average of its four
    // neighbours. Neighbours outside the image or fully transparent count as
    // the pixel itself, so a cut-out's edge does not pick up a dark fringe
    // from the black that transparent pixels hold.
    function sharpen(pixels, width, height, amount) {
        const source = Uint8ClampedArray.from(pixels);
        const centre = 1 + 4 * amount;
        const row = width * 4;
        const pick = (index, neighbour) => (source[neighbour + 3] ? neighbour : index);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                if (!source[index + 3]) continue;
                const left = x > 0 ? pick(index, index - 4) : index;
                const right = x < width - 1 ? pick(index, index + 4) : index;
                const up = y > 0 ? pick(index, index - row) : index;
                const down = y < height - 1 ? pick(index, index + row) : index;
                for (let channel = 0; channel < 3; channel++) {
                    const around =
                        source[left + channel] +
                        source[right + channel] +
                        source[up + channel] +
                        source[down + channel];
                    pixels[index + channel] = centre * source[index + channel] - amount * around;
                }
            }
        }
    }

    // The source drawn on a new canvas with the adjustments applied, or the
    // source itself when there are none.
    function applyToCanvas(source, adjustments) {
        if (isNeutral(adjustments)) return source;
        const canvas = document.createElement('canvas');
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Could not create the adjustment canvas.');
        context.drawImage(source, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        adjustPixels(image.data, canvas.width, canvas.height, adjustments);
        context.putImageData(image, 0, 0);
        return canvas;
    }

    return {
        NEUTRAL,
        NAMES,
        MINIMUM,
        isNeutral,
        cssFilter,
        syncPreviewFilters,
        adjustPixels,
        applyToCanvas,
    };
})();
