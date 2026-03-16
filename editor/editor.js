/**
 * ScreenSnap — Editor v0.2.0
 * Full annotation editor: arrows, shapes, text, freehand, blur, highlight, crop, undo/redo.
 * All vanilla JS + Canvas API — no external dependencies.
 */

(() => {
  'use strict';

  // ── DOM refs ──
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
  let baseImage = null;           // Original loaded Image element
  let annotations = [];           // History stack of committed annotations
  let redoStack = [];             // Redo stack
  let currentTool = null;         // Active tool name or null
  let drawing = false;            // Is the user currently dragging?
  let pendingAnnotation = null;   // In-progress annotation (preview)
  let rafId = null;               // requestAnimationFrame handle

  // ── Helpers ──

  /** Get current color from picker. */
  const getColor = () => colorPicker.value;

  /** Get current stroke width. */
  const getStrokeWidth = () => parseInt(strokeSelect.value, 10);

  /** Canvas-relative coords from a MouseEvent. */
  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // ── Render pipeline ──

  /** Full redraw: base image → all annotations → pending preview. */
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

  /** Schedule a render via rAF (debounced). */
  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  // ── Drawing individual annotation types ──

  function drawAnnotation(ann) {
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = ann.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (ann.type) {
      case 'arrow':   drawArrow(ann); break;
      case 'rect':    drawRect(ann); break;
      case 'circle':  drawEllipse(ann); break;
      case 'line':    drawLine(ann); break;
      case 'freehand': drawFreehand(ann); break;
      case 'text':    drawText(ann); break;
      case 'blur':    drawBlur(ann); break;
      case 'highlight': drawHighlight(ann); break;
      case 'crop':    drawCropPreview(ann); break;
    }
    ctx.restore();
  }

  function drawArrow(a) {
    const { startX, startY, endX, endY } = a;
    const headLen = Math.max(12, a.strokeWidth * 4);
    const angle = Math.atan2(endY - startY, endX - startX);

    // Shaft
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Arrowhead (filled triangle)
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(
      endX - headLen * Math.cos(angle - Math.PI / 6),
      endY - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      endX - headLen * Math.cos(angle + Math.PI / 6),
      endY - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  function drawRect(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);
    const r = Math.min(8, Math.min(w, h) / 4); // rounded corners
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

  function drawEllipse(a) {
    const cx = (a.startX + a.endX) / 2;
    const cy = (a.startY + a.endY) / 2;
    const rx = Math.abs(a.endX - a.startX) / 2;
    const ry = Math.abs(a.endY - a.startY) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawLine(a) {
    ctx.beginPath();
    ctx.moveTo(a.startX, a.startY);
    ctx.lineTo(a.endX, a.endY);
    ctx.stroke();
  }

  function drawFreehand(a) {
    if (!a.points || a.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(a.points[0].x, a.points[0].y);
    for (let i = 1; i < a.points.length; i++) {
      ctx.lineTo(a.points[i].x, a.points[i].y);
    }
    ctx.stroke();
  }

  function drawText(a) {
    ctx.font = `${a.fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = a.color;
    ctx.textBaseline = 'top';

    // Multi-line support
    const lines = (a.text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], a.startX, a.startY + i * (a.fontSize * 1.2));
    }
  }

  function drawBlur(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);
    if (w < 2 || h < 2) return;

    // Pixelate: sample image at low res and draw scaled up
    const pixelSize = Math.max(6, Math.round(Math.min(w, h) / 12));
    const imgData = ctx.getImageData(x, y, w, h);

    for (let py = 0; py < h; py += pixelSize) {
      for (let px = 0; px < w; px += pixelSize) {
        // Average the block
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
        ctx.fillRect(
          x + px, y + py,
          Math.min(pixelSize, w - px),
          Math.min(pixelSize, h - py)
        );
      }
    }
  }

  function drawHighlight(a) {
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);
    ctx.fillStyle = 'rgba(255, 214, 0, 0.35)';
    ctx.fillRect(x, y, w, h);
  }

  function drawCropPreview(a) {
    // Dim everything outside the crop area
    const x = Math.min(a.startX, a.endX);
    const y = Math.min(a.startY, a.endY);
    const w = Math.abs(a.endX - a.startX);
    const h = Math.abs(a.endY - a.startY);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    // Top
    ctx.fillRect(0, 0, canvas.width, y);
    // Bottom
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    // Left
    ctx.fillRect(0, y, x, h);
    // Right
    ctx.fillRect(x + w, y, canvas.width - x - w, h);

    // Crop border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // ── History management ──

  function commitAnnotation(ann) {
    annotations.push(ann);
    redoStack = []; // Clear redo when new action committed
    updateUndoRedoButtons();
  }

  function undo() {
    if (annotations.length === 0) return;
    redoStack.push(annotations.pop());
    updateUndoRedoButtons();
    requestRender();
  }

  function redo() {
    if (redoStack.length === 0) return;
    annotations.push(redoStack.pop());
    updateUndoRedoButtons();
    requestRender();
  }

  function updateUndoRedoButtons() {
    btnUndo.disabled = annotations.length === 0;
    btnRedo.disabled = redoStack.length === 0;
  }

  // ── Tool selection ──

  function setTool(name) {
    cancelPending();
    currentTool = name;

    // Update UI
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === name);
    });

    // Update cursor
    canvas.className = '';
    if (name === 'text') canvas.classList.add('cursor-text');
    else if (name === 'crop') canvas.classList.add('cursor-crop');
    else if (name) canvas.classList.add('cursor-crosshair');

    statusTool.textContent = name ? `Tool: ${name.charAt(0).toUpperCase() + name.slice(1)}` : 'Tool: None';
  }

  function cancelPending() {
    drawing = false;
    pendingAnnotation = null;
    btnCropApply.style.display = 'none';
    textOverlay.style.display = 'none';
    requestRender();
  }

  // ── Mouse event handlers ──

  function onMouseDown(e) {
    if (!currentTool) return;
    if (e.button !== 0) return; // Left click only

    const { x, y } = canvasCoords(e);

    // Special: text tool opens input overlay
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

    // Special: crop shows confirm button instead of committing
    if (pendingAnnotation.type === 'crop') {
      const w = Math.abs(pendingAnnotation.endX - pendingAnnotation.startX);
      const h = Math.abs(pendingAnnotation.endY - pendingAnnotation.startY);
      if (w > 5 && h > 5) {
        btnCropApply.style.display = 'block';
        requestRender();
      } else {
        pendingAnnotation = null;
        requestRender();
      }
      return;
    }

    // Check minimum size to avoid accidental clicks
    if (pendingAnnotation.type !== 'freehand') {
      const w = Math.abs(pendingAnnotation.endX - pendingAnnotation.startX);
      const h = Math.abs(pendingAnnotation.endY - pendingAnnotation.startY);
      if (w < 3 && h < 3) {
        pendingAnnotation = null;
        requestRender();
        return;
      }
    }

    commitAnnotation(pendingAnnotation);
    pendingAnnotation = null;
    requestRender();
  }

  // ── Text input ──

  function showTextInput(mouseEvent, canvasX, canvasY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    // Position overlay at click location (in page coords)
    const left = mouseEvent.clientX - canvasWrapper.getBoundingClientRect().left + canvasWrapper.scrollLeft;
    const top = mouseEvent.clientY - canvasWrapper.getBoundingClientRect().top + canvasWrapper.scrollTop;

    textOverlay.style.display = 'block';
    textOverlay.style.left = `${left}px`;
    textOverlay.style.top = `${top}px`;
    textOverlay.style.color = getColor();
    textOverlay.style.fontSize = `${Math.round(getTextFontSize() / scaleX)}px`;
    textOverlay.value = '';
    textOverlay.focus();

    // Store canvas coords for commit
    textOverlay.dataset.cx = canvasX;
    textOverlay.dataset.cy = canvasY;
  }

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

  /** Font size scales with stroke width setting. */
  function getTextFontSize() {
    const sw = getStrokeWidth();
    if (sw <= 2) return 16;
    if (sw <= 4) return 24;
    return 36;
  }

  // ── Crop ──

  function applyCrop() {
    if (!pendingAnnotation || pendingAnnotation.type !== 'crop') return;

    const x = Math.max(0, Math.round(Math.min(pendingAnnotation.startX, pendingAnnotation.endX)));
    const y = Math.max(0, Math.round(Math.min(pendingAnnotation.startY, pendingAnnotation.endY)));
    const w = Math.min(canvas.width - x, Math.round(Math.abs(pendingAnnotation.endX - pendingAnnotation.startX)));
    const h = Math.min(canvas.height - y, Math.round(Math.abs(pendingAnnotation.endY - pendingAnnotation.startY)));

    if (w < 2 || h < 2) {
      cancelPending();
      return;
    }

    // Render current state (without crop overlay) to a temp canvas
    pendingAnnotation = null;
    render(); // draw clean state

    const imageData = ctx.getImageData(x, y, w, h);

    // Resize canvas
    canvas.width = w;
    canvas.height = h;
    ctx.putImageData(imageData, 0, 0);

    // Update base image to the cropped result
    const newImg = new Image();
    newImg.onload = () => {
      baseImage = newImg;
      // Clear all annotations (they were baked into the crop)
      annotations = [];
      redoStack = [];
      updateUndoRedoButtons();
      updateStatusDimensions();
      requestRender();
    };
    newImg.src = canvas.toDataURL('image/png');

    btnCropApply.style.display = 'none';
    showToast('Crop applied ✂️');
  }

  // ── Keyboard shortcuts ──

  function onKeyDown(e) {
    // ESC: cancel pending operation
    if (e.key === 'Escape') {
      cancelPending();
      setTool(null);
      return;
    }

    // Enter in text overlay → commit
    if (e.key === 'Enter' && !e.shiftKey && textOverlay.style.display !== 'none' && document.activeElement === textOverlay) {
      e.preventDefault();
      commitTextInput();
      return;
    }

    // Don't intercept if typing in text overlay
    if (document.activeElement === textOverlay) return;

    // Ctrl+Z / Ctrl+Shift+Z
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      redo();
      return;
    }

    // Tool shortcuts
    const shortcuts = {
      a: 'arrow', r: 'rect', e: 'circle', l: 'line',
      p: 'freehand', t: 'text', b: 'blur', h: 'highlight', c: 'crop',
    };
    if (shortcuts[e.key] && !e.ctrlKey && !e.metaKey) {
      setTool(shortcuts[e.key]);
    }
  }

  // ── Color / stroke sync ──

  colorPicker.addEventListener('input', () => {
    colorPreview.style.background = colorPicker.value;
  });

  // Click on color preview opens the native picker
  colorPreview.addEventListener('click', () => colorPicker.click());

  // ── Button setup ──

  function setupButtons() {
    document.getElementById('btn-copy').addEventListener('click', copyToClipboard);
    document.getElementById('btn-save-png').addEventListener('click', () => saveAs('png'));
    document.getElementById('btn-save-jpg').addEventListener('click', () => saveAs('jpeg'));
    document.getElementById('btn-download').addEventListener('click', () => saveAs('png'));
    btnUndo.addEventListener('click', undo);
    btnRedo.addEventListener('click', redo);
    btnCropApply.addEventListener('click', applyCrop);

    // Tool buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    // Text overlay blur → commit
    textOverlay.addEventListener('blur', () => {
      // Small delay so that a deliberate click elsewhere still triggers commit
      setTimeout(() => {
        if (textOverlay.style.display !== 'none') commitTextInput();
      }, 150);
    });
  }

  // ── Image loading ──

  async function init() {
    const result = await chrome.storage.local.get('pendingCapture');

    if (result.pendingCapture) {
      await loadImage(result.pendingCapture);
      await chrome.storage.local.remove('pendingCapture');
    } else {
      statusDimensions.textContent = 'No capture loaded';
    }

    setupButtons();

    // Canvas events
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);

    // Init color preview
    colorPreview.style.background = colorPicker.value;
  }

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
      img.src = dataUrl;
    });
  }

  function updateStatusDimensions() {
    statusDimensions.textContent = `${canvas.width} × ${canvas.height}px`;
  }

  function estimateSize(dataUrl) {
    const base64Length = dataUrl.length - dataUrl.indexOf(',') - 1;
    const sizeKB = Math.round((base64Length * 3) / 4 / 1024);
    statusSize.textContent = sizeKB > 1024 ? `~${(sizeKB / 1024).toFixed(1)} MB` : `~${sizeKB} KB`;
  }

  // ── Export functions ──

  /** Ensure canvas shows final state before export. */
  function renderForExport() {
    cancelPending();
    render();
  }

  async function copyToClipboard() {
    try {
      renderForExport();
      const blob = await canvasToBlob('image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied to clipboard! 📋');
    } catch (err) {
      console.error('[ScreenSnap] Clipboard copy failed:', err);
      showToast('Copy failed — try downloading instead', true);
    }
  }

  async function saveAs(format) {
    renderForExport();
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const quality = format === 'jpeg' ? 0.92 : undefined;
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const filename = `ScreenSnap_${getTimestamp()}.${ext}`;

    try {
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
      showToast(`Saved as ${filename} 💾`);
    } catch (_) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();
      showToast(`Downloaded ${filename} 💾`);
    }
  }

  function canvasToBlob(mimeType, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
  }

  // ── Utilities ──

  function showToast(message, isError = false) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const toast = document.createElement('div');
    toast.className = 'toast';
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
    }, 2500);
  }

  function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  // ── Boot ──
  document.addEventListener('DOMContentLoaded', init);
})();
