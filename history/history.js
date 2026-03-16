/**
 * @file ScreenSnap — History Page v0.5.0
 * @description Displays all captured screenshots and recordings with filtering, search,
 * sorting, and pagination. Uses safe DOM construction (no innerHTML for user data).
 * @version 0.5.0
 */

(() => {
  'use strict';

  // ── Constants ───────────────────────────────────
  const PAGE_SIZE = 24;

  // ── State ───────────────────────────────────────
  /** @type {Array<Object>} All history entries from storage */
  let allEntries = [];

  /** @type {Array<Object>} Filtered and sorted entries */
  let filteredEntries = [];

  /** @type {string} Current type filter */
  let currentFilter = 'all';

  /** @type {string} Current sort mode */
  let currentSort = 'date-desc';

  /** @type {string} Current search query (lowercase) */
  let searchQuery = '';

  /** @type {number} Number of currently displayed items */
  let displayedCount = 0;

  // ── DOM Refs ──
  const grid = document.getElementById('history-grid');
  const emptyState = document.getElementById('empty-state');
  const countLabel = document.getElementById('count-label');
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');
  const loadMoreContainer = document.getElementById('load-more-container');
  const btnLoadMore = document.getElementById('btn-load-more');
  const btnClearAll = document.getElementById('btn-clear-all');

  // ── Init ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    await loadEntries();
    applyFilters();
    setupEvents();
  });

  /**
   * Load history entries from chrome.storage.local.
   */
  async function loadEntries() {
    try {
      const result = await chrome.storage.local.get('historyEntries');
      allEntries = result.historyEntries || [];
    } catch (err) {
      console.error('[ScreenSnap][History] Failed to load entries:', err);
      allEntries = [];
    }
  }

  // ── Event Setup ─────────────────────────────────

  /** Bind all interactive elements. */
  function setupEvents() {
    // Filter tabs
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelector('.filter-btn.active')?.classList.remove('active');
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        applyFilters();
      });
    });

    // Search with debounce
    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = searchInput.value.toLowerCase().trim();
        applyFilters();
      }, 200);
    });

    // Sort
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      applyFilters();
    });

    // Load more
    btnLoadMore.addEventListener('click', renderMore);

    // Clear all
    btnClearAll.addEventListener('click', () => {
      showConfirmDialog(
        'Clear All History',
        'This will permanently delete all history entries. This action cannot be undone.',
        async () => {
          allEntries = [];
          await chrome.storage.local.set({ historyEntries: [] });
          applyFilters();
        }
      );
    });
  }

  // ── Filtering & Sorting ─────────────────────────

  /** Apply current filter, search, and sort then re-render. */
  function applyFilters() {
    let entries = allEntries;

    // Filter by type
    if (currentFilter !== 'all') {
      entries = entries.filter(e => e.type === currentFilter);
    }

    // Search by name
    if (searchQuery) {
      entries = entries.filter(e => e.name && e.name.toLowerCase().includes(searchQuery));
    }

    // Sort
    entries = [...entries];
    switch (currentSort) {
      case 'date-desc': entries.sort((a, b) => b.timestamp - a.timestamp); break;
      case 'date-asc': entries.sort((a, b) => a.timestamp - b.timestamp); break;
      case 'size-desc': entries.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)); break;
      case 'size-asc': entries.sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0)); break;
      case 'name-asc': entries.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break;
      case 'name-desc': entries.sort((a, b) => (b.name || '').localeCompare(a.name || '')); break;
    }

    filteredEntries = entries;
    displayedCount = 0;

    // Clear grid safely
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    renderMore();
    updateUI();
  }

  /** Render the next page of items. */
  function renderMore() {
    const end = Math.min(displayedCount + PAGE_SIZE, filteredEntries.length);
    for (let i = displayedCount; i < end; i++) {
      grid.appendChild(createItemCard(filteredEntries[i]));
    }
    displayedCount = end;
    updateUI();
  }

  /** Update count label, empty state, and load-more visibility. */
  function updateUI() {
    const total = filteredEntries.length;
    countLabel.textContent = `${total} item${total !== 1 ? 's' : ''}`;
    emptyState.style.display = total === 0 ? 'block' : 'none';
    grid.style.display = total === 0 ? 'none' : 'grid';
    loadMoreContainer.style.display = displayedCount < total ? 'block' : 'none';
  }

  // ── Card Rendering (safe DOM construction) ──────

  /**
   * Create a history item card element.
   * @param {Object} entry - History entry object
   * @returns {HTMLElement} Card element
   */
  function createItemCard(entry) {
    const card = document.createElement('div');
    card.className = 'history-item';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${entry.name} — ${entry.type}`);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.item-delete')) return;
      openEntry(entry);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEntry(entry);
      }
    });

    // Thumbnail
    const thumb = document.createElement('img');
    thumb.className = 'item-thumbnail';
    thumb.src = entry.thumbnail || generatePlaceholderSvg();
    thumb.alt = entry.name || 'Capture thumbnail';
    thumb.loading = 'lazy';
    card.appendChild(thumb);

    // Duration overlay for recordings
    if (entry.type === 'recording' && entry.duration) {
      const dur = document.createElement('span');
      dur.className = 'item-duration';
      dur.textContent = formatDuration(entry.duration);
      dur.setAttribute('aria-label', `Duration: ${formatDuration(entry.duration)}`);
      card.appendChild(dur);
    }

    // Delete button
    const del = document.createElement('button');
    del.className = 'item-delete';
    del.textContent = '\u2715';
    del.title = 'Delete this item';
    del.setAttribute('aria-label', `Delete ${entry.name}`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEntry(entry.id);
    });
    card.appendChild(del);

    // Info section
    const info = document.createElement('div');
    info.className = 'item-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'item-name';
    nameEl.textContent = entry.name || 'Untitled';
    nameEl.title = entry.name || '';
    info.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const badge = document.createElement('span');
    badge.className = `item-type-badge ${entry.type === 'recording' ? 'recording' : ''}`;
    badge.textContent = entry.type === 'screenshot' ? '\uD83D\uDCF8 IMG' : '\uD83C\uDFA5 VID';
    meta.appendChild(badge);

    const details = document.createElement('span');
    const dateStr = new Date(entry.timestamp).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const sizeStr = entry.sizeBytes ? formatSize(entry.sizeBytes) : '';
    details.textContent = `${dateStr}${sizeStr ? ' \u00B7 ' + sizeStr : ''}`;
    meta.appendChild(details);

    info.appendChild(meta);
    card.appendChild(info);

    return card;
  }

  /**
   * Generate a placeholder SVG data URL for items without thumbnails.
   * @returns {string} SVG data URL
   */
  function generatePlaceholderSvg() {
    return 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">' +
      '<rect fill="#334155" width="240" height="160"/>' +
      '<text x="120" y="85" text-anchor="middle" fill="#94A3B8" font-size="14">No preview</text>' +
      '</svg>'
    );
  }

  // ── Actions ─────────────────────────────────────

  /**
   * Open a history entry (screenshot in editor, recording shows info).
   * @param {Object} entry - History entry
   */
  function openEntry(entry) {
    if (entry.type === 'screenshot' && entry.dataUrl) {
      chrome.storage.local.set({ pendingCapture: entry.dataUrl }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
      });
    } else if (entry.type === 'recording') {
      showToast('Recording files are saved in your Downloads folder');
    }
  }

  /**
   * Delete a single history entry by ID.
   * @param {string} id - Entry ID to delete
   */
  async function deleteEntry(id) {
    allEntries = allEntries.filter(e => e.id !== id);
    await chrome.storage.local.set({ historyEntries: allEntries });
    applyFilters();
  }

  // ── Confirm Dialog (safe DOM construction) ──────

  /**
   * Show a confirmation dialog.
   * @param {string} title - Dialog title
   * @param {string} message - Dialog body text
   * @param {Function} onConfirm - Callback when user confirms
   */
  function showConfirmDialog(title, message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    dialog.appendChild(h3);

    const p = document.createElement('p');
    p.textContent = message;
    dialog.appendChild(p);

    const buttons = document.createElement('div');
    buttons.className = 'dialog-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-confirm-no';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    buttons.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-confirm-yes';
    confirmBtn.textContent = 'Delete All';
    confirmBtn.addEventListener('click', () => {
      onConfirm();
      overlay.remove();
    });
    buttons.appendChild(confirmBtn);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    cancelBtn.focus();
  }

  // ── Helpers ─────────────────────────────────────

  /**
   * Format bytes into a human-readable size string.
   * @param {number} bytes
   * @returns {string}
   */
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /**
   * Format seconds into MM:SS display.
   * @param {number} seconds
   * @returns {string}
   */
  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Show a temporary toast notification.
   * @param {string} message
   */
  function showToast(message) {
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }
})();
