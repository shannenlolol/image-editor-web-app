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
        brush: document.getElementById('brushTool'),
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
        const previousTool = activeTool;
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
                brush: 'Cutout',
                rotation: 'Rotate & flip',
            }[tool];
        // The brush view replaces the crop view only while its panel is open.
        if (previousTool === 'brush' && tool !== 'brush') editor.closeBrush();
        if (tool === 'brush' && previousTool !== 'brush') {
            syncBrushPanel();
            editor.openBrush();
        }
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
            editor.resizeBrush();
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
    document.getElementById('rotateLeft').addEventListener('click', () => {
        setRotation(editor.rotationAngle - 90);
        editor.commitEdit();
    });
    document.getElementById('rotateRight').addEventListener('click', () => {
        setRotation(editor.rotationAngle + 90);
        editor.commitEdit();
    });
    for (const id of ['rotationAngle', 'rotationSlider']) {
        const input = document.getElementById(id);
        input.addEventListener('input', (event) => {
            const value = Number(event.target.value);
            if (event.target.value.trim() && value >= -180 && value <= 180)
                setRotation(value);
        });
        // Record one undo step when dragging or typing ends, not per input event.
        input.addEventListener('change', editor.commitEdit);
    }
    document.getElementById('flipHorizontal').addEventListener('click', () => {
        if (!editor.cropper || !editor.cropper.ready) return;
        editor.horizontalScale *= -1;
        editor.cropper.scaleX(editor.horizontalScale);
        syncRotationControls();
        editor.commitEdit();
    });
    document.getElementById('flipVertical').addEventListener('click', () => {
        if (!editor.cropper || !editor.cropper.ready) return;
        editor.verticalScale *= -1;
        editor.cropper.scaleY(editor.verticalScale);
        syncRotationControls();
        editor.commitEdit();
    });

    function updateBackgroundColor(color) {
        if (editor.cropper) {
            editor.cropper.options.fillColor = color;
            const viewBox = document.querySelector('.cropper-view-box');
            const preview = document.querySelector('#preview');
            // The theme's checks, so the crop view matches the stage around it.
            const bgPattern =
                'repeating-conic-gradient(var(--checker-light) 0% 25%, var(--checker-dark) 0% 50%) 50% / 20px 20px';

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
            'brushControls',
            'rotationControls',
        ]) {
            document.getElementById(id).disabled = disabled;
        }
        if (disabled) closePresetMenu();
    }

    removeBgCheckbox.addEventListener('change', function () {
        editor.setRemoveBackground(this.checked);
    });
    document
        .getElementById('applyRemovalToAll')
        .addEventListener('click', editor.applyRemovalToAll);

    // Offer the brush once removal is on, or explain why it is unavailable.
    function syncBrushPanel() {
        const hint = editor.brushHint;
        const hintElement = document.getElementById('brushHint');
        hintElement.textContent = hint;
        hintElement.hidden = !hint;
        document.getElementById('brushOptions').hidden = Boolean(hint) || !removeBgCheckbox.checked;
    }

    const brushModes = { brushErase: 'erase', brushRestore: 'restore', brushMove: 'move' };
    for (const [id, mode] of Object.entries(brushModes)) {
        document.getElementById(id).addEventListener('click', () => {
            for (const other of Object.keys(brushModes))
                document.getElementById(other).setAttribute('aria-pressed', String(other === id));
            editor.setBrushMode(mode);
        });
    }
    document.getElementById('brushSize').addEventListener('input', (event) => {
        const size = Number(event.target.value);
        document.getElementById('brushSizeValue').textContent = `${size} px`;
        editor.setBrushSize(size);
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
    widthInput.addEventListener('change', editor.commitEdit);
    heightInput.addEventListener('change', editor.commitEdit);

    document.getElementById('resetButton').addEventListener('click', editor.resetImage);

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
            editor.commitEdit();
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

    transparentBgButton.addEventListener('click', () => {
        selectBackground('transparent', 'transparentBg');
        editor.commitEdit();
    });
    document.getElementById('whiteBg').addEventListener('click', () => {
        selectBackground('#ffffff', 'whiteBg');
        editor.commitEdit();
    });
    document.getElementById('blackBg').addEventListener('click', () => {
        selectBackground('#000000', 'blackBg');
        editor.commitEdit();
    });
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
    // The picker fires input while browsing colours; record one step when it closes.
    bgColorInput.addEventListener('change', () => {
        applyCustomBackground();
        editor.commitEdit();
    });

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
        // Undo availability changes at the same points as download availability.
        document.getElementById('undoButton').disabled = !editor.canUndo;
        document.getElementById('redoButton').disabled = !editor.canRedo;
    }

    function setDownloadStatus(message) {
        const status = document.getElementById('downloadStatus');
        status.textContent = message;
        status.hidden = !message;
    }

    const exportFormat = document.getElementById('exportFormat');
    const exportQuality = document.getElementById('exportQuality');
    let webpChecked = false;

    function syncExportOptions() {
        const lossy =
            exportFormat.value === 'image/jpeg' ||
            exportFormat.value === 'image/webp';
        document.getElementById('exportQualityRow').hidden = !lossy;
        document.getElementById('exportNote').hidden =
            exportFormat.value !== 'image/jpeg';
        document.getElementById('exportQualityValue').textContent =
            `${exportQuality.value}%`;
    }

    // Some browsers (older Safari) cannot encode WebP and silently fall back
    // to PNG, so test once with a 1×1 canvas and disable the option if needed.
    function checkWebpSupport() {
        if (webpChecked) return;
        webpChecked = true;
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        if (canvas.toDataURL('image/webp').startsWith('data:image/webp')) return;
        const option = document.getElementById('exportFormatWebp');
        option.disabled = true;
        option.textContent = 'WebP (not supported in this browser)';
    }

    function selectedExportFormat() {
        if (exportFormat.value === 'image/jpeg' || exportFormat.value === 'image/webp')
            return {
                type: exportFormat.value,
                quality: Number(exportQuality.value) / 100,
            };
        return { type: 'image/png' };
    }

    exportFormat.addEventListener('change', syncExportOptions);
    exportQuality.addEventListener('input', syncExportOptions);

    downloadTrigger.addEventListener('click', () => {
        if (!editor.canDownload) return;
        downloadOpen = !downloadOpen;
        downloadMenu.hidden = !downloadOpen;
        downloadTrigger.setAttribute('aria-expanded', String(downloadOpen));
        if (downloadOpen) {
            checkWebpSupport();
            document.getElementById('downloadCurrent').focus();
        }
    });
    document.getElementById('downloadCurrent').addEventListener('click', () => {
        closeDownloadMenu(true);
        editor.downloadImages(false, selectedExportFormat());
    });
    document.getElementById('downloadAll').addEventListener('click', () => {
        closeDownloadMenu(true);
        editor.downloadImages(true, selectedExportFormat());
    });
    const downloadActions = ['downloadCurrent', 'downloadAll'].map((id) =>
        document.getElementById(id),
    );
    downloadMenu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDownloadMenu(true);
        } else if (
            (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
            // The format select and quality slider need their own arrow keys.
            downloadActions.includes(event.target)
        ) {
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

    document.getElementById('undoButton').addEventListener('click', editor.undo);
    document.getElementById('redoButton').addEventListener('click', editor.redo);
    document.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
        if (key !== 'z' && !redo) return;
        // Number fields keep the browser's own undo for what is being typed.
        if (event.target.matches?.('input[type="number"], input[type="text"], textarea'))
            return;
        event.preventDefault();
        if (redo) editor.redo();
        else editor.undo();
    });

    editor.attachControls({
        applyImageTransform,
        resetImageTransform,
        setToolControlsDisabled,
        updateBackgroundColor,
        syncPresetMenu,
        syncRotationControls,
        syncBackgroundControls,
        syncBrushPanel,
        brushToolActive: () => activeTool === 'brush',
        updateDownloadState,
        setDownloadStatus,
    });
    updateDownloadState();
})();
