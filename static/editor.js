// Image lifecycle, cropper, uploads, and downloads. Controls register their UI hooks below.
window.ImageEditor = (() => {
    'use strict';

    const ImageBrush = window.ImageBrush;
    let controls;
    const imageRecords = new Map();
    let exportBusy = false;
    let cropper = null;
    let selectedFile = null;
    let imageRequestId = 0;
    let imageAbortController = null;
    let applyingToAll = false;
    // The open brush view's image and full-size layers; see openBrush.
    let brushSession = null;
    // Gives each brush state a unique number, so a cut-out records which one it shows.
    let brushVersions = 0;
    // The picture the cropper is showing, so swapping to it again is skipped.
    let shownUrl = null;
    let selectedFileName = '';
    let sourceDimensions = null;
    // A colour, 'transparent', or 'photo' (backgroundPhoto, cover-fitted).
    let selectedBackground = 'transparent';
    // { url, image }: a decoded photo, shared by every image
    // and undo step that uses it.
    let backgroundPhoto = null;
    let rotationAngle = 0;
    let horizontalScale = 1;
    let verticalScale = 1;
    const MAX_UPLOAD_SIDE = 2048;
    const HISTORY_LIMIT = 50;
    // The server straightens photos by their EXIF orientation before computing
    // the mask, so decode them the same way. Stated explicitly because older
    // browsers defaulted to ignoring EXIF orientation here.
    const UPRIGHT = { imageOrientation: 'from-image' };
    const previewImage = document.getElementById('image');
    const fileInput = document.getElementById('imageInput');
    const removeBgCheckbox = document.getElementById('removeBg');
    const widthInput = document.getElementById('widthInput');
    const heightInput = document.getElementById('heightInput');
    const bgColorInput = document.getElementById('bgColor');
    const transparentBgButton = document.getElementById('transparentBg');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const uploadPlaceholder = document.getElementById('uploadPlaceholder');

    function showLoading() {
        loadingOverlay.style.display = 'flex';
    }

    function hideLoading() {
        loadingOverlay.style.display = 'none';
    }

    function currentAspectRatio() {
        const preset = document.getElementById('aspectRatioPreset');
        return preset.value === 'free'
            ? NaN
            : preset.value === 'original'
              ? sourceDimensions.width / sourceDimensions.height
              : preset.value === 'custom'
                ? Number(widthInput.value) / Number(heightInput.value)
                : Number(preset.value);
    }

    function initCropper(record) {
        const requestId = imageRequestId;
        if (cropper) {
            cropper.destroy();
        }

        previewImage.style.display = 'block';
        uploadPlaceholder.style.display = 'none';

        const options = {
            aspectRatio: currentAspectRatio(),
            viewMode: 0,
            autoCropArea: 1,
            background: true,
            // The stage's ResizeObserver calls resizeCropper instead, which
            // keeps the image's size; Cropper's own handler would scale it.
            responsive: typeof ResizeObserver === 'undefined',
            restore: true,
            center: true,
            highlight: false,
            cropBoxMovable: true,
            cropBoxResizable: true,
            guides: true,
            dragMode: 'crop',
            // The hand button switches modes, so a double-click must not do it unseen.
            toggleDragModeOnDblclick: false,
            fillColor: fillColor(selectedBackground),
            minContainerWidth: 0,
            minContainerHeight: 0,
            minCropBoxWidth: 10,
            minCropBoxHeight: 10,
            minCanvasWidth: 0,
            minCanvasHeight: 0,
            movable: true,
            scalable: true,
            zoomable: true,
            rotatable: true,
            wheelZoomRatio: 0.1,
            minZoom: 0.01, // Allow zooming out to 1% of original size
            maxZoom: 100, // Allow zooming in to 10000% of original size
            // Fires once a crop-box drag or resize finishes, not on every frame.
            cropend: function () {
                if (requestId === imageRequestId) commitEdit();
            },
            ready: function () {
                if (requestId !== imageRequestId || !cropper) return;
                controls.applyImageTransform();
                record.status = 'ready';
                controls.setToolControlsDisabled(false);
                controls.updateBackgroundColor(selectedBackground);
                applyPanning();
                const cropBox = document.querySelector('.cropper-crop-box');
                if (cropBox) {
                    cropBox.style.cursor = 'move';
                    const handles = cropBox.querySelectorAll('.cropper-point');
                    handles.forEach((handle) => {
                        handle.style.cursor = 'pointer';
                        handle.style.width = '14px';
                        handle.style.height = '14px';
                    });
                    const edges = cropBox.querySelectorAll('.cropper-line');
                    edges.forEach((edge) => {
                        edge.style.cursor = 'move';
                    });
                }

                // Set initial zoom to fit the container
                const container = document.querySelector('.image-container');
                if (container) {
                    const containerWidth = container.clientWidth;
                    const containerHeight = container.clientHeight;
                    const imageData = cropper.getImageData();
                    const scale = Math.min(
                        (containerWidth - 50) / imageData.naturalWidth,
                        (containerHeight - 50) / imageData.naturalHeight,
                    );
                    cropper.zoomTo(scale);
                }
                // zoomTo changes the image scale without resizing the crop box.
                // Apply the full-image crop afterwards, or restore this image's edits.
                cropper.setData(record.cropData || {
                    x: 0,
                    y: 0,
                    width: cropper.getImageData().naturalWidth,
                    height: cropper.getImageData().naturalHeight,
                    rotate: rotationAngle,
                    scaleX: horizontalScale,
                    scaleY: verticalScale,
                });
                // Re-baseline on every load: revisiting an image keeps its history,
                // but the restored crop may differ by rounding from the saved one.
                // A load that also switched removal (toggled mid-load, or "Apply to
                // all images") keeps the previous state as an undo step.
                record.history = record.history || { past: [], future: [] };
                const snapshot = takeSnapshot();
                const previous = record.history.current;
                if (
                    previous &&
                    previous.settings.removeBackground !== snapshot.settings.removeBackground
                ) {
                    record.history.past.push(previous);
                    if (record.history.past.length > HISTORY_LIMIT) record.history.past.shift();
                    record.history.future = [];
                }
                record.history.current = snapshot;
                controls.updateDownloadState();
                controls.syncBrushPanel();
                if (controls.brushToolActive()) openBrush();
            },
        };

        cropper = new Cropper(previewImage, options);
    }

    // The hand beside the zoom buttons pans the crop view and the brush view.
    let panning = false;
    const panToggle = document.getElementById('panToggle');

    function applyPanning() {
        panToggle.setAttribute('aria-pressed', String(panning));
        dropZone.classList.toggle('panning', panning);
        brushView.setPanning(panning);
        if (!cropper || !cropper.ready) return;
        cropper.setDragMode(panning ? 'move' : 'crop');
        // Cropper's move mode still moves the crop box when dragged inside it,
        // which usually covers most of the view. Point the crop box's face at
        // the image instead ('all' is Cropper's own action for moving the box).
        const face = document.querySelector('.cropper-face');
        if (face) face.dataset.cropperAction = panning ? 'move' : 'all';
    }

    panToggle.addEventListener('click', () => {
        panning = !panning;
        applyPanning();
    });

    // Register zoom handlers once, independent of cropper recreation.
    // While the brush view is open, the zoom buttons zoom it instead.
    document.getElementById('zoomIn').addEventListener('click', () => {
        if (brushView.zoom(1.25)) return;
        if (cropper && cropper.ready) cropper.zoom(0.1);
    });
    document.getElementById('zoomOut').addEventListener('click', () => {
        if (brushView.zoom(0.8)) return;
        if (cropper && cropper.ready) cropper.zoom(-0.1);
    });

    function invalidateImageProcessing() {
        endBrush();
        shownUrl = null;
        controls.setToolControlsDisabled(true);
        const previous = imageRecords.get(selectedFile);
        if (previous && previous.status === 'loading')
            previous.status = 'interrupted';
        imageRequestId += 1;
        if (imageAbortController) {
            imageAbortController.abort();
            imageAbortController = null;
        }
        // Do not leave the previous image available under a new filename.
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }
        controls.updateDownloadState();
        // The displayed URL belongs to the image's record and is reused when
        // switching back, so it is released only when the image is removed.
        previewImage.removeAttribute('src');
        previewImage.style.display = 'none';
    }

    // Phone photos are 12 MP+, which mask detection does not need. Downscale
    // before upload to cut transfer and server time; applyMask restores full
    // resolution. Files the browser cannot decode (such as TIFF) are sent
    // unchanged, and the server returns the finished cut-out for those instead.
    async function prepareUpload(file) {
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, UPRIGHT);
        } catch (_) {
            return { upload: file, decodable: false };
        }
        try {
            const scale = MAX_UPLOAD_SIDE / Math.max(bitmap.width, bitmap.height);
            if (scale >= 1) return { upload: file, decodable: true };
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bitmap.width * scale);
            canvas.height = Math.round(bitmap.height * scale);
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            // JPEG keeps photos small; other formats may be transparent, so use PNG.
            const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
            return { upload: blob || file, decodable: true };
        } finally {
            bitmap.close();
        }
    }

    // Rebuild the cut-out at the original's full size: stretch the (possibly
    // smaller) mask over the photo, then use its brightness as transparency.
    async function applyMask(file, maskBlob) {
        const image = await createImageBitmap(file, UPRIGHT);
        const canvas = document.createElement('canvas');
        let mask;
        try {
            mask = await createImageBitmap(maskBlob);
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('Could not create the cut-out canvas.');
            context.drawImage(mask, 0, 0, canvas.width, canvas.height);
            const coverage = context.getImageData(0, 0, canvas.width, canvas.height).data;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0);
            const cutout = context.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = cutout.data;
            // The mask is greyscale, so its red channel is the coverage. Multiply
            // so pixels that were already transparent in the original stay so.
            for (let alpha = 3; alpha < pixels.length; alpha += 4)
                pixels[alpha] = (pixels[alpha] * coverage[alpha - 3]) / 255;
            context.putImageData(cutout, 0, 0);
        } finally {
            // Release the decoded photo and mask before the slow PNG encode.
            image.close();
            if (mask) mask.close();
        }
        return canvasToBlob(canvas);
    }

    // Decode a picture so the cropper can show it at once. Returns null when a
    // newer request has taken over, so callers stop without touching the editor.
    async function decodeView(blob, isStale) {
        const url = URL.createObjectURL(blob);
        try {
            const preview = new Image();
            preview.src = url;
            await preview.decode();
            if (isStale()) {
                URL.revokeObjectURL(url);
                return null;
            }
            return { url, width: preview.naturalWidth, height: preview.naturalHeight };
        } catch (error) {
            URL.revokeObjectURL(url);
            throw error;
        }
    }

    // Each image keeps its decoded original and cut-out once made, so switching
    // between them, or back to the image, needs no reprocessing.
    async function loadOriginal(record, isStale) {
        if (record.original) return record.original;
        try {
            const view = await decodeView(record.file, isStale);
            if (view) record.original = view;
            return view;
        } catch (error) {
            error.userMessage = 'This image could not be opened. Try another image file.';
            throw error;
        }
    }

    async function loadCutout(record, signal, isStale) {
        if (freshCutout(record)) return record.cutout;
        const version = brushVersion(record);
        let failureMessage = 'Could not open this image. Try another image file.';
        try {
            // The server's result is kept too, so a cut-out that failed to
            // decode can be rebuilt without uploading the image again.
            if (!record.removal) {
                const { upload, decodable } = await prepareUpload(record.file);
                if (isStale()) return null;
                const formData = new FormData();
                formData.append('file', upload, record.file.name);
                failureMessage = 'Could not reach background removal. Check your connection and try again.';
                const response = await fetch(decodable ? '/remove-bg/mask' : '/remove-bg', {
                    method: 'POST',
                    body: formData,
                    signal,
                });
                if (isStale()) return null;
                if (!response.ok) {
                    const error = new Error('Background removal failed.');
                    error.userMessage = response.status === 413
                        ? 'Image upload is too large. Use a smaller image and try again.'
                        : 'Background removal failed. Please try again.';
                    try {
                        const details = await response.json();
                        if (typeof details.message === 'string' && details.message.trim()) {
                            error.userMessage = details.message;
                        }
                    } catch (_) {
                        // A proxy may return HTML instead of the API's JSON error.
                    }
                    throw error;
                }
                failureMessage = 'Could not read the processed image. Please try again.';
                // Decodable files get a mask to apply here; the others get the
                // server's finished cut-out.
                record.removal = { blob: await response.blob(), isMask: decodable };
            }
            let blob = record.removal.blob;
            if (record.removal.isMask) {
                failureMessage = 'Could not apply the background removal. Please try again.';
                blob = version
                    ? await renderBrushedCutout(record)
                    : await applyMask(record.file, blob);
                if (isStale()) return null;
            }
            failureMessage = 'The processed image could not be opened. Please try again.';
            const view = await decodeView(blob, isStale);
            if (view) {
                // An older cut-out may still be on screen until the caller swaps
                // in this one; an already-loaded image is unaffected by revoking.
                if (record.cutout) URL.revokeObjectURL(record.cutout.url);
                record.cutout = view;
                record.cutoutVersion = version;
            }
            return view;
        } catch (error) {
            if (!error.userMessage) error.userMessage = failureMessage;
            throw error;
        }
    }

    // Build the cropper for an image, showing its cut-out or original according
    // to its own removal setting.
    async function processSelectedImage(file, resetEdits = true) {
        if (!resetEdits) saveCurrentImage();
        invalidateImageProcessing();
        const record = imageRecords.get(file);
        record.status = 'loading';
        record.savedCanvas = null;
        record.exportError = null;
        // Kept on the record, so a load restarted by the switch still resets.
        if (resetEdits) {
            record.cropData = null;
            record.needsReset = true;
        }
        const requestId = imageRequestId;
        const isStale = () => requestId !== imageRequestId;
        const controller = new AbortController();
        imageAbortController = controller;
        let failureMessage = 'Could not open this image. Try another image file.';
        showLoading();

        try {
            let view = null;
            if (record.removeBackground) {
                try {
                    view = await loadCutout(record, controller.signal, isStale);
                } catch (error) {
                    if (isStale() || error.name === 'AbortError') return;
                    // The original can still be edited, so turn removal off
                    // rather than discard the image.
                    console.error('Error:', error);
                    record.removeBackground = false;
                    removeBgCheckbox.checked = false;
                    alert(error.userMessage);
                }
                if (isStale()) return;
            }
            view = view || (await loadOriginal(record, isStale));
            if (!view) return;
            failureMessage = 'Could not prepare the editor. Upload the image again to retry.';

            // A server cut-out (for files the browser cannot decode) can differ
            // in size from the original. The kept crop is in the pixels of the
            // image the cropper was last built on; rescale it to cover the same area.
            const size = { width: view.width, height: view.height };
            const previous = record.imageSize;
            if (
                !record.needsReset &&
                record.cropData &&
                previous &&
                (previous.width !== size.width || previous.height !== size.height)
            ) {
                const scaleX = size.width / previous.width;
                const scaleY = size.height / previous.height;
                record.cropData = {
                    ...record.cropData,
                    x: record.cropData.x * scaleX,
                    y: record.cropData.y * scaleY,
                    width: record.cropData.width * scaleX,
                    height: record.cropData.height * scaleY,
                };
            }
            record.imageSize = size;

            if (record.needsReset) {
                record.needsReset = false;
                controls.resetImageTransform();
                sourceDimensions = size;
                widthInput.value = String(sourceDimensions.width);
                heightInput.value = String(sourceDimensions.height);
                document.getElementById('aspectRatioPreset').value = 'original';
                controls.syncPresetMenu();
            }
            previewImage.src = view.url;
            shownUrl = view.url;
            initCropper(record);
            if (cropper.ready) record.status = 'ready';
            controls.updateDownloadState();
        } catch (error) {
            if (isStale() || error.name === 'AbortError') return;
            record.status = 'error';
            console.error('Error:', error);
            removeImage(file);
            alert(error.userMessage || failureMessage);
        } finally {
            if (!isStale()) {
                imageAbortController = null;
                hideLoading();
                controls.updateDownloadState();
            }
        }
    }

    // Switch the current image between its original and its cut-out. Both are
    // kept once made, so this swaps the picture inside the existing cropper:
    // the crop and transforms stay put, and the switch is one undo step.
    async function setRemoveBackground(on) {
        const file = selectedFile;
        const record = imageRecords.get(file);
        if (!record) return;
        removeBgCheckbox.checked = on;
        if (!cropper || !cropper.ready || imageAbortController) {
            // Still loading: start again with the new setting.
            record.removeBackground = on;
            await processSelectedImage(file, false);
            return;
        }
        if (Boolean(record.removeBackground) === on) return;
        // Record an edit still in progress (such as a typed width) as its own step.
        commitEdit();
        // The brush paints on the cut-out, so it closes with removal; its
        // strokes stay on the image for when removal is turned on again.
        if (!on) endBrush();
        let view = on ? freshCutout(record) : record.original;
        if (!view) {
            const requestId = imageRequestId;
            view = await whileBusy((signal, isStale) =>
                on ? loadCutout(record, signal, isStale) : loadOriginal(record, isStale),
            );
            if (requestId !== imageRequestId) return;
            if (!view) {
                removeBgCheckbox.checked = Boolean(record.removeBackground);
                return;
            }
        }
        record.removeBackground = on;
        showView(view);
        commitEdit();
        controls.syncBrushPanel();
        // The switch sits in the Cutout panel, so turning it on there opens the brush.
        if (on && controls.brushToolActive()) openBrush();
    }

    // Run work on the open image while its picture stays on screen; the
    // controls, undo and download wait for it. Resolves to the task's result,
    // or null if it failed (after an alert) or the user moved to another image.
    async function whileBusy(task) {
        const requestId = imageRequestId;
        const isStale = () => requestId !== imageRequestId;
        const controller = new AbortController();
        imageAbortController = controller;
        controls.setToolControlsDisabled(true);
        controls.updateDownloadState();
        showLoading();
        try {
            const result = await task(controller.signal, isStale);
            return isStale() ? null : result;
        } catch (error) {
            if (!isStale() && error.name !== 'AbortError') {
                console.error('Error:', error);
                alert(error.userMessage || 'Something went wrong. Please try again.');
            }
            return null;
        } finally {
            if (!isStale()) {
                imageAbortController = null;
                hideLoading();
                controls.setToolControlsDisabled(false);
                controls.updateDownloadState();
            }
        }
    }

    // Both pictures are already decoded, so the browser shows the new one at
    // once. Cropper keeps its canvas and crop box when told the size is the
    // same; a server cut-out of another size is stretched to the original's,
    // which it matches in shape, so the crop still covers the same area.
    function showView(view) {
        if (view.url === shownUrl) return;
        shownUrl = view.url;
        cropper.replace(view.url, true);
    }

    function brushVersion(record) {
        return record.brush ? record.brush.version : 0;
    }

    // The cut-out, unless brush strokes have changed since it was made.
    function freshCutout(record) {
        return record.cutout && record.cutoutVersion === brushVersion(record)
            ? record.cutout
            : null;
    }

    // Show the picture that matches the image's removal setting, rebuilding the
    // cut-out first if brush strokes have changed since it was made.
    async function showCurrentPicture() {
        const record = imageRecords.get(selectedFile);
        if (!record || !cropper || !cropper.ready) return;
        if (!record.removeBackground) {
            if (record.original) showView(record.original);
            return;
        }
        const view =
            freshCutout(record) ||
            (await whileBusy((signal, isStale) => loadCutout(record, signal, isStale)));
        if (view && record.removeBackground && selectedFile === record.file) showView(view);
    }

    // Reset returns to the image as uploaded: background back, and crop,
    // rotation, flip and size at their defaults. The cut-out is kept, so
    // turning removal on again is instant.
    function resetImage() {
        const record = imageRecords.get(selectedFile);
        if (!record || !cropper) return;
        // Brush edits are discarded too; turning removal on again rebuilds the
        // cut-out from the stored mask, without uploading.
        endBrush();
        record.brush = null;
        record.removeBackground = false;
        removeBgCheckbox.checked = false;
        clearHistory();
        processSelectedImage(selectedFile);
    }

    // Apply the current image's removal setting to every image. Each one is
    // opened in turn, so its saved export is redrawn with the change.
    async function applyRemovalToAll() {
        if (applyingToAll || !selectedFile) return;
        const start = selectedFile;
        const on = removeBgCheckbox.checked;
        applyingToAll = true;
        try {
            await setRemoveBackground(on);
            if (selectedFile !== start || Boolean(imageRecords.get(start).removeBackground) !== on)
                return;
            for (const [file, record] of [...imageRecords]) {
                if (!imageRecords.has(file) || Boolean(record.removeBackground) === on) continue;
                record.removeBackground = on;
                await selectFile(file);
                // Stop if the user opened another image or this one failed.
                if (selectedFile !== file || record.removeBackground !== on) return;
            }
            if (imageRecords.has(start)) await selectFile(start);
        } finally {
            applyingToAll = false;
        }
    }

    // Where a colour is needed (Cropper's fill), a photo background fills
    // nothing; it is drawn separately, cover-fitted.
    function fillColor(background) {
        return background === 'photo' ? 'transparent' : background;
    }

    // The brush view takes a colour, or the photo itself.
    function brushBackground() {
        if (selectedBackground !== 'photo') return selectedBackground;
        return backgroundPhoto || 'transparent';
    }

    // Decode a chosen background photo, so it can be drawn at once and the
    // export (which runs without waiting) can use it.
    async function loadBackgroundPhoto(file) {
        const url = URL.createObjectURL(file);
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            return { url, image };
        } catch (error) {
            URL.revokeObjectURL(url);
            error.userMessage = 'This photo could not be opened. Try another image file.';
            throw error;
        }
    }

    // Why the brush is unavailable for a cut-out. With removal off the panel
    // just hides the brush, as its switch sits right above.
    function brushHint() {
        const record = imageRecords.get(selectedFile);
        if (record && record.removeBackground && record.removal && !record.removal.isMask)
            return 'Touch-ups are not available for this file type.';
        return '';
    }

    function appliedStrokes(record) {
        return record.brush ? record.brush.strokes.slice(0, record.brush.applied) : [];
    }

    // The full-size original and coverage the brush paints on. They are large
    // (four bytes a pixel each), so they exist only while needed.
    async function loadBrushLayers(record) {
        const original = await createImageBitmap(record.file, UPRIGHT);
        let mask;
        try {
            mask = await createImageBitmap(record.removal.blob);
            const coverage = ImageBrush.coverageFromMask(mask, original.width, original.height);
            ImageBrush.paintStrokes(coverage, appliedStrokes(record));
            return { original, mask, coverage };
        } catch (error) {
            original.close();
            if (mask) mask.close();
            throw error;
        }
    }

    function releaseBrushLayers({ original, mask, coverage }) {
        original.close();
        mask.close();
        coverage.width = coverage.height = 0;
    }

    async function renderBrushedCutout(record) {
        const layers = await loadBrushLayers(record);
        try {
            return await canvasToBlob(ImageBrush.composite(layers.original, layers.coverage));
        } finally {
            releaseBrushLayers(layers);
        }
    }

    // Open the brush view over the cropper for the current cut-out.
    async function openBrush() {
        const record = imageRecords.get(selectedFile);
        if (
            brushSession ||
            !record ||
            !record.removeBackground ||
            brushHint() ||
            !record.removal ||
            !cropper ||
            !cropper.ready ||
            imageAbortController
        )
            return;
        const session = { record, layers: null };
        brushSession = session;
        controls.syncBrushPanel();
        const layers = await whileBusy(async () => {
            try {
                return await loadBrushLayers(record);
            } catch (error) {
                error.userMessage = 'Could not open the brush. Please try again.';
                throw error;
            }
        });
        if (brushSession !== session) {
            if (layers) releaseBrushLayers(layers);
            return;
        }
        if (!layers) {
            brushSession = null;
            controls.syncBrushPanel();
            return;
        }
        session.layers = layers;
        dropZone.classList.add('brushing');
        brushView.show({ ...layers, background: brushBackground() }, cropperFrame(layers));
    }

    // How the crop view shows the image, relative to the brush view (which
    // covers the whole stage): the image's centre, scale, rotation and flip,
    // and the crop box. Cropper's canvas is the rotated image's bounding box,
    // so its centre is the image's centre; imageData.width is the shown width
    // before rotation.
    function cropperFrame({ coverage }) {
        if (!cropper || !cropper.ready) return null;
        const canvasData = cropper.getCanvasData();
        const imageData = cropper.getImageData();
        if (!canvasData || !imageData || !imageData.width) return null;
        const stage = dropZone.getBoundingClientRect();
        const box = cropper.cropper ? cropper.cropper.getBoundingClientRect() : stage;
        const left = box.left - stage.left;
        const top = box.top - stage.top;
        const cropBox = cropper.getCropBoxData();
        return {
            x: left + canvasData.left + canvasData.width / 2,
            y: top + canvasData.top + canvasData.height / 2,
            scale: imageData.width / coverage.width,
            rotate: rotationAngle,
            scaleX: horizontalScale,
            scaleY: verticalScale,
            crop:
                cropBox && cropBox.width
                    ? {
                          left: left + cropBox.left,
                          top: top + cropBox.top,
                          width: cropBox.width,
                          height: cropBox.height,
                      }
                    : null,
        };
    }

    // Fit the crop view to a resized stage (a panel opening or closing, or the
    // window resizing). Cropper's resize scales the picture with the stage's
    // width, so a wider stage made it taller than the stage. Instead, keep
    // its size and its place relative to the centre, and only shrink it if it
    // would no longer fit (keeping any overflow from zooming in).
    function resizeCropper() {
        if (!cropper || !cropper.ready) return;
        const before = cropper.getContainerData();
        const canvasData = cropper.getCanvasData();
        const cropBox = cropper.getCropBoxData();
        cropper.resize();
        if (!canvasData) return;
        const after = cropper.getContainerData();
        if (!before.width || (after.width === before.width && after.height === before.height)) return;
        const boxes = cropBox.width ? [canvasData, cropBox] : [canvasData];
        const oldX = before.width / 2;
        const oldY = before.height / 2;
        // How far the picture reaches from the centre, against the room there
        // is (keeping a 25 px margin, as the first fit does): over 1 overflows.
        const reach = (container) =>
            Math.max(
                ...boxes.map(({ left, width }) =>
                    Math.max(Math.abs(left - oldX), Math.abs(left + width - oldX)) /
                    Math.max(container.width / 2 - 25, 1),
                ),
                ...boxes.map(({ top, height }) =>
                    Math.max(Math.abs(top - oldY), Math.abs(top + height - oldY)) /
                    Math.max(container.height / 2 - 25, 1),
                ),
            );
        const scale = Math.min(1, Math.max(reach(before), 1) / reach(after));
        const place = ({ left, top, width, height }) => ({
            left: after.width / 2 + (left - oldX) * scale,
            top: after.height / 2 + (top - oldY) * scale,
            width: width * scale,
            height: height * scale,
        });
        cropper.setCanvasData(place(canvasData));
        if (cropBox.width) cropper.setCropBoxData(place(cropBox));
    }

    function resizeBrush() {
        if (brushSession && brushSession.layers)
            brushView.resize(cropperFrame(brushSession.layers));
    }

    // Close the brush view without updating the cut-out.
    function endBrush() {
        const session = brushSession;
        if (!session) return;
        brushSession = null;
        brushView.hide();
        dropZone.classList.remove('brushing');
        if (session.layers) releaseBrushLayers(session.layers);
        controls.syncBrushPanel();
    }

    // Close the brush view and show the cut-out with its strokes, rebuilding it
    // once here rather than after every stroke.
    async function closeBrush() {
        if (!brushSession) return;
        endBrush();
        await showCurrentPicture();
    }

    // A finished stroke is one undo step. It is already painted on the view's
    // coverage; the image keeps the stroke itself, so undo can replay them.
    function addStroke(stroke) {
        if (!brushSession) return;
        const { record } = brushSession;
        const brush = record.brush || (record.brush = { strokes: [], applied: 0, version: 0 });
        // A stroke after undo replaces the undone ones, as redo is cleared too.
        brush.strokes.length = brush.applied;
        brush.strokes.push(stroke);
        brush.applied = brush.strokes.length;
        brush.version = ++brushVersions;
        commitEdit();
    }

    function repaintBrush() {
        const { record, layers } = brushSession;
        if (!layers) return;
        ImageBrush.coverageFromMask(
            layers.mask,
            layers.original.width,
            layers.original.height,
            layers.coverage,
        );
        ImageBrush.paintStrokes(layers.coverage, appliedStrokes(record));
        brushView.render();
    }

    // Handle drag and drop functionality
    const dropZone = document.getElementById('dropZone');
    const brushView = ImageBrush.createView(dropZone, addStroke);

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files && files.length) {
            handleFiles(Array.from(files));
        }
    });

    // Paste screenshots or copied images anywhere on the page. Text pastes carry
    // no image files, so they still reach the focused input untouched.
    document.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []).filter((file) =>
            file.type.startsWith('image/'),
        );
        if (!files.length) return;
        e.preventDefault();
        handleFiles(files);
    });

    function handleFiles(files) {
        if (!files.length) return;
        const defaults = { background: selectedBackground, photo: backgroundPhoto };
        files.forEach((file) => {
            imageRecords.set(file, {
                file,
                status: 'unvisited',
                settings: null,
                savedCanvas: null,
            });
            addToBatchImages(file);
        });
        selectFile(files[0], defaults);
    }

    function selectFile(file, defaults = null) {
        if (file === selectedFile && cropper && cropper.ready) return Promise.resolve();
        // Bake brush strokes into the cut-out first, so its saved export has them.
        if (brushSession) return closeBrush().then(() => selectFile(file, defaults));
        saveCurrentImage();
        invalidateImageProcessing();
        selectedFile = file;
        selectedFileName = file.name;
        const record = imageRecords.get(file);
        if (record.settings) restoreImageSettings(record.settings);
        else {
            selectedBackground = defaults ? defaults.background : 'transparent';
            backgroundPhoto = defaults ? defaults.photo : null;
            controls.syncBackgroundControls();
        }
        // New uploads start with removal off; each image keeps its own setting.
        removeBgCheckbox.checked = Boolean(record.removeBackground);
        updateSelectedThumbnail();
        uploadPlaceholder.style.display = 'none';
        return processSelectedImage(file, !record.settings);
    }

    function captureImageSettings() {
        return {
            width: widthInput.value,
            height: heightInput.value,
            preset: document.getElementById('aspectRatioPreset').value,
            sourceDimensions,
            removeBackground: Boolean(imageRecords.get(selectedFile)?.removeBackground),
            background: selectedBackground,
            photo: backgroundPhoto,
            customColor: bgColorInput.value,
            rotation: rotationAngle,
            horizontalScale,
            verticalScale,
        };
    }

    function restoreImageSettings(settings) {
        widthInput.value = settings.width;
        heightInput.value = settings.height;
        document.getElementById('aspectRatioPreset').value = settings.preset;
        sourceDimensions = settings.sourceDimensions;
        selectedBackground = settings.background;
        backgroundPhoto = settings.photo;
        bgColorInput.value = settings.customColor;
        rotationAngle = settings.rotation;
        horizontalScale = settings.horizontalScale;
        verticalScale = settings.verticalScale;
        controls.syncPresetMenu();
        controls.syncRotationControls();
        controls.syncBackgroundControls();
    }

    // Each image keeps its own history of whole-editor snapshots. Undo restores
    // a snapshot onto the live cropper, so no image is reprocessed.
    function takeSnapshot() {
        const record = imageRecords.get(selectedFile);
        return {
            settings: captureImageSettings(),
            cropData: { ...cropper.getData() },
            strokes: record && record.brush ? record.brush.applied : 0,
        };
    }

    function historyReady() {
        const record = imageRecords.get(selectedFile);
        return record && record.history && cropper && cropper.ready && !imageAbortController
            ? record.history
            : null;
    }

    function commitEdit() {
        const history = historyReady();
        if (!history) return;
        const snapshot = takeSnapshot();
        if (JSON.stringify(snapshot) === JSON.stringify(history.current)) return;
        history.past.push(history.current);
        if (history.past.length > HISTORY_LIMIT) history.past.shift();
        history.current = snapshot;
        history.future = [];
        controls.updateDownloadState();
    }

    function applySnapshot({ settings, cropData, strokes = 0 }) {
        const record = imageRecords.get(selectedFile);
        if (record.brush && record.brush.applied !== strokes) {
            record.brush.applied = strokes;
            record.brush.version = ++brushVersions;
            if (brushSession) repaintBrush();
        }
        // A step that switched removal swaps the picture back as well.
        record.removeBackground = settings.removeBackground;
        removeBgCheckbox.checked = settings.removeBackground;
        restoreImageSettings(settings);
        cropper.setAspectRatio(currentAspectRatio());
        controls.applyImageTransform();
        cropper.setData(cropData);
        controls.updateBackgroundColor(selectedBackground);
        brushView.setBackground(brushBackground());
        if (!record.removeBackground) endBrush();
        controls.syncBrushPanel();
        // While brushing, the cut-out is rebuilt when the view closes.
        if (record.removeBackground && controls.brushToolActive()) {
            if (!brushSession)
                openBrush().then(() => {
                    if (!brushSession) showCurrentPicture();
                });
            return;
        }
        showCurrentPicture();
    }

    function stepHistory(from, to) {
        // Record an edit still in progress (such as a typed width) so it can be redone.
        commitEdit();
        const history = historyReady();
        if (!history || !history[from].length) return;
        history[to].push(history.current);
        history.current = history[from].pop();
        applySnapshot(history.current);
        controls.updateDownloadState();
    }

    // Reset starts the image afresh, so earlier snapshots no longer apply.
    function clearHistory() {
        const record = imageRecords.get(selectedFile);
        if (record) record.history = null;
        controls.updateDownloadState();
    }

    // Capture pixels before destroying the cropper. An inactive image's canvas is immutable,
    // so ZIP creation can use it without changing the visible editor or replaying edits.
    function saveCurrentImage() {
        const record = imageRecords.get(selectedFile);
        if (!record || !cropper || !cropper.ready) return;
        record.settings = captureImageSettings();
        record.cropData = { ...cropper.getData() };
        // A cut-out missing its latest strokes must not be exported; the image
        // is then reported as needing to be opened again.
        if (record.removeBackground && !freshCutout(record)) {
            record.savedCanvas = null;
            record.exportError = new Error('Brush edits are not applied yet.');
            return;
        }
        try {
            record.savedCanvas = createExportCanvas(cropper, record.settings);
            record.exportError = null;
        } catch (error) {
            record.savedCanvas = null;
            record.exportError = error;
        }
    }

    function confirmLeavingEditor(event) {
        if (!imageRecords.size) return;
        event.preventDefault();
        // Browsers display their own warning text; returnValue supports older ones.
        event.returnValue = true;
    }

    function updateBatchEmptyState() {
        const isEmpty =
            document.getElementById('batchImages').children.length === 0;
        document.getElementById('batchEmptyState').hidden = !isEmpty;
        document.getElementById('batchImages').hidden = isEmpty;
        document.getElementById('applyRemovalToAll').hidden = imageRecords.size < 2;
        if (isEmpty) window.removeEventListener('beforeunload', confirmLeavingEditor);
        else window.addEventListener('beforeunload', confirmLeavingEditor);
        if (controls) controls.updateDownloadState();
    }

    function updateSelectedThumbnail() {
        for (const thumbnail of document.getElementById('batchImages')
            .children) {
            thumbnail.firstElementChild.setAttribute(
                'aria-pressed',
                String(thumbnail.imageFile === selectedFile),
            );
        }
    }

    document
        .getElementById('batchUploadButton')
        .addEventListener('click', () => {
            fileInput.click();
        });
    updateBatchEmptyState();

    // Share cleanup between explicit deletion and failed uploads.
    function removeImage(file) {
        const batchContainer = document.getElementById('batchImages');
        const thumbnail = Array.from(batchContainer.children).find(
            (item) => item.imageFile === file,
        );
        if (!thumbnail) return;
        const thumbnailImage = thumbnail.firstElementChild.firstElementChild;
        const record = imageRecords.get(file);
        thumbnail.remove();
        imageRecords.delete(file);
        URL.revokeObjectURL(thumbnailImage.src);
        for (const view of [record?.original, record?.cutout])
            if (view) URL.revokeObjectURL(view.url);
        updateBatchEmptyState();
        if (
            selectedFile === file ||
            batchContainer.children.length === 0
        ) {
            invalidateImageProcessing();
            hideLoading();
            document.getElementById('uploadPlaceholder').style.display =
                'flex';
            selectedFile = null;
            selectedFileName = '';
            if (!batchContainer.children.length) {
                sourceDimensions = null;
                controls.resetImageTransform();
                widthInput.value = '';
                heightInput.value = '';
                document.getElementById('aspectRatioPreset').value = 'original';
                controls.syncPresetMenu();
            }
            if (batchContainer.firstElementChild) {
                batchContainer.firstElementChild.click();
            }
        }
        updateSelectedThumbnail();
        const nextThumbnail = batchContainer.firstElementChild;
        if (nextThumbnail) nextThumbnail.firstElementChild.focus();
        else document.getElementById('batchUploadButton').focus();
        fileInput.value = '';
    }

    function addToBatchImages(file) {
        const batchContainer = document.getElementById('batchImages');
        const thumbnail = document.createElement('div');
        thumbnail.className = 'batch-thumbnail';
        thumbnail.imageFile = file;

        const thumbnailImage = document.createElement('img');
        thumbnailImage.src = URL.createObjectURL(file);
        thumbnailImage.alt = '';
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'thumbnail-select';
        selectButton.setAttribute('aria-label', 'Edit ' + file.name);
        selectButton.appendChild(thumbnailImage);

        const removeButton = document.createElement('button');
        removeButton.className = 'remove-btn';
        removeButton.type = 'button';
        removeButton.setAttribute('aria-label', 'Remove ' + file.name);
        removeButton.innerHTML = '×';
        removeButton.onclick = (e) => {
            e.stopPropagation();
            removeImage(file);
        };

        const filenameLabel = document.createElement('span');
        filenameLabel.textContent = file.name;

        selectButton.appendChild(filenameLabel);
        thumbnail.appendChild(selectButton);
        thumbnail.appendChild(removeButton);
        batchContainer.appendChild(thumbnail);
        updateBatchEmptyState();
        updateSelectedThumbnail();

        thumbnail.addEventListener('click', () => selectFile(file));
    }

    // Update file input handler
    fileInput.addEventListener('change', function (event) {
        const files = event.target.files;
        if (files && files.length) {
            handleFiles(Array.from(files));
        }
    });

    function createExportCanvas(sourceCropper, settings) {
        const width = Number(settings.width);
        const height = Number(settings.height);
        if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0
        ) {
            throw new Error(
                'Enter a valid width and height before downloading.',
            );
        }
        const cropData = sourceCropper.getData();
        const scale = Math.max(
            width / cropData.width,
            height / cropData.height,
        );
        const scaledWidth = Math.max(1, Math.round(cropData.width * scale));
        const scaledHeight = Math.max(1, Math.round(cropData.height * scale));
        const croppedCanvas = sourceCropper.getCroppedCanvas({
            width: scaledWidth,
            height: scaledHeight,
            fillColor: fillColor(settings.background),
        });
        if (!croppedCanvas) throw new Error('Could not render the image.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create the download canvas.');
        if (settings.background === 'photo' && settings.photo) {
            ImageBrush.drawCover(context, settings.photo.image, 0, 0, width, height);
        } else if (settings.background !== 'transparent') {
            context.fillStyle = settings.background;
            context.fillRect(0, 0, width, height);
        }
        context.drawImage(
            croppedCanvas,
            (width - scaledWidth) / 2,
            (height - scaledHeight) / 2,
            scaledWidth,
            scaledHeight,
        );
        return canvas;
    }

    const EXPORT_EXTENSIONS = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
    };
    const PNG_EXPORT = { type: 'image/png' };

    function canvasToBlob(canvas, format = PNG_EXPORT) {
        let source = canvas;
        if (format.type === 'image/jpeg') {
            // JPEG has no alpha channel; without a backdrop, browsers turn
            // transparent pixels black.
            source = document.createElement('canvas');
            source.width = canvas.width;
            source.height = canvas.height;
            const context = source.getContext('2d');
            if (!context) throw new Error('Could not create the download canvas.');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, source.width, source.height);
            context.drawImage(canvas, 0, 0);
        }
        return new Promise((resolve, reject) => {
            source.toBlob(
                (blob) =>
                    blob
                        ? resolve(blob)
                        : reject(new Error('Could not encode the image.')),
                format.type,
                format.quality,
            );
        });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Give the browser time to begin reading the object URL before releasing it.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function uniqueFilename(name, usedNames) {
        const safeName =
            name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '') ||
            'image';
        const extensionIndex = safeName.lastIndexOf('.');
        const stem =
            extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
        const extension =
            extensionIndex > 0 ? safeName.slice(extensionIndex) : '';
        let filename = safeName;
        let suffix = 2;
        while (usedNames.has(filename.toLowerCase()))
            filename = `${stem} (${suffix++})${extension}`;
        usedNames.add(filename.toLowerCase());
        return filename;
    }

    function exportSnapshot(record, usedNames, extension) {
        if (record.status === 'unvisited') {
            return {
                filename: uniqueFilename(record.file.name, usedNames),
                blob: record.file,
            };
        }
        if (
            record.status !== 'ready' ||
            !record.savedCanvas ||
            record.exportError
        ) {
            throw new Error(
                `Cannot export ${record.file.name}. Select it and finish processing with valid dimensions, then retry.`,
            );
        }
        const name = `edited_${record.file.name.replace(/\.[^/.]+$/, '')}.${extension}`;
        return {
            filename: uniqueFilename(name, usedNames),
            canvas: record.savedCanvas,
        };
    }

    async function downloadImages(allImages = false, format = PNG_EXPORT) {
        if (exportBusy || !cropper || !cropper.ready || imageAbortController)
            return;
        if (brushSession) {
            await closeBrush();
            if (!cropper || !cropper.ready || imageAbortController) return;
        }
        if (!EXPORT_EXTENSIONS[format.type]) format = PNG_EXPORT;
        exportBusy = true;
        controls.updateDownloadState();
        try {
            saveCurrentImage();
            // Freeze the export before yielding, so edits/uploads/removals during encoding
            // cannot change which images or settings are included in this download.
            const usedNames = new Set();
            const records = allImages
                ? [...imageRecords.values()]
                : [imageRecords.get(selectedFile)];
            const snapshots = records.map((record) =>
                exportSnapshot(record, usedNames, EXPORT_EXTENSIONS[format.type]),
            );
            if (allImages) {
                const zip = new window.JSZip();
                for (let index = 0; index < snapshots.length; index++) {
                    controls.setDownloadStatus(
                        `Preparing ${index + 1} of ${snapshots.length}…`,
                    );
                    const entry = snapshots[index];
                    const blob =
                        entry.blob || (await canvasToBlob(entry.canvas, format));
                    zip.file(entry.filename, await blob.arrayBuffer());
                }
                const archive = await zip.generateAsync(
                    { type: 'blob', compression: 'STORE' },
                    (progress) => {
                        controls.setDownloadStatus(
                            `Creating ZIP… ${Math.round(progress.percent)}%`,
                        );
                    },
                );
                downloadBlob(archive, 'edited_images.zip');
            } else {
                controls.setDownloadStatus('Preparing image…');
                const entry = snapshots[0];
                downloadBlob(await canvasToBlob(entry.canvas, format), entry.filename);
            }
            controls.setDownloadStatus('Download ready.');
        } catch (error) {
            console.error('Download failed:', error);
            controls.setDownloadStatus(
                error.message || 'Download failed. Please try again.',
            );
        } finally {
            exportBusy = false;
            controls.updateDownloadState();
        }
    }

    return {
        attachControls(handlers) {
            controls = handlers;
        },
        handleFiles,
        setRemoveBackground,
        applyRemovalToAll,
        resetImage,
        openBrush,
        closeBrush,
        setBrushMode: (mode) => brushView.setMode(mode),
        setBrushSize: (size) => brushView.setSize(size),
        resizeBrush,
        resizeCropper,
        get brushHint() {
            return brushHint();
        },
        downloadImages,
        commitEdit,
        undo: () => stepHistory('past', 'future'),
        redo: () => stepHistory('future', 'past'),
        get canUndo() {
            return Boolean(historyReady()?.past.length);
        },
        get canRedo() {
            return Boolean(historyReady()?.future.length);
        },
        get canDownload() {
            return Boolean(
                cropper &&
                    cropper.ready &&
                    !imageAbortController &&
                    !exportBusy,
            );
        },
        get exportBusy() {
            return exportBusy;
        },
        elements: {
            previewImage,
            fileInput,
            removeBgCheckbox,
            widthInput,
            heightInput,
            bgColorInput,
            transparentBgButton,
            loadingOverlay,
            uploadPlaceholder,
        },
        get cropper() {
            return cropper;
        },
        get selectedFile() {
            return selectedFile;
        },
        get selectedFileName() {
            return selectedFileName;
        },
        get sourceDimensions() {
            return sourceDimensions;
        },
        get selectedBackground() {
            return selectedBackground;
        },
        set selectedBackground(value) {
            selectedBackground = value;
        },
        get backgroundPhoto() {
            return backgroundPhoto;
        },
        set backgroundPhoto(value) {
            backgroundPhoto = value;
        },
        loadBackgroundPhoto,
        fillColor,
        get rotationAngle() {
            return rotationAngle;
        },
        set rotationAngle(value) {
            rotationAngle = value;
        },
        get horizontalScale() {
            return horizontalScale;
        },
        set horizontalScale(value) {
            horizontalScale = value;
        },
        get verticalScale() {
            return verticalScale;
        },
        set verticalScale(value) {
            verticalScale = value;
        },
    };
})();
