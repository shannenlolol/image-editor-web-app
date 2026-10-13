// Image lifecycle, cropper, uploads, and downloads. Controls register their UI hooks below.
window.ImageEditor = (() => {
    'use strict';

    let controls;
    const imageRecords = new Map();
    let exportBusy = false;
    let cropper = null;
    let selectedFile = null;
    let imageRequestId = 0;
    let imageAbortController = null;
    let displayedImageUrl = null;
    let selectedFileName = '';
    let sourceDimensions = null;
    let selectedBackground = 'transparent';
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
            responsive: true,
            restore: true,
            center: true,
            highlight: false,
            cropBoxMovable: true,
            cropBoxResizable: true,
            guides: true,
            dragMode: 'crop',
            toggleDragModeOnDblclick: true,
            fillColor: selectedBackground,
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
                record.history = record.history || { past: [], future: [] };
                record.history.current = takeSnapshot();
                controls.updateDownloadState();
            },
        };

        cropper = new Cropper(previewImage, options);
    }

    // Register zoom handlers once, independent of cropper recreation.
    document.getElementById('zoomIn').addEventListener('click', () => {
        if (cropper && cropper.ready) cropper.zoom(0.1);
    });
    document.getElementById('zoomOut').addEventListener('click', () => {
        if (cropper && cropper.ready) cropper.zoom(-0.1);
    });

    function invalidateImageProcessing() {
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
        previewImage.removeAttribute('src');
        previewImage.style.display = 'none';
        if (displayedImageUrl) {
            URL.revokeObjectURL(displayedImageUrl);
            displayedImageUrl = null;
        }
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

    async function processSelectedImage(
        file,
        shouldRemoveBg = true,
        resetEdits = true,
    ) {
        if (!resetEdits) saveCurrentImage();
        invalidateImageProcessing();
        const record = imageRecords.get(file);
        record.status = 'loading';
        record.removeBackground = shouldRemoveBg;
        record.savedCanvas = null;
        record.exportError = null;
        if (resetEdits) record.cropData = null;
        const requestId = imageRequestId;
        const controller = new AbortController();
        imageAbortController = controller;
        let url = null;
        let failureMessage = 'Could not open this image. Try another image file.';
        showLoading();

        try {
            let blob = file;
            if (shouldRemoveBg) {
                const { upload, decodable } = await prepareUpload(file);
                if (requestId !== imageRequestId) return;
                const formData = new FormData();
                formData.append('file', upload, file.name);
                failureMessage = 'Could not reach background removal. Check your connection and upload the image again to retry.';
                const response = await fetch(decodable ? '/remove-bg/mask' : '/remove-bg', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
                if (requestId !== imageRequestId) return;
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
                failureMessage = 'Could not read the processed image. Upload the image again to retry.';
                blob = await response.blob();
                if (decodable) {
                    if (requestId !== imageRequestId) return;
                    failureMessage = 'Could not apply the background removal. Upload the image again to retry.';
                    blob = await applyMask(file, blob);
                }
            }
            if (requestId !== imageRequestId) return;

            // Decode separately so an old image-load event cannot update the editor.
            failureMessage = shouldRemoveBg
                ? 'The processed image could not be opened. Upload the image again to retry.'
                : 'This image could not be opened. Try another image file.';
            url = URL.createObjectURL(blob);
            const preview = new Image();
            preview.src = url;
            await preview.decode();
            if (requestId !== imageRequestId) return;
            failureMessage = 'Could not prepare the editor. Upload the image again to retry.';

            // Background removal returns large photos downscaled, so toggling it
            // swaps between two sizes of the same picture. The kept crop is in the
            // previous image's pixels; rescale it so it covers the same area.
            const size = { width: preview.naturalWidth, height: preview.naturalHeight };
            const previous = record.imageSize;
            if (
                !resetEdits &&
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

            if (resetEdits) {
                controls.resetImageTransform();
                sourceDimensions = {
                    width: preview.naturalWidth,
                    height: preview.naturalHeight,
                };
                widthInput.value = String(sourceDimensions.width);
                heightInput.value = String(sourceDimensions.height);
                document.getElementById('aspectRatioPreset').value = 'original';
                controls.syncPresetMenu();
            }
            previewImage.src = url;
            displayedImageUrl = url;
            initCropper(record);
            if (cropper.ready) record.status = 'ready';
            controls.updateDownloadState();
        } catch (error) {
            if (requestId !== imageRequestId || error.name === 'AbortError')
                return;
            record.status = 'error';
            console.error('Error:', error);
            if (url && url !== displayedImageUrl) URL.revokeObjectURL(url);
            url = null;
            removeImage(file);
            alert(error.userMessage || failureMessage);
        } finally {
            if (url && url !== displayedImageUrl) URL.revokeObjectURL(url);
            if (requestId === imageRequestId) {
                imageAbortController = null;
                hideLoading();
                controls.updateDownloadState();
            }
        }
    }

    // Handle drag and drop functionality
    const dropZone = document.getElementById('dropZone');

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
        const defaults = {
            removeBackground: removeBgCheckbox.checked,
            background: selectedBackground,
        };
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
        if (file === selectedFile && cropper && cropper.ready) return;
        saveCurrentImage();
        invalidateImageProcessing();
        selectedFile = file;
        selectedFileName = file.name;
        const record = imageRecords.get(file);
        if (record.settings) restoreImageSettings(record.settings);
        else {
            removeBgCheckbox.checked = defaults
                ? defaults.removeBackground
                : Boolean(record.removeBackground);
            selectedBackground = defaults ? defaults.background : 'transparent';
            controls.syncBackgroundControls();
        }
        updateSelectedThumbnail();
        uploadPlaceholder.style.display = 'none';
        processSelectedImage(file, removeBgCheckbox.checked, !record.settings);
    }

    function captureImageSettings() {
        return {
            width: widthInput.value,
            height: heightInput.value,
            preset: document.getElementById('aspectRatioPreset').value,
            sourceDimensions,
            removeBackground: removeBgCheckbox.checked,
            background: selectedBackground,
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
        removeBgCheckbox.checked = settings.removeBackground;
        selectedBackground = settings.background;
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
        return { settings: captureImageSettings(), cropData: { ...cropper.getData() } };
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

    function applySnapshot({ settings, cropData }) {
        restoreImageSettings(settings);
        cropper.setAspectRatio(currentAspectRatio());
        controls.applyImageTransform();
        cropper.setData(cropData);
        controls.updateBackgroundColor(selectedBackground);
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

    // Background removal and Reset replace the image itself, so earlier
    // snapshots no longer apply to it.
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
        thumbnail.remove();
        imageRecords.delete(file);
        URL.revokeObjectURL(thumbnailImage.src);
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
            fillColor: settings.background,
        });
        if (!croppedCanvas) throw new Error('Could not render the image.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create the download canvas.');
        if (settings.background !== 'transparent') {
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
        processSelectedImage,
        downloadImages,
        commitEdit,
        clearHistory,
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
