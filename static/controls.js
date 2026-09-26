// User-interface controls. Loaded after editor.js; no editor state is duplicated here.
(() => {
    'use strict';

    const editor = window.ImageEditor;
    const {
        previewImage,
        fileInput,
        removeBgCheckbox,
        widthInput,
        heightInput,
        bgColorInput,
        transparentBgButton,
        loadingOverlay,
        uploadPlaceholder,
    } = editor.elements;

    const toolPanel = document.getElementById('toolPanel');
    const toolButtons = {
        crop: document.getElementById('cropTool'),
        background: document.getElementById('backgroundTool'),
        rotation: document.getElementById('rotationTool'),
    };
    let activeTool = 'crop';

    const presetSelect = document.getElementById('aspectRatioPreset');
    const presetTrigger = document.getElementById('presetTrigger');
    const presetMenu = document.getElementById('presetMenu');
    const presetDropdown = document.getElementById('presetDropdown');
    const presetChoices = [
        ['free', 'presetFree', 'None'],
        ['original', 'presetOriginal', 'Original'],
        ['1', 'presetSquare', '1:1 (Square)'],
        ['0.8', 'presetPortrait', '4:5 (Portrait)'],
        ['0.5625', 'presetStory', '9:16 (Story)'],
    ];
    let presetOpen = false;
    let focusedPreset = 0;

    function syncPresetMenu() {
        const choice = presetChoices.find(
            ([value]) => value === presetSelect.value,
        );
        document.getElementById('presetValue').textContent = choice
            ? choice[2]
            : 'Custom';
        for (const [value, id] of presetChoices) {
            document
                .getElementById(id)
                .setAttribute(
                    'aria-selected',
                    String(value === presetSelect.value),
                );
        }
    }

    function closePresetMenu(restoreFocus = false) {
        presetOpen = false;
        presetMenu.hidden = true;
        presetTrigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) presetTrigger.focus();
    }

    function focusPreset(index) {
        focusedPreset = (index + presetChoices.length) % presetChoices.length;
        document.getElementById(presetChoices[focusedPreset][1]).focus();
    }

    function openPresetMenu() {
        syncPresetMenu();
        presetOpen = true;
        presetMenu.hidden = false;
        presetTrigger.setAttribute('aria-expanded', 'true');
        focusPreset(
            Math.max(
                0,
                presetChoices.findIndex(
                    ([value]) => value === presetSelect.value,
                ),
            ),
        );
    }

    presetTrigger.addEventListener('click', () =>
        presetOpen ? closePresetMenu() : openPresetMenu(),
    );
    presetTrigger.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openPresetMenu();
        }
    });
    for (const [value, id] of presetChoices) {
        document.getElementById(id).addEventListener('click', () => {
            presetSelect.value = value;
            presetSelect.dispatchEvent(new Event('change'));
            syncPresetMenu();
            closePresetMenu(true);
        });
    }
    presetMenu.addEventListener('keydown', (event) => {
        if (
            ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(
                event.key,
            )
        ) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') closePresetMenu(true);
            else if (event.key === 'Home') focusPreset(0);
            else if (event.key === 'End') focusPreset(presetChoices.length - 1);
            else
                focusPreset(
                    focusedPreset + (event.key === 'ArrowDown' ? 1 : -1),
                );
        }
    });
    presetDropdown.addEventListener('focusout', (event) => {
        // Safari taps can blur a button without focusing another element. Keep
        // the menu available for the ensuing click; outside clicks close it below.
        if (event.relatedTarget && !presetDropdown.contains(event.relatedTarget))
            closePresetMenu();
    });
    document.addEventListener('click', (event) => {
        if (!presetDropdown.contains(event.target)) closePresetMenu();
    });

    function setActiveTool(tool) {
        closePresetMenu();
        activeTool = tool;
        toolPanel.hidden = !tool;
        for (const name of Object.keys(toolButtons)) {
            toolButtons[name].setAttribute(
                'aria-expanded',
                String(name === tool),
            );
            document.getElementById(name + 'Panel').hidden = name !== tool;
        }
        if (tool)
            document.getElementById('toolPanelTitle').textContent = {
                crop: 'Crop',
                background: 'Background',
                rotation: 'Rotate & flip',
            }[tool];
    }

    for (const [name, button] of Object.entries(toolButtons)) {
        button.addEventListener('click', () =>
            setActiveTool(activeTool === name ? null : name),
        );
    }
    function closeToolPanel() {
        const previousTool = activeTool;
        setActiveTool(null);
        if (previousTool) toolButtons[previousTool].focus();
    }
    document
        .getElementById('closeToolPanel')
        .addEventListener('click', closeToolPanel);
    toolPanel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeToolPanel();
        }
    });
    // Let Cropper preserve its crop data when the available canvas space changes.
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
            if (editor.cropper && editor.cropper.ready) editor.cropper.resize();
        }).observe(document.getElementById('dropZone'));
    }

    function syncRotationControls() {
        document.getElementById('rotationAngle').value = String(
            editor.rotationAngle,
        );
        document.getElementById('rotationSlider').value = String(
            editor.rotationAngle,
        );
        document
            .getElementById('rotationSlider')
            .setAttribute('aria-valuetext', editor.rotationAngle + ' degrees');
        document
            .getElementById('flipHorizontal')
            .setAttribute(
                'aria-pressed',
                String(editor.horizontalScale === -1),
            );
        document
            .getElementById('flipVertical')
            .setAttribute('aria-pressed', String(editor.verticalScale === -1));
    }

    function applyImageTransform() {
        editor.cropper.rotateTo(editor.rotationAngle);
        editor.cropper.scale(editor.horizontalScale, editor.verticalScale);
    }

    function resetImageTransform() {
        editor.rotationAngle = 0;
        editor.horizontalScale = 1;
        editor.verticalScale = 1;
        syncRotationControls();
    }

    function setRotation(value) {
        if (!editor.cropper || !editor.cropper.ready || !Number.isFinite(value))
            return;
        editor.rotationAngle =
            Math.round((((((value + 180) % 360) + 360) % 360) - 180) * 10) / 10;
        // Keep the positive endpoint at the right end of the slider.
        if (editor.rotationAngle === -180 && value > 0)
            editor.rotationAngle = 180;
        editor.cropper.rotateTo(editor.rotationAngle);
        syncRotationControls();
    }
    document
        .getElementById('rotateLeft')
        .addEventListener('click', () =>
            setRotation(editor.rotationAngle - 90),
        );
    document
        .getElementById('rotateRight')
        .addEventListener('click', () =>
            setRotation(editor.rotationAngle + 90),
        );
    for (const id of ['rotationAngle', 'rotationSlider']) {
        document.getElementById(id).addEventListener('input', (event) => {
            const value = Number(event.target.value);
            if (event.target.value.trim() && value >= -180 && value <= 180)
                setRotation(value);
        });
    }
    document.getElementById('flipHorizontal').addEventListener('click', () => {
        if (!editor.cropper || !editor.cropper.ready) return;
        editor.horizontalScale *= -1;
        editor.cropper.scaleX(editor.horizontalScale);
        syncRotationControls();
    });
    document.getElementById('flipVertical').addEventListener('click', () => {
        if (!editor.cropper || !editor.cropper.ready) return;
        editor.verticalScale *= -1;
        editor.cropper.scaleY(editor.verticalScale);
        syncRotationControls();
    });

    function updateBackgroundColor(color) {
        if (editor.cropper) {
            editor.cropper.options.fillColor = color;
            const viewBox = document.querySelector('.cropper-view-box');
            const preview = document.querySelector('#preview');
            const bgPattern =
                'repeating-conic-gradient(#FFFFFF 0% 25%, #E8E8E8 0% 50%) 50% / 20px 20px';

            if (viewBox) {
                if (color === 'transparent') {
                    viewBox.style.background = bgPattern;
                } else {
                    viewBox.style.background = color;
                }
            }

            if (preview) {
                preview.style.background =
                    color === 'transparent' ? bgPattern : color;
            }
        }
    }

    function setToolControlsDisabled(disabled) {
        for (const id of [
            'cropControls',
            'backgroundControls',
            'rotationControls',
        ]) {
            document.getElementById(id).disabled = disabled;
        }
        if (disabled) closePresetMenu();
    }

    // Handle background removal toggle
    removeBgCheckbox.addEventListener('change', function () {
        if (editor.selectedFile) {
            editor.processSelectedImage(editor.selectedFile, this.checked, false);
        }
    });

    // Ignore incomplete values while typing, and update without rebuilding the editor.
    function applyResolution() {
        const width = Number(widthInput.value);
        const height = Number(heightInput.value);
        if (
            !editor.cropper ||
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0
        )
            return;

        const ratio = width / height;
        editor.cropper.setAspectRatio(ratio);
        document.getElementById('aspectRatioPreset').value = [
            1, 0.8, 0.5625,
        ].includes(ratio)
            ? String(ratio)
            : 'custom';
        syncPresetMenu();
    }

    widthInput.addEventListener('input', applyResolution);
    heightInput.addEventListener('input', applyResolution);

    // Reset functionality - resets image to original state
    document
        .getElementById('resetButton')
        .addEventListener('click', function () {
            if (editor.selectedFile && editor.cropper) {
                editor.processSelectedImage(
                    editor.selectedFile,
                    removeBgCheckbox.checked,
                );
            }
        });

    document
        .getElementById('aspectRatioPreset')
        .addEventListener('change', function () {
            syncPresetMenu();
            if (!editor.cropper) return;
            const ratio =
                this.value === 'original'
                    ? editor.sourceDimensions.width /
                      editor.sourceDimensions.height
                    : this.value === 'free'
                      ? NaN
                      : Number(this.value);
            editor.cropper.setAspectRatio(ratio);
            if (this.value === 'original') {
                widthInput.value = String(editor.sourceDimensions.width);
                heightInput.value = String(editor.sourceDimensions.height);
            } else if (Number.isFinite(ratio) && ratio > 0) {
                // Use the updated crop's pixel width, not stale output dimensions.
                const width = Math.max(
                    1,
                    Math.round(editor.cropper.getData().width),
                );
                widthInput.value = String(width);
                heightInput.value = String(
                    Math.max(1, Math.round(width / ratio)),
                );
            }
        });

    function selectBackground(color, activeButton) {
        editor.selectedBackground = color;
        for (const id of ['transparentBg', 'whiteBg', 'blackBg', 'customBg']) {
            document
                .getElementById(id)
                .setAttribute('aria-pressed', String(id === activeButton));
        }
        updateBackgroundColor(color);
    }

    transparentBgButton.addEventListener('click', () =>
        selectBackground('transparent', 'transparentBg'),
    );
    document
        .getElementById('whiteBg')
        .addEventListener('click', () =>
            selectBackground('#ffffff', 'whiteBg'),
        );
    document
        .getElementById('blackBg')
        .addEventListener('click', () =>
            selectBackground('#000000', 'blackBg'),
        );
    document
        .getElementById('customBg')
        .addEventListener('click', () => bgColorInput.click());
    function applyCustomBackground() {
        document.getElementById('customBg').style.backgroundColor =
            bgColorInput.value;
        document.getElementById('customBg').style.color =
            parseInt(bgColorInput.value.slice(1, 3), 16) * 0.299 +
                parseInt(bgColorInput.value.slice(3, 5), 16) * 0.587 +
                parseInt(bgColorInput.value.slice(5, 7), 16) * 0.114 >
            150
                ? '#2c3e50'
                : '#ffffff';
        selectBackground(bgColorInput.value, 'customBg');
    }
    bgColorInput.addEventListener('input', applyCustomBackground);
    bgColorInput.addEventListener('change', applyCustomBackground);

    function syncBackgroundControls() {
        const color = editor.selectedBackground;
        const activeId =
            color === 'transparent'
                ? 'transparentBg'
                : color === '#ffffff'
                  ? 'whiteBg'
                  : color === '#000000'
                    ? 'blackBg'
                    : 'customBg';
        for (const id of ['transparentBg', 'whiteBg', 'blackBg', 'customBg']) {
            document
                .getElementById(id)
                .setAttribute('aria-pressed', String(id === activeId));
        }
        document.getElementById('customBg').style.backgroundColor =
            bgColorInput.value;
    }

    const downloadTrigger = document.getElementById('downloadMenuButton');
    const downloadMenu = document.getElementById('downloadMenu');
    const downloadControl = document.getElementById('downloadControl');
    let downloadOpen = false;

    function closeDownloadMenu(restoreFocus = false) {
        downloadOpen = false;
        downloadMenu.hidden = true;
        downloadTrigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) downloadTrigger.focus();
    }

    function updateDownloadState() {
        downloadTrigger.disabled = !editor.canDownload;
        document.getElementById('downloadCurrent').disabled =
            !editor.canDownload;
        document.getElementById('downloadAll').disabled = !editor.canDownload;
        downloadTrigger.setAttribute('aria-busy', String(editor.exportBusy));
        if (!editor.canDownload) closeDownloadMenu();
    }

    function setDownloadStatus(message) {
        const status = document.getElementById('downloadStatus');
        status.textContent = message;
        status.hidden = !message;
    }

    downloadTrigger.addEventListener('click', () => {
        if (!editor.canDownload) return;
        downloadOpen = !downloadOpen;
        downloadMenu.hidden = !downloadOpen;
        downloadTrigger.setAttribute('aria-expanded', String(downloadOpen));
        if (downloadOpen) document.getElementById('downloadCurrent').focus();
    });
    document.getElementById('downloadCurrent').addEventListener('click', () => {
        closeDownloadMenu(true);
        editor.downloadImages(false);
    });
    document.getElementById('downloadAll').addEventListener('click', () => {
        closeDownloadMenu(true);
        editor.downloadImages(true);
    });
    downloadMenu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDownloadMenu(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const target =
                event.target === document.getElementById('downloadCurrent')
                    ? 'downloadAll'
                    : 'downloadCurrent';
            document.getElementById(target).focus();
        }
    });
    downloadControl.addEventListener('focusout', (event) => {
        if (event.relatedTarget && !downloadControl.contains(event.relatedTarget))
            closeDownloadMenu();
    });
    document.addEventListener('click', (event) => {
        if (!downloadControl.contains(event.target)) closeDownloadMenu();
    });

    editor.attachControls({
        applyImageTransform,
        resetImageTransform,
        setToolControlsDisabled,
        updateBackgroundColor,
        syncPresetMenu,
        syncRotationControls,
        syncBackgroundControls,
        updateDownloadState,
        setDownloadStatus,
    });
    updateDownloadState();
})();
