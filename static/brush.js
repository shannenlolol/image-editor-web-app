// Erase / Restore brush: the editable coverage behind a cut-out, and the
// separate view used to paint on it. Loaded before editor.js, which keeps each
// image's strokes and decides when the view opens.
window.ImageBrush = (() => {
    'use strict';

    // Draw the server's (possibly smaller) greyscale mask at full size into a
    // canvas whose alpha is the coverage, so strokes and compositing become
    // plain canvas operations. Pass `canvas` to repaint one in place.
    function coverageFromMask(mask, width, height, canvas = document.createElement('canvas')) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create the brush canvas.');
        context.drawImage(mask, 0, 0, width, height);
        const coverage = context.getImageData(0, 0, width, height);
        const pixels = coverage.data;
        // The mask is greyscale, so its red channel is the coverage.
        for (let index = 0; index < pixels.length; index += 4) {
            pixels[index + 3] = pixels[index];
            pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
        }
        context.putImageData(coverage, 0, 0);
        return canvas;
    }

    // A hard round brush, in image pixels. Erasing clears coverage; restoring
    // sets it to full, which brings back the original there. `from` paints only
    // the points added since the last call while a stroke is being drawn.
    function paintStroke(context, stroke, from = 0) {
        const { points } = stroke;
        context.save();
        context.globalCompositeOperation =
            stroke.mode === 'erase' ? 'destination-out' : 'source-over';
        context.fillStyle = context.strokeStyle = '#ffffff';
        context.lineWidth = stroke.size;
        context.lineCap = context.lineJoin = 'round';
        if (from === 0) {
            context.beginPath();
            context.arc(points[0][0], points[0][1], stroke.size / 2, 0, Math.PI * 2);
            context.fill();
        }
        if (points.length > 1 && from < points.length) {
            const start = Math.max(from - 1, 0);
            context.beginPath();
            context.moveTo(points[start][0], points[start][1]);
            for (let index = start + 1; index < points.length; index++)
                context.lineTo(points[index][0], points[index][1]);
            context.stroke();
        }
        context.restore();
    }

    function paintStrokes(canvas, strokes) {
        const context = canvas.getContext('2d');
        for (const stroke of strokes) paintStroke(context, stroke);
    }

    // The cut-out: the original with its alpha multiplied by the coverage, the
    // same result as the editor's applyMask.
    function composite(original, coverage) {
        const canvas = document.createElement('canvas');
        canvas.width = coverage.width;
        canvas.height = coverage.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create the cut-out canvas.');
        context.drawImage(original, 0, 0);
        context.globalCompositeOperation = 'destination-in';
        context.drawImage(coverage, 0, 0);
        return canvas;
    }

    // Draw `image` to fill the box, keeping its shape: scaled to cover, centred,
    // with the overflow cropped off. Used for photo backgrounds, here and in
    // the editor's export.
    function drawCover(context, image, x, y, width, height) {
        const imageWidth = image.naturalWidth || image.width;
        const imageHeight = image.naturalHeight || image.height;
        const scale = Math.max(width / imageWidth, height / imageHeight);
        const sourceWidth = width / scale;
        const sourceHeight = height / scale;
        context.drawImage(
            image,
            (imageWidth - sourceWidth) / 2,
            (imageHeight - sourceHeight) / 2,
            sourceWidth,
            sourceHeight,
            x,
            y,
            width,
            height,
        );
    }

    // 2D affine matrices as [a, b, c, d, e, f], the canvas setTransform order:
    // x' = a·x + c·y + e, y' = b·x + d·y + f. multiply(m, n) applies n first.
    function multiply(m, ...rest) {
        return rest.reduce(
            (p, n) => [
                p[0] * n[0] + p[2] * n[1],
                p[1] * n[0] + p[3] * n[1],
                p[0] * n[2] + p[2] * n[3],
                p[1] * n[2] + p[3] * n[3],
                p[0] * n[4] + p[2] * n[5] + p[4],
                p[1] * n[4] + p[3] * n[5] + p[5],
            ],
            m,
        );
    }
    function invert([a, b, c, d, e, f]) {
        const det = a * d - b * c;
        return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
    }
    function apply([a, b, c, d, e, f], [x, y]) {
        return [a * x + c * y + e, b * x + d * y + f];
    }

    // The brush view covers the cropper while open and draws the image as the
    // crop view shows it, crop box included, so pointer positions map to image
    // pixels through the inverse of that transform. Finished strokes are
    // passed to `onStroke`.
    function createView(container, onStroke) {
        const canvas = document.createElement('canvas');
        canvas.className = 'brush-canvas';
        canvas.hidden = true;
        const cursor = document.createElement('div');
        cursor.className = 'brush-cursor';
        cursor.hidden = true;
        container.appendChild(canvas);
        container.appendChild(cursor);
        // Holds the composited cut-out (and, while restoring, the erased-parts
        // guide) at screen size, so the background can be drawn underneath.
        const layer = document.createElement('canvas');
        let layers = null;
        let mode = 'erase';
        // The hand beside the zoom buttons: drags pan instead of painting.
        let panning = false;
        let size = 40; // On-screen diameter in CSS pixels.
        // `base` maps image pixels to view pixels as the crop view shows the
        // image (position, scale, rotation and flip), and `crop` is the crop
        // box in view pixels. The brush view's own zoom and pan go on top.
        let base = [1, 0, 0, 1, 0, 0];
        let baseScale = 1;
        let crop = null;
        let zoom = 1;
        let panX = 0;
        let panY = 0;
        let stroke = null;
        let pan = null;
        let frameRequest = null;

        // Place the image as the crop view shows it (`placement`: the image's
        // centre, scale, rotation and flip, and the crop box, in view pixels),
        // so the two views match. Without one, fit the image upright.
        function fit(placement) {
            const { width, height } = canvas.getBoundingClientRect();
            const { coverage } = layers;
            const w = coverage.width;
            const h = coverage.height;
            const valid = placement && placement.scale > 0 && Number.isFinite(placement.scale);
            baseScale = valid ? placement.scale : Math.min(width / w, height / h) * 0.9;
            const angle = valid ? ((placement.rotate || 0) * Math.PI) / 180 : 0;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            // Centre, rotate, flip and scale, as Cropper's CSS transform does.
            base = multiply(
                [1, 0, 0, 1, valid ? placement.x : width / 2, valid ? placement.y : height / 2],
                [cos, sin, -sin, cos, 0, 0],
                [
                    baseScale * (valid && placement.scaleX === -1 ? -1 : 1),
                    0,
                    0,
                    baseScale * (valid && placement.scaleY === -1 ? -1 : 1),
                    0,
                    0,
                ],
                [1, 0, 0, 1, -w / 2, -h / 2],
            );
            if (valid && placement.crop && placement.crop.width > 0 && placement.crop.height > 0) {
                crop = placement.crop;
            } else {
                // No crop box: use the image's bounds.
                const corners = [[0, 0], [w, 0], [0, h], [w, h]].map((point) => apply(base, point));
                const xs = corners.map(([x]) => x);
                const ys = corners.map(([, y]) => y);
                const left = Math.min(...xs);
                const top = Math.min(...ys);
                crop = { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
            }
            zoom = 1;
            panX = panY = 0;
        }

        // Image pixels to view pixels, with the brush view's zoom and pan.
        function imageToView() {
            return multiply([zoom, 0, 0, zoom, panX, panY], base);
        }

        function render() {
            frameRequest = null;
            if (!layers) return;
            const { width, height } = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            const pixelWidth = Math.round(width * ratio);
            const pixelHeight = Math.round(height * ratio);
            for (const target of [canvas, layer]) {
                if (target.width !== pixelWidth) target.width = pixelWidth;
                if (target.height !== pixelHeight) target.height = pixelHeight;
            }
            // Device pixels: `view` for the image, `stage` for the crop box
            // (which only zooms and pans, as it is never rotated).
            const view = multiply([ratio, 0, 0, ratio, 0, 0], imageToView());
            const stage = [ratio * zoom, 0, 0, ratio * zoom, ratio * panX, ratio * panY];
            const { original, coverage, background } = layers;
            const context = canvas.getContext('2d');
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, pixelWidth, pixelHeight);
            // The background fills the crop box, as in the crop view; a
            // transparent one lets the container's checks show through. A
            // photo (an object rather than a colour) is cover-fitted to it.
            if (background && typeof background === 'object') {
                context.setTransform(...stage);
                drawCover(context, background.image, crop.left, crop.top, crop.width, crop.height);
            } else if (background !== 'transparent') {
                context.setTransform(...stage);
                context.fillStyle = background;
                context.fillRect(crop.left, crop.top, crop.width, crop.height);
            }
            context.setTransform(1, 0, 0, 1, 0, 0);
            const layerContext = layer.getContext('2d');
            // While restoring, show the erased parts tinted red, like
            // Photoshop's quick mask, so they stand out from the checks and
            // from the kept subject: the original minus the coverage, tinted.
            if (mode === 'restore') {
                drawOnLayer(layerContext, view, original, coverage, 'destination-out');
                layerContext.setTransform(1, 0, 0, 1, 0, 0);
                layerContext.globalCompositeOperation = 'source-atop';
                layerContext.fillStyle = 'rgba(255, 0, 0, 0.35)';
                layerContext.fillRect(0, 0, pixelWidth, pixelHeight);
                context.globalAlpha = 0.6;
                context.drawImage(layer, 0, 0);
                context.globalAlpha = 1;
            }
            drawOnLayer(layerContext, view, original, coverage, 'destination-in');
            context.drawImage(layer, 0, 0);
            // Dim everything outside the crop box, as the crop view's modal
            // does. The even-odd rule fills the whole view except the crop box;
            // the box goes through the same transform as its background, so
            // their edges line up with no undimmed sliver between them.
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.fillStyle = 'rgba(0, 0, 0, 0.3)';
            context.beginPath();
            context.rect(0, 0, pixelWidth, pixelHeight);
            context.setTransform(...stage);
            context.rect(crop.left, crop.top, crop.width, crop.height);
            context.fill('evenodd');
        }

        // Draw the original on the screen-sized layer, then combine it with
        // the coverage: 'destination-in' keeps the cut-out, 'destination-out'
        // keeps the erased parts.
        function drawOnLayer(layerContext, view, original, coverage, operation) {
            layerContext.setTransform(1, 0, 0, 1, 0, 0);
            layerContext.globalCompositeOperation = 'source-over';
            layerContext.clearRect(0, 0, layer.width, layer.height);
            layerContext.setTransform(...view);
            layerContext.drawImage(original, 0, 0);
            layerContext.globalCompositeOperation = operation;
            layerContext.drawImage(coverage, 0, 0);
        }

        // Pointer moves can arrive faster than the screen refreshes.
        function requestRender() {
            if (frameRequest) return;
            if (typeof requestAnimationFrame === 'function')
                frameRequest = requestAnimationFrame(render);
            else render();
        }

        function imagePoint(event) {
            const rect = canvas.getBoundingClientRect();
            return apply(invert(imageToView()), [event.clientX - rect.left, event.clientY - rect.top]);
        }

        function moveCursor(event) {
            const rect = canvas.getBoundingClientRect();
            cursor.hidden = panning;
            cursor.style.width = cursor.style.height = `${size}px`;
            cursor.style.transform = `translate(${event.clientX - rect.left - size / 2}px, ${
                event.clientY - rect.top - size / 2
            }px)`;
        }

        // Keep the point under (x, y) fixed while zooming.
        function zoomAt(factor, x, y) {
            const next = Math.min(Math.max(zoom * factor, 0.5), 32);
            panX = x - ((x - panX) * next) / zoom;
            panY = y - ((y - panY) * next) / zoom;
            zoom = next;
            requestRender();
        }

        canvas.addEventListener('pointerdown', (event) => {
            if (!layers || stroke || pan) return;
            event.preventDefault();
            if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
            // The middle button pans in any mode, as in most image editors.
            if (panning || event.button === 1) {
                pan = { id: event.pointerId, x: event.clientX - panX, y: event.clientY - panY };
                return;
            }
            if (event.button !== 0) return;
            stroke = {
                id: event.pointerId,
                mode,
                size: size / (baseScale * zoom),
                points: [imagePoint(event)],
            };
            paintStroke(layers.coverage.getContext('2d'), stroke);
            requestRender();
        });
        canvas.addEventListener('pointermove', (event) => {
            if (!layers) return;
            moveCursor(event);
            if (pan && event.pointerId === pan.id) {
                panX = event.clientX - pan.x;
                panY = event.clientY - pan.y;
                requestRender();
                return;
            }
            if (!stroke || event.pointerId !== stroke.id) return;
            const point = imagePoint(event);
            const last = stroke.points[stroke.points.length - 1];
            // Points closer than a screen pixel add nothing visible.
            if (Math.hypot(point[0] - last[0], point[1] - last[1]) * baseScale * zoom < 1) return;
            stroke.points.push(point);
            paintStroke(layers.coverage.getContext('2d'), stroke, stroke.points.length - 1);
            requestRender();
        });
        function finish(event) {
            if (pan && event.pointerId === pan.id) pan = null;
            if (!stroke || event.pointerId !== stroke.id) return;
            const { mode: strokeMode, size: strokeSize, points } = stroke;
            stroke = null;
            onStroke({ mode: strokeMode, size: strokeSize, points });
        }
        canvas.addEventListener('pointerup', finish);
        canvas.addEventListener('pointercancel', finish);
        canvas.addEventListener('pointerleave', () => {
            cursor.hidden = true;
        });
        canvas.addEventListener(
            'wheel',
            (event) => {
                if (!layers) return;
                event.preventDefault();
                const rect = canvas.getBoundingClientRect();
                zoomAt(
                    Math.exp(-event.deltaY * 0.002),
                    event.clientX - rect.left,
                    event.clientY - rect.top,
                );
            },
            { passive: false },
        );

        return {
            show(next, placement) {
                layers = next;
                canvas.hidden = false;
                fit(placement);
                render();
            },
            hide() {
                layers = null;
                stroke = null;
                pan = null;
                canvas.hidden = true;
                cursor.hidden = true;
                // Release the screen-sized buffers.
                canvas.width = canvas.height = layer.width = layer.height = 0;
            },
            render: requestRender,
            resize(placement) {
                if (!layers) return;
                fit(placement);
                requestRender();
            },
            // A colour, 'transparent', or a photo ({ image }).
            setBackground(background) {
                if (!layers) return;
                layers.background = background;
                requestRender();
            },
            setMode(next) {
                mode = next;
                requestRender();
            },
            setPanning(next) {
                panning = next;
                canvas.classList.toggle('brush-panning', panning);
                cursor.hidden = true;
            },
            setSize(next) {
                size = next;
            },
            // Returns false when closed, so the zoom buttons fall back to the cropper.
            zoom(factor) {
                if (!layers) return false;
                const { width, height } = canvas.getBoundingClientRect();
                zoomAt(factor, width / 2, height / 2);
                return true;
            },
        };
    }

    return { coverageFromMask, paintStrokes, composite, createView, drawCover };
})();
