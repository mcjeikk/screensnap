/**
 * @file ScreenSnap — Editor v0.5.0
 * @description Full annotation editor with canvas-based drawing tools, PDF export,
 * undo/redo, crop, and history integration. All vanilla JS + Canvas API.
 * Includes proper canvas cleanup, Object URL revocation, and accessible UI.
 * @version 0.5.0
 */

(() => {
  'use strict';

  // ── Constants ───────────────────────────────────
  const LOG_PREFIX = '[ScreenSnap][Editor]';
  const MIN_DRAG_DISTANCE = 3;
  const MIN_BLUR_SIZE = 2;
  const RECT_CORNER_RADIUS = 8;
  const HIGHLIGHT_COLOR = 'rgba(255, 214, 0, 0.35)';
  const TOAST_DURATION_MS = 2500;
  const JPEG_EXPORT_QUALITY = 0.92;
  const THUMBNAIL_QUALITY = 0.6;
  const THUMBNAIL_MAX_WIDTH = 320;
  const THUMBNAIL_MAX_HEIGHT = 200;
  const MAX_HISTORY_DATAURL_SIZE = 500_000;

  const EDITOR_SHORTCUTS = Object.freeze({
    a: 'arrow', r: 'rect', e: 'circle', l: 'line',
    p: 'freehand', t: 'text', b: 'blur', h: 'highlight', c: 'crop',
  });

  const TEXT_FONT_SIZES = Object.freeze({ 2: 16, 4: 24, 6: 36 });

  // ── DOM Refs ──
  const canvas = document.getElementById('editor-canvas');
  const ctx = canvas.getContext('2d');
  const canvasWrapper = document.getElementById('canvas-wrapper');
  const colorPicker = document.getElementById('color-picker');
  const colorPreview = document.getElementById('color-preview');
  const strokeSelect = document.getElementById('stroke-width');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnCropApply = document.getElementById('btn-crop-apply');
  const textOverlay = document.getElementById('text-input-overlay');
  const statusDimensions = document.getElementById('status-dimensions');
  const statusTool = document.getElementById('status-tool');
  const statusSize = document.getElementById('status-size');

  // ── State ──
  /** @type {HTMLImageElement|null} */
  let baseImage = null;

  /** @type {Array<Object>} Stack of committed annotations */
  let annotations = [];

  /** @type {Array<Object>} Stack of undone annotations */
  let redoStack = [];

  /** @type {string|null} Current active tool name */
  let currentTool = null;

  /** @type {boolean} Whether the user is currently drawing */
  let drawing = false;

  /** @type {Object|null} Annotation being drawn but not yet committed */
  let pendingAnnotation = null;

  /** @type {number|null} requestAnimationFrame ID */
  let rafId = null;

  /** @type {string|null} Loaded data URL for history reference */
  let loadedDataUrl = null;

  // ── Helpers ──

  /**
   * Get the currently selected annotation color.
   * @returns {string} Hex color value
   */
  const getColor = () => colorPicker.value;

  /**
   * Get the currently selected stroke width.
   * @returns {number} Stroke width in pixels
   */
  const getStrokeWidth = () => parseInt(strokeSelect.value, 10);

  /**
   * Convert mouse event coordinates to canvas coordinates.
   * @param {MouseEvent} e - The mouse event
   * @returns {{x: number, y: number}} Canvas coordinates
   */
  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // ── Render Pipeline ──

  /**
   * Render the full canvas: base image + all annotations + pending annotation.
   */
  function render() {
    if (!baseImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);

    for (const ann of annotations) {
      drawAnnotation(ann);
    }

    if (pendingAnnotation) {
      drawAnnotation(pendingAnnotation);
    }
  }

  /**
   * Schedule a render on the next animation frame (prevents double-calls).
   */
  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  // ── Drawing Individual Annotation Types ──

  /**
   * Draw a single annotation on the canvas.
   * @param {Object} ann - Annotation object with type and geometry
   */
  function drawAnnotation(ann) {
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = ann.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (ann.type) {
      case 'arrow':     drawArrow(ann); break;
      case 'rect':      drawRect(ann); break;
      case 'circle':    drawEllipse(ann); break;
      case 'line':      drawLine(ann); break;
      case 'freehand':  drawFreehand(ann); break;
      case 'text':      drawText(ann); break;
      case 'blur':      drawBlur(ann); break;
      case 'highlight': drawHighlight(ann); break;
      case 'crop':      drawCropPreview(ann); break;
    }

    ctx.restore();
  }

  /** @param {Object} a - Arrow annotation */
  function drawArrow(a) {
    const headLen = Math.max(12, a.strokeWidth * 4);
    const angle = Math.atan2(a.endY - a.startY, a.endX - a.startX);
    ctx.beginPath();
    ctx.moveTo(a.startX, a.startY);
    ctx.lineTo(a.endX, a.endY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a.endX, a.endY);
    ctx.lineTo(a.endX - headLen * Math.cos(angle - Math.PI / 6), a.endY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(a.endX - headLen * Math.cos(angle + Math.PI / 6), a.endY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  /** @param {Object} a - Rectangle annotation */
  function drawRect(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);
    const r = Math.min(RECT_CORNER_RADIUS, Math.min(w, h) / 4);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.stroke();
  }

  /** @param {Object} a - Ellipse annotation */
  function drawEllipse(a) {
    const cx = (a.startX + a.endX) / 2;
    const cy = (a.startY + a.endY) / 2;
    const rx = Math.abs(a.endX - a.startX) / 2;
    const ry = Math.abs(a.endY - a.startY) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** @param {Object} a - Line annotation */
  function drawLine(a) {
    ctx.beginPath();
    ctx.moveTo(a.startX, a.startY);
    ctx.lineTo(a.endX, a.endY);
    ctx.stroke();
  }

  /** @param {Object} a - Freehand annotation */
  function drawFreehand(a) {
    if (!a.points || a.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(a.points[0].x, a.points[0].y);
    for (let i = 1; i < a.points.length; i++) {
      ctx.lineTo(a.points[i].x, a.points[i].y);
    }
    ctx.stroke();
  }

  /** @param {Object} a - Text annotation */
  function drawText(a) {
    ctx.font = `${a.fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = a.color;
    ctx.textBaseline = 'top';
    const lines = (a.text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], a.startX, a.startY + i * (a.fontSize * 1.2));
    }
  }

  /** @param {Object} a - Blur/pixelate annotation */
  function drawBlur(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);
    if (w < MIN_BLUR_SIZE || h < MIN_BLUR_SIZE) return;

    const pixelSize = Math.max(6, Math.round(Math.min(w, h) / 12));
    const imgData = ctx.getImageData(x, y, w, h);

    for (let py = 0; py < h; py += pixelSize) {
      for (let px = 0; px < w; px += pixelSize) {
        let r = 0, g = 0, b = 0, count = 0;
        for (let dy = 0; dy < pixelSize && py + dy < h; dy++) {
          for (let dx = 0; dx < pixelSize && px + dx < w; dx++) {
            const idx = ((py + dy) * w + (px + dx)) * 4;
            r += imgData.data[idx];
            g += imgData.data[idx + 1];
            b += imgData.data[idx + 2];
            count++;
          }
        }
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x + px, y + py, Math.min(pixelSize, w - px), Math.min(pixelSize, h - py));
      }
    }
  }

  /** @param {Object} a - Highlight annotation */
  function drawHighlight(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    ctx.fillStyle = HIGHLIGHT_COLOR;
    ctx.fillRect(x, y, Math.abs(a.endX - a.startX), Math.abs(a.endY - a.startY));
  }

  /** @param {Object} a - Crop preview annotation */
  function drawCropPreview(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);

    // Dim areas outside crop
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, canvas.width - x - w, h);

    // Dashed border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // ── History Management ──

  /**
   * Commit an annotation to the history stack.
   * @param {Object} ann - The annotation to commit
   */
  function commitAnnotation(ann) {
    annotations.push(ann);
    redoStack = [];
    updateUndoRedoButtons();
  }

  /** Undo the last annotation. */
  function undo() {
    if (annotations.length === 0) return;
    redoStack.push(annotations.pop());
    updateUndoRedoButtons();
    requestRender();
  }

  /** Redo the last undone annotation. */
  function redo() {
    if (redoStack.length === 0) return;
    annotations.push(redoStack.pop());
    updateUndoRedoButtons();
    requestRender();
  }

  /** Update undo/redo button disabled states. */
  function updateUndoRedoButtons() {
    btnUndo.disabled = annotations.length === 0;
    btnRedo.disabled = redoStack.length === 0;
    btnUndo.setAttribute('aria-disabled', String(annotations.length === 0));
    btnRedo.setAttribute('aria-disabled', String(redoStack.length === 0));
  }

  // ── Tool Selection ──

  /**
   * Set the active annotation tool.
   * @param {string|null} name - Tool name or null to deselect
   */
  function setTool(name) {
    cancelPending();
    currentTool = name;

    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      const isActive = btn.dataset.tool === name;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });

    canvas.className = '';
    if (name === 'text') canvas.classList.add('cursor-text');
    else if (name === 'crop') canvas.classList.add('cursor-crop');
    else if (name) canvas.classList.add('cursor-crosshair');

    statusTool.textContent = name
      ? `Tool: ${name.charAt(0).toUpperCase() + name.slice(1)}`
      : 'Tool: None';
  }

  /** Cancel any pending annotation in progress. */
  function cancelPending() {
    drawing = false;
    pendingAnnotation = null;
    btnCropApply.style.display = 'none';
    textOverlay.style.display = 'none';
    requestRender();
  }

  // ── Mouse Event Handlers ──

  /**
   * Handle mousedown on the canvas.
   * @param {MouseEvent} e
   */
  function onMouseDown(e) {
    if (!currentTool || e.button !== 0) return;
    const { x, y } = canvasCoords(e);

    if (currentTool === 'text') {
      showTextInput(e, x, y);
      return;
    }

    drawing = true;

    if (currentTool === 'freehand') {
      pendingAnnotation = {
        type: 'freehand',
        points: [{ x, y }],
        color: getColor(),
        strokeWidth: getStrokeWidth(),
      };
    } else {
      pendingAnnotation = {
        type: currentTool,
        startX: x, startY: y,
        endX: x, endY: y,
        color: getColor(),
        strokeWidth: getStrokeWidth(),
      };
    }
  }

  /**
   * Handle mousemove on the canvas.
   * @param {MouseEvent} e
   */
  function onMouseMove(e) {
    if (!drawing || !pendingAnnotation) return;
    const { x, y } = canvasCoords(e);

    if (pendingAnnotation.type === 'freehand') {
      pendingAnnotation.points.push({ x, y });
    } else {
      pendingAnnotation.endX = x;
      pendingAnnotation.endY = y;
    }

    requestRender();
  }

  /**
   * Handle mouseup on the canvas.
   * @param {MouseEvent} e
   */
  function onMouseUp(e) {
    if (!drawing || !pendingAnnotation) return;
    drawing = false;

    const { x, y } = canvasCoords(e);

    if (pendingAnnotation.type === 'freehand') {
      pendingAnnotation.points.push({ x, y });
    } else {
      pendingAnnotation.endX = x;
      pendingAnnotation.endY = y;
    }

    // Special handling for crop
    if (pendingAnnotation.type === 'crop') {
      const w = Math.abs(pendingAnnotation.endX - pendingAnnotation.startX);
      const h = Math.abs(pendingAnnotation.endY - pendingAnnotation.startY);
      if (w > MIN_DRAG_DISTANCE && h > MIN_DRAG_DISTANCE) {
        btnCropApply.style.display = 'block';
        requestRender();
      } else {
        pendingAnnotation = null;
        requestRender();
      }
      return;
    }

    // Validate minimum size for non-freehand shapes
    if (pendingAnnotation.type !== 'freehand') {
      const w = Math.abs(pendingAnnotation.endX - pendingAnnotation.startX);
      const h = Math.abs(pendingAnnotation.endY - pendingAnnotation.startY);
      if (w < MIN_DRAG_DISTANCE && h < MIN_DRAG_DISTANCE) {
        pendingAnnotation = null;
        requestRender();
        return;
      }
    }

    commitAnnotation(pendingAnnotation);
    pendingAnnotation = null;
    requestRender();
  }

  // ── Text Input ──

  /**
   * Show the text input overlay at the click position.
   * @param {MouseEvent} mouseEvent - Original mouse event
   * @param {number} canvasX - Canvas X coordinate
   * @param {number} canvasY - Canvas Y coordinate
   */
  function showTextInput(mouseEvent, canvasX, canvasY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const wrapperRect = canvasWrapper.getBoundingClientRect();
    const left = mouseEvent.clientX - wrapperRect.left + canvasWrapper.scrollLeft;
    const top = mouseEvent.clientY - wrapperRect.top + canvasWrapper.scrollTop;

    textOverlay.style.display = 'block';
    textOverlay.style.left = `${left}px`;
    textOverlay.style.top = `${top}px`;
    textOverlay.style.color = getColor();
    textOverlay.style.fontSize = `${Math.round(getTextFontSize() / scaleX)}px`;
    textOverlay.value = '';
    textOverlay.focus();
    textOverlay.dataset.cx = canvasX;
    textOverlay.dataset.cy = canvasY;
  }

  /** Commit the current text input as a text annotation. */
  function commitTextInput() {
    const text = textOverlay.value.trim();
    if (text) {
      commitAnnotation({
        type: 'text',
        startX: parseFloat(textOverlay.dataset.cx),
        startY: parseFloat(textOverlay.dataset.cy),
        text,
        color: getColor(),
        strokeWidth: getStrokeWidth(),
        fontSize: getTextFontSize(),
      });
      requestRender();
    }
    textOverlay.style.display = 'none';
    textOverlay.value = '';
  }

  /**
   * Get font size based on current stroke width setting.
   * @returns {number} Font size in pixels
   */
  function getTextFontSize() {
    const sw = getStrokeWidth();
    return TEXT_FONT_SIZES[sw] || 24;
  }

  // ── Crop ──

  /** Apply the pending crop operation. */
  function applyCrop() {
    if (!pendingAnnotation || pendingAnnotation.type !== 'crop') return;

    const x = Math.max(0, Math.round(Math.min(pendingAnnotation.startX, pendingAnnotation.endX)));
    const y = Math.max(0, Math.round(Math.min(pendingAnnotation.startY, pendingAnnotation.endY)));
    const w = Math.min(canvas.width - x, Math.round(Math.abs(pendingAnnotation.endX - pendingAnnotation.startX)));
    const h = Math.min(canvas.height - y, Math.round(Math.abs(pendingAnnotation.endY - pendingAnnotation.startY)));

    if (w < MIN_BLUR_SIZE || h < MIN_BLUR_SIZE) {
      cancelPending();
      return;
    }

    pendingAnnotation = null;
    render();

    const imageData = ctx.getImageData(x, y, w, h);
    canvas.width = w;
    canvas.height = h;
    ctx.putImageData(imageData, 0, 0);

    // Create new base image from the cropped result
    const newImg = new Image();
    newImg.onload = () => {
      baseImage = newImg;
      annotations = [];
      redoStack = [];
      updateUndoRedoButtons();
      updateStatusDimensions();
      requestRender();
    };
    newImg.src = canvas.toDataURL('image/png');

    btnCropApply.style.display = 'none';
    showToast('Crop applied \u2702\uFE0F');
  }

  // ── Keyboard Shortcuts ──

  /**
   * Handle keyboard shortcuts for tools and actions.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      cancelPending();
      setTool(null);
      return;
    }

    // Enter commits text input
    if (e.key === 'Enter' && !e.shiftKey && textOverlay.style.display !== 'none' && document.activeElement === textOverlay) {
      e.preventDefault();
      commitTextInput();
      return;
    }

    // Don't intercept while typing text
    if (document.activeElement === textOverlay) return;

    // Undo/Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); return; }

    // Tool shortcuts
    if (EDITOR_SHORTCUTS[e.key] && !e.ctrlKey && !e.metaKey) {
      setTool(EDITOR_SHORTCUTS[e.key]);
    }
  }

  // ── Color / Stroke Sync ──

  colorPicker.addEventListener('input', () => {
    colorPreview.style.background = colorPicker.value;
  });

  colorPreview.addEventListener('click', () => colorPicker.click());

  // ── Button Setup ──

  /** Bind all editor action buttons. */
  function setupButtons() {
    document.getElementById('btn-copy').addEventListener('click', copyToClipboard);
    document.getElementById('btn-save-png').addEventListener('click', () => saveAs('png'));
    document.getElementById('btn-save-jpg').addEventListener('click', () => saveAs('jpeg'));
    document.getElementById('btn-save-pdf').addEventListener('click', exportPDF);
    document.getElementById('btn-download').addEventListener('click', () => saveAs('png'));
    btnUndo.addEventListener('click', undo);
    btnRedo.addEventListener('click', redo);
    btnCropApply.addEventListener('click', applyCrop);

    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('role', 'button');
    });

    textOverlay.addEventListener('blur', () => {
      setTimeout(() => {
        if (textOverlay.style.display !== 'none') commitTextInput();
      }, 150);
    });
  }

  // ── Image Loading ──

  /** Initialize the editor: load pending capture and set up event listeners. */
  async function init() {
    try {
      const result = await chrome.storage.local.get('pendingCapture');
      if (result.pendingCapture) {
        loadedDataUrl = result.pendingCapture;
        await loadImage(result.pendingCapture);
        await chrome.storage.local.remove('pendingCapture');
        await saveToHistory(result.pendingCapture);
      } else {
        statusDimensions.textContent = 'No capture loaded';
      }
    } catch (err) {
      console.error(LOG_PREFIX, 'Failed to load capture:', err);
      statusDimensions.textContent = 'Load failed';
    }

    setupButtons();
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    colorPreview.style.background = colorPicker.value;
  }

  /**
   * Load an image data URL into the canvas.
   * @param {string} dataUrl - Image data URL
   * @returns {Promise<void>}
   */
  function loadImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        baseImage = img;
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        updateStatusDimensions();
        estimateSize(dataUrl);
        resolve();
      };
      img.onerror = () => {
        console.error(LOG_PREFIX, 'Failed to load image');
        resolve();
      };
      img.src = dataUrl;
    });
  }

  /** Update the status bar with canvas dimensions. */
  function updateStatusDimensions() {
    statusDimensions.textContent = `${canvas.width} \u00D7 ${canvas.height}px`;
  }

  /**
   * Estimate and display the image file size.
   * @param {string} dataUrl - Image data URL
   */
  function estimateSize(dataUrl) {
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) return;
    const base64Length = dataUrl.length - commaIndex - 1;
    const sizeKB = Math.round((base64Length * 3) / 4 / 1024);
    statusSize.textContent = sizeKB > 1024
      ? `~${(sizeKB / 1024).toFixed(1)} MB`
      : `~${sizeKB} KB`;
  }

  // ── Save to History ──

  /**
   * Save the current capture to the extension's history.
   * @param {string} dataUrl - Original image data URL
   */
  async function saveToHistory(dataUrl) {
    try {
      const settings = await getSyncSettings();
      if (settings.keepHistory === 'off') return;

      const maxHistory = settings.maxHistory || 100;
      const result = await chrome.storage.local.get('historyEntries');
      const entries = result.historyEntries || [];

      const thumbnail = await generateThumbnail(dataUrl, THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT);

      const commaIndex = dataUrl.indexOf(',');
      const base64Len = commaIndex !== -1 ? dataUrl.length - commaIndex - 1 : 0;
      const sizeBytes = Math.round((base64Len * 3) / 4);

      // Only store full dataUrl for small screenshots
      const storeDataUrl = sizeBytes < MAX_HISTORY_DATAURL_SIZE ? dataUrl : null;

      const entry = {
        id: crypto.randomUUID(),
        type: 'screenshot',
        name: `ScreenSnap_${getTimestamp()}.png`,
        timestamp: Date.now(),
        width: canvas.width,
        height: canvas.height,
        sizeBytes,
        format: 'png',
        thumbnail,
        dataUrl: storeDataUrl,
        duration: null,
      };

      entries.unshift(entry);
      while (entries.length > maxHistory) entries.pop();

      await chrome.storage.local.set({ historyEntries: entries });
    } catch (err) {
      console.warn(LOG_PREFIX, 'Failed to save to history:', err);
    }
  }

  /**
   * Generate a compressed JPEG thumbnail from a data URL.
   * @param {string} dataUrl - Source image
   * @param {number} maxW - Max thumbnail width
   * @param {number} maxH - Max thumbnail height
   * @returns {Promise<string>} Thumbnail as JPEG data URL
   */
  function generateThumbnail(dataUrl, maxW, maxH) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const result = c.toDataURL('image/jpeg', THUMBNAIL_QUALITY);

        // Cleanup thumbnail canvas
        c.width = 0;
        c.height = 0;

        resolve(result);
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }

  /**
   * Load settings from sync storage.
   * @returns {Promise<Object>} Settings object
   */
  async function getSyncSettings() {
    try {
      const result = await chrome.storage.sync.get('settings');
      return result.settings || {};
    } catch {
      return {};
    }
  }

  // ── Export Functions ──

  /** Finalize the canvas for export by cancelling any pending operation. */
  function renderForExport() {
    cancelPending();
    render();
  }

  /** Copy the current canvas to the clipboard as PNG. */
  async function copyToClipboard() {
    try {
      renderForExport();
      const blob = await canvasToBlob('image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied to clipboard! \uD83D\uDCCB');
    } catch (err) {
      console.error(LOG_PREFIX, 'Clipboard copy failed:', err);
      showToast('Copy failed \u2014 try downloading instead', true);
    }
  }

  /**
   * Save the canvas as an image file.
   * @param {string} format - Image format ('png' | 'jpeg')
   */
  async function saveAs(format) {
    renderForExport();
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const quality = format === 'jpeg' ? JPEG_EXPORT_QUALITY : undefined;
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const filename = `ScreenSnap_${getTimestamp()}.${ext}`;

    try {
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
      showToast(`Saved as ${filename} \uD83D\uDCBE`);
    } catch {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();
      showToast(`Downloaded ${filename} \uD83D\uDCBE`);
    }
  }

  // ── PDF Export (vanilla — no dependencies) ──

  /** Export the canvas as a PDF with embedded JPEG. */
  async function exportPDF() {
    try {
      renderForExport();
      showToast('Generating PDF\u2026');

      const jpegDataUrl = canvas.toDataURL('image/jpeg', JPEG_EXPORT_QUALITY);
      const jpegBase64 = jpegDataUrl.split(',')[1];
      const jpegBytes = base64ToBytes(jpegBase64);

      const pageW = canvas.width;
      const pageH = canvas.height;
      const pdf = buildPDF(jpegBytes, pageW, pageH, canvas.width, canvas.height);
      const blob = new Blob([pdf], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const filename = `ScreenSnap_${getTimestamp()}.pdf`;

      try {
        await chrome.downloads.download({ url, filename, saveAs: true });
      } catch {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      }

      // Revoke the Object URL after a delay to ensure download starts
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast(`Saved as ${filename} \uD83D\uDCC4`);
    } catch (err) {
      console.error(LOG_PREFIX, 'PDF export failed:', err);
      showToast('PDF export failed', true);
    }
  }

  /**
   * Build a minimal valid PDF containing a single JPEG image.
   * @param {Uint8Array} jpegBytes - Raw JPEG image data
   * @param {number} pageW - Page width in points
   * @param {number} pageH - Page height in points
   * @param {number} imgW - Image width
   * @param {number} imgH - Image height
   * @returns {Uint8Array} Complete PDF file as byte array
   */
  function buildPDF(jpegBytes, pageW, pageH, imgW, imgH) {
    const offsets = [];
    let content = '';

    function addObject(id, data) {
      offsets[id] = content.length;
      content += `${id} 0 obj\n${data}\nendobj\n`;
    }

    content = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n';

    addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    addObject(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /XObject << /Img0 5 0 R >> >> >>`);

    const streamContent = `q ${pageW} 0 0 ${pageH} 0 0 cm /Img0 Do Q`;
    addObject(4, `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`);

    const imgDict = `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`;

    const beforeImage = content;
    const obj5Header = `5 0 obj\n${imgDict}\nstream\n`;
    const obj5Footer = '\nendstream\nendobj\n';

    const encoder = new TextEncoder();
    const beforeImageBytes = encoder.encode(beforeImage);
    const obj5HeaderBytes = encoder.encode(obj5Header);
    const obj5FooterBytes = encoder.encode(obj5Footer);

    offsets[5] = beforeImageBytes.length;
    const afterObj5Offset = beforeImageBytes.length + obj5HeaderBytes.length + jpegBytes.length + obj5FooterBytes.length;

    const numObjects = 5;
    let xref = 'xref\n';
    xref += `0 ${numObjects + 1}\n`;
    xref += '0000000000 65535 f \n';
    for (let i = 1; i <= numObjects; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }

    const xrefOffset = afterObj5Offset;
    const trailer = `trailer\n<< /Size ${numObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    const xrefBytes = encoder.encode(xref);
    const trailerBytes = encoder.encode(trailer);

    const totalLength = beforeImageBytes.length + obj5HeaderBytes.length + jpegBytes.length + obj5FooterBytes.length + xrefBytes.length + trailerBytes.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;

    result.set(beforeImageBytes, offset); offset += beforeImageBytes.length;
    result.set(obj5HeaderBytes, offset); offset += obj5HeaderBytes.length;
    result.set(jpegBytes, offset); offset += jpegBytes.length;
    result.set(obj5FooterBytes, offset); offset += obj5FooterBytes.length;
    result.set(xrefBytes, offset); offset += xrefBytes.length;
    result.set(trailerBytes, offset);

    return result;
  }

  /**
   * Convert a base64 string to a Uint8Array.
   * @param {string} base64 - Base64-encoded string
   * @returns {Uint8Array} Decoded byte array
   */
  function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Convert the canvas to a Blob.
   * @param {string} mimeType - Output MIME type
   * @param {number} [quality] - Image quality (0-1)
   * @returns {Promise<Blob>}
   */
  function canvasToBlob(mimeType, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
  }

  // ── Utilities ──

  /**
   * Show a temporary toast notification.
   * @param {string} message - Toast message
   * @param {boolean} [isError=false] - Whether it's an error toast
   */
  function showToast(message, isError = false) {
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
      padding: 10px 20px; background: ${isError ? '#DC2626' : '#059669'};
      color: white; border-radius: 8px; font-size: 13px; font-weight: 500;
      z-index: 9999; animation: fadeInUp 0.3s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, TOAST_DURATION_MS);
  }

  /**
   * Generate a formatted timestamp for filenames.
   * @returns {string} Timestamp in YYYY-MM-DD_HH-MM-SS format
   */
  function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  // ── Boot ──
  document.addEventListener('DOMContentLoaded', init);
})();
