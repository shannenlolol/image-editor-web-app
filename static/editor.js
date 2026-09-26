// Image lifecycle, cropper, uploads, and downloads. Controls register their UI hooks below.
window.ImageEditor = (() => {
    'use strict';

    let controls;
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

    function initCropper() {
        const requestId = imageRequestId;
        if (cropper) {
            cropper.destroy();
        }

        previewImage.style.display = 'block';
        uploadPlaceholder.style.display = 'none';
        const preset = document.getElementById('aspectRatioPreset');
        const ratio =
            preset.value === 'free'
                ? NaN
                : preset.value === 'original'
                  ? sourceDimensions.width / sourceDimensions.height
                  : preset.value === 'custom'
                    ? Number(widthInput.value) / Number(heightInput.value)
                    : Number(preset.value);

        const options = {
            aspectRatio: ratio,
            viewMode: 0, // Changed back to viewMode 0 for completely free movement
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
            ready: function () {
                if (requestId !== imageRequestId || !cropper) return;
                controls.applyImageTransform();
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

                    // Center the view
                    setTimeout(() => {
                        if (requestId !== imageRequestId) return;
                        container.scrollLeft =
                            (container.scrollWidth - container.clientWidth) / 2;
                        container.scrollTop =
                            (container.scrollHeight - container.clientHeight) /
                            2;
                    }, 100);
                }
            },
        };

        cropper = new Cropper(previewImage, options);

        // Remove existing event listeners before adding new ones
        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');

        zoomIn.removeEventListener('click', null);
        zoomOut.removeEventListener('click', null);

        zoomIn.addEventListener('click', () => {
            if (cropper) cropper.zoom(0.1);
        });

        zoomOut.addEventListener('click', () => {
            if (cropper) cropper.zoom(-0.1);
        });
    }

    function invalidateImageProcessing() {
        controls.setToolControlsDisabled(true);
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
        previewImage.removeAttribute('src');
        previewImage.style.display = 'none';
        if (displayedImageUrl) {
            URL.revokeObjectURL(displayedImageUrl);
            displayedImageUrl = null;
        }
    }

    async function processSelectedImage(
        file,
        shouldRemoveBg = true,
        resetEdits = true,
    ) {
        invalidateImageProcessing();
        const requestId = imageRequestId;
        const controller = new AbortController();
        imageAbortController = controller;
        let url = null;
        showLoading();

        try {
            let blob = file;
            if (shouldRemoveBg) {
                const formData = new FormData();
                formData.append('file', file);
                const response = await fetch('/remove-bg', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
                if (requestId !== imageRequestId) return;
                blob = await response.blob();
            }
            if (requestId !== imageRequestId) return;

            // Decode separately so an old image-load event cannot update the editor.
            url = URL.createObjectURL(blob);
            const preview = new Image();
            preview.src = url;
            await preview.decode();
            if (requestId !== imageRequestId) return;

            if (resetEdits) {
                controls.resetImageTransform();
                sourceDimensions = {
                    width: preview.naturalWidth,
                    height: preview.naturalHeight,
                };
                widthInput.value = String(sourceDimensions.width);
                heightInput.value = String(sourceDimensions.height);
                document.getElementById('aspectRatioPreset').value = 'free';
                controls.syncPresetMenu();
            }
            previewImage.src = url;
            displayedImageUrl = url;
            initCropper();
        } catch (error) {
            if (requestId !== imageRequestId || error.name === 'AbortError')
                return;
            console.error('Error:', error);
            alert('Error processing image. Please try again.');
        } finally {
            if (url && url !== displayedImageUrl) URL.revokeObjectURL(url);
            if (requestId === imageRequestId) {
                imageAbortController = null;
                hideLoading();
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

    function handleFiles(files) {
        files.forEach((file, index) => {
            // Process the first file immediately
            if (index === 0) {
                selectedFile = file; // Store the original file
                selectedFileName = file.name; // Store the current file name
                document.getElementById('uploadPlaceholder').style.display =
                    'none';
                document.getElementById('image').style.display = 'block';
                processSelectedImage(file, removeBgCheckbox.checked);
            }
            // Add all files to batch images
            addToBatchImages(file);
        });
    }

    function updateBatchEmptyState() {
        const isEmpty =
            document.getElementById('batchImages').children.length === 0;
        document.getElementById('batchEmptyState').hidden = !isEmpty;
        document.getElementById('batchImages').hidden = isEmpty;
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
            thumbnail.remove();
            URL.revokeObjectURL(thumbnailImage.src);
            updateBatchEmptyState();
            if (selectedFile === file || batchContainer.children.length === 0) {
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
                    document.getElementById('aspectRatioPreset').value = 'free';
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
        };

        const filenameLabel = document.createElement('span');
        filenameLabel.textContent = file.name;

        selectButton.appendChild(filenameLabel);
        thumbnail.appendChild(selectButton);
        thumbnail.appendChild(removeButton);
        batchContainer.appendChild(thumbnail);
        updateBatchEmptyState();
        updateSelectedThumbnail();

        thumbnail.addEventListener('click', () => {
            selectedFile = file; // Store the clicked image as original
            selectedFileName = file.name; // Update current file name
            updateSelectedThumbnail();
            document.getElementById('uploadPlaceholder').style.display = 'none';
            document.getElementById('image').style.display = 'block';
            processSelectedImage(file, removeBgCheckbox.checked);
        });
    }

    // Update file input handler
    fileInput.addEventListener('change', function (event) {
        const files = event.target.files;
        if (files && files.length) {
            handleFiles(Array.from(files));
        }
    });

    document
        .getElementById('downloadMenuButton')
        .addEventListener('click', function () {
            if (cropper) {
                const requestId = imageRequestId;
                const fileName = selectedFileName
                    ? `edited_${selectedFileName.replace(/\.[^/.]+$/, '')}.png`
                    : 'edited.png';
                const width = parseInt(widthInput.value) || null;
                const height = parseInt(heightInput.value) || null;

                let canvas;
                if (width && height) {
                    const cropData = cropper.getData();
                    const scaleX = width / cropData.width;
                    const scaleY = height / cropData.height;
                    const scale = Math.max(scaleX, scaleY);

                    const scaledWidth = Math.round(cropData.width * scale);
                    const scaledHeight = Math.round(cropData.height * scale);

                    const finalWidth = width;
                    const finalHeight = height;

                    // Create temporary canvas for the cropped image
                    const tempCanvas = cropper.getCroppedCanvas({
                        width: scaledWidth,
                        height: scaledHeight,
                        fillColor: cropper.options.fillColor,
                    });

                    // Create final canvas with desired dimensions
                    canvas = document.createElement('canvas');
                    canvas.width = finalWidth;
                    canvas.height = finalHeight;
                    const ctx = canvas.getContext('2d');

                    // Fill background if not transparent
                    if (cropper.options.fillColor !== 'transparent') {
                        ctx.fillStyle = cropper.options.fillColor;
                        ctx.fillRect(0, 0, finalWidth, finalHeight);
                    }

                    // Center the scaled image
                    const x = (finalWidth - scaledWidth) / 2;
                    const y = (finalHeight - scaledHeight) / 2;
                    ctx.drawImage(tempCanvas, x, y, scaledWidth, scaledHeight);
                } else {
                    canvas = cropper.getCroppedCanvas({
                        fillColor: cropper.options.fillColor,
                    });
                }

                // Convert canvas to blob and send to server
                canvas.toBlob(function (blob) {
                    if (requestId !== imageRequestId) return;
                    const formData = new FormData();
                    formData.append('editedImage', blob, fileName);

                    // Show loading overlay while processing
                    showLoading();

                    fetch('/upload-edited', {
                        method: 'POST',
                        body: formData,
                    })
                        .then((response) => response.blob())
                        .then((blob) => {
                            if (requestId === imageRequestId) hideLoading();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = fileName;
                            document.body.appendChild(a);
                            a.click();
                            window.URL.revokeObjectURL(url);
                            document.body.removeChild(a);
                        })
                        .catch((error) => {
                            if (requestId !== imageRequestId) return;
                            hideLoading();
                            console.error('Error:', error);
                            alert(
                                'Error downloading the edited image. Please try again.',
                            );
                        });
                }, 'image/png');
            }
        });
    return {
        attachControls(handlers) {
            controls = handlers;
        },
        handleFiles,
        processSelectedImage,
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
