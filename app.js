'use strict';

(function VaultApp() {
  const DB_NAME = 'WhereIsMyStuffDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'items';
  const THEME_STORAGE_KEY = 'vault-theme';

  const NLP_PATTERNS = [
    { regex: /put the (.+?) in the (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /put the (.+?) on the (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /left (?:the )?(.+?) in (?:the )?(.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /left (?:the )?(.+?) on (?:the )?(.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /stored (?:the )?(.+?) in (?:the )?(.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /hid (?:the )?(.+?) in (?:the )?(.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /(.+?) is inside the (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /(.+?) is under the (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /(.+?) is in the (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /(.+?) is on the (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /(.+?) inside (.+)/i, itemGroup: 1, locationGroup: 2 },
    { regex: /(.+?) in (.+)/i, itemGroup: 1, locationGroup: 2 }
  ];

  const STRUCTURAL_SPLITTERS = [
    { regex: /^(.+?)\s*->\s*(.+)$/, itemGroup: 1, locationGroup: 2 },
    { regex: /^(.+?)\s*-\s*(.+)$/, itemGroup: 1, locationGroup: 2 },
    { regex: /^(.+?)\s+at\s+(.+)$/i, itemGroup: 1, locationGroup: 2 },
    { regex: /^(.+?)\s+in\s+(.+)$/i, itemGroup: 1, locationGroup: 2 }
  ];

  let db = null;
  let allItems = [];
  let recognition = null;
  let isRecording = false;
  let speechSupported = false;
  let usingFallbackEngine = false;
  let finalTranscriptBuffer = '';
  let relativeTimeIntervalId = null;
  let undoDeleteSnapshot = null;
  let undoDeleteTimeoutId = null;
  let searchActiveIndex = -1;
  let deferredInstallPrompt = null;
  let holdRecordActive = false;
  let holdRecordPointerId = null;
  let holdRecordStartTime = 0;
  let suppressClickToggle = false;

  const dom = {
    html: document.documentElement,
    persistenceBadge: document.getElementById('persistence-badge'),
    installButton: document.getElementById('install-button'),
    themeToggle: document.getElementById('theme-toggle'),
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),
    searchResults: document.getElementById('search-results'),
    engineState: document.getElementById('engine-state'),
    engineLabel: document.getElementById('engine-label'),
    transcriptDisplay: document.getElementById('transcript-display'),
    audioBars: document.getElementById('audio-bars'),
    parsePreview: document.getElementById('parse-preview'),
    parsePreviewItem: document.getElementById('parse-preview-item'),
    parsePreviewLocation: document.getElementById('parse-preview-location'),
    visualizerCard: document.querySelector('.visualizer-card'),
    recordButton: document.getElementById('record-button'),
    recordRipple: document.getElementById('record-ripple'),
    manualEntryButton: document.getElementById('manual-entry-button'),
    backupButton: document.getElementById('backup-button'),
    importInput: document.getElementById('import-input'),
    historyList: document.getElementById('history-list'),
    historyCount: document.getElementById('history-count'),
    historyStats: document.getElementById('history-stats'),
    statLocations: document.getElementById('stat-locations'),
    statRecent: document.getElementById('stat-recent'),
    historyEmpty: document.getElementById('history-empty'),
    manualOverlay: document.getElementById('manual-input-overlay'),
    manualInput: document.getElementById('manual-input'),
    manualSubmit: document.getElementById('manual-submit'),
    manualOverlayClose: document.getElementById('manual-overlay-close'),
    toastContainer: document.getElementById('toast-container')
  };

  function capitalizeWords(str) {
    return str
      .trim()
      .split(/\s+/)
      .map(function onWord(word) {
        if (word.length === 0) {
          return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
  }

  function cleanSegment(segment) {
    return segment
      .trim()
      .replace(/^the\s+/i, '')
      .replace(/^my\s+/i, '')
      .replace(/^a\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSpeechInput(rawText) {
    return rawText
      .trim()
      .replace(/^i\s+/i, '')
      .replace(/^i've\s+/i, '')
      .replace(/^i've\s+got\s+/i, '')
      .replace(/^i\s+left\s+/i, 'left ')
      .replace(/^i\s+stored\s+/i, 'stored ')
      .replace(/^i\s+hid\s+/i, 'hid ')
      .replace(/^okay\s+/i, '')
      .replace(/^ok\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseStashInput(rawText) {
    const text = normalizeSpeechInput(rawText);

    if (text.length === 0) {
      return null;
    }

    let matchIndex = 0;
    while (matchIndex < NLP_PATTERNS.length) {
      const pattern = NLP_PATTERNS[matchIndex];
      const match = text.match(pattern.regex);
      if (match) {
        const itemName = cleanSegment(match[pattern.itemGroup]);
        const locationName = cleanSegment(match[pattern.locationGroup]);
        if (itemName.length > 0 && locationName.length > 0) {
          return {
            item_name: capitalizeWords(itemName),
            location_name: capitalizeWords(locationName),
            raw_text: text
          };
        }
      }
      matchIndex = matchIndex + 1;
    }

    let splitterIndex = 0;
    while (splitterIndex < STRUCTURAL_SPLITTERS.length) {
      const splitter = STRUCTURAL_SPLITTERS[splitterIndex];
      const splitMatch = text.match(splitter.regex);
      if (splitMatch) {
        const splitItem = cleanSegment(splitMatch[splitter.itemGroup]);
        const splitLocation = cleanSegment(splitMatch[splitter.locationGroup]);
        if (splitItem.length > 0 && splitLocation.length > 0) {
          return {
            item_name: capitalizeWords(splitItem),
            location_name: capitalizeWords(splitLocation),
            raw_text: text
          };
        }
      }
      splitterIndex = splitterIndex + 1;
    }

    return {
      item_name: capitalizeWords(text),
      location_name: 'Unspecified Location',
      raw_text: text
    };
  }

  function formatRelativeTime(timestamp) {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 10) {
      return 'Just now';
    }
    if (diffSec < 60) {
      return diffSec + ' seconds ago';
    }
    if (diffMin === 1) {
      return '1 minute ago';
    }
    if (diffMin < 60) {
      return diffMin + ' minutes ago';
    }
    if (diffHour === 1) {
      return '1 hour ago';
    }
    if (diffHour < 24) {
      return diffHour + ' hours ago';
    }
    if (diffDay === 1) {
      return 'Yesterday';
    }
    if (diffDay < 7) {
      return diffDay + ' days ago';
    }
    if (diffDay < 14) {
      return '1 week ago';
    }
    if (diffDay < 30) {
      const weeks = Math.floor(diffDay / 7);
      return weeks + ' weeks ago';
    }
    if (diffDay < 60) {
      return '1 month ago';
    }
    if (diffDay < 365) {
      const months = Math.floor(diffDay / 30);
      return months + ' months ago';
    }
    const years = Math.floor(diffDay / 365);
    if (years === 1) {
      return '1 year ago';
    }
    return years + ' years ago';
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function highlightMatch(text, query) {
    if (!query || query.trim().length === 0) {
      return escapeHtml(text);
    }

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase().trim();
    const matchIndex = lowerText.indexOf(lowerQuery);

    if (matchIndex === -1) {
      return escapeHtml(text);
    }

    const before = text.slice(0, matchIndex);
    const matched = text.slice(matchIndex, matchIndex + lowerQuery.length);
    const after = text.slice(matchIndex + lowerQuery.length);

    return (
      escapeHtml(before) +
      '<mark class="search-highlight">' + escapeHtml(matched) + '</mark>' +
      escapeHtml(after)
    );
  }

  function showToast(message, type, actionLabel, actionCallback) {
    const toastType = type || 'success';
    const toast = document.createElement('div');
    toast.className = 'toast toast--' + toastType;

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    toast.appendChild(messageSpan);

    if (actionLabel && typeof actionCallback === 'function') {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'toast__action';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', function onActionClick() {
        actionCallback();
        toast.classList.add('toast--exit');
        setTimeout(function onActionRemove() {
          if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
          }
        }, 300);
      });
      toast.appendChild(actionBtn);
    }

    dom.toastContainer.appendChild(toast);

    setTimeout(function onToastTimeout() {
      toast.classList.add('toast--exit');
      setTimeout(function onToastRemove() {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, actionLabel ? 5000 : 2800);
  }

  function updateParsePreview(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      dom.parsePreview.classList.add('parse-preview--hidden');
      return;
    }

    const parsed = parseStashInput(trimmed);
    if (parsed) {
      dom.parsePreviewItem.textContent = parsed.item_name;
      dom.parsePreviewLocation.textContent = parsed.location_name;
      dom.parsePreview.classList.remove('parse-preview--hidden');
    } else {
      dom.parsePreview.classList.add('parse-preview--hidden');
    }
  }

  function setListeningVisuals(active) {
    if (active) {
      dom.audioBars.classList.remove('audio-bars--hidden');
    } else {
      dom.audioBars.classList.add('audio-bars--hidden');
    }
  }

  function setEngineState(state, labelText) {
    dom.engineState.className = 'engine-state engine-state--' + state;
    dom.visualizerCard.className = 'visualizer-card';

    if (state === 'listening') {
      dom.engineState.textContent = 'Listening...';
      dom.visualizerCard.classList.add('visualizer-card--listening');
    } else if (state === 'processing') {
      dom.engineState.textContent = 'Processing...';
      dom.visualizerCard.classList.add('visualizer-card--processing');
    } else if (state === 'saved') {
      dom.engineState.textContent = 'Saved!';
      dom.visualizerCard.classList.add('visualizer-card--saved');
    } else if (state === 'error') {
      dom.engineState.textContent = 'Error';
    } else {
      dom.engineState.textContent = 'System Ready';
    }

    if (labelText) {
      dom.engineLabel.textContent = labelText;
    }
  }

  function renderTranscriptWords(finalWords, interimWords) {
    dom.transcriptDisplay.innerHTML = '';

    if (finalWords.length === 0 && interimWords.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'transcript-display__placeholder';
      placeholder.textContent = 'Tap the record button and say where you put something…';
      dom.transcriptDisplay.appendChild(placeholder);
      updateParsePreview('');
      return;
    }

    let wordIndex = 0;
    while (wordIndex < finalWords.length) {
      const span = document.createElement('span');
      span.className = 'transcript-display__word transcript-display__word--final';
      span.textContent = finalWords[wordIndex];
      dom.transcriptDisplay.appendChild(span);
      if (wordIndex < finalWords.length - 1 || interimWords.length > 0) {
        dom.transcriptDisplay.appendChild(document.createTextNode(' '));
      }
      wordIndex = wordIndex + 1;
    }

    let interimIndex = 0;
    while (interimIndex < interimWords.length) {
      const interimSpan = document.createElement('span');
      interimSpan.className = 'transcript-display__word transcript-display__word--interim';
      interimSpan.textContent = interimWords[interimIndex];
      dom.transcriptDisplay.appendChild(interimSpan);
      if (interimIndex < interimWords.length - 1) {
        dom.transcriptDisplay.appendChild(document.createTextNode(' '));
      }
      interimIndex = interimIndex + 1;
    }

    const fullText = finalWords.concat(interimWords).join(' ');
    if (finalWords.length > 0) {
      updateParsePreview(finalWords.join(' ') + (interimWords.length > 0 ? ' ' + interimWords.join(' ') : ''));
    } else {
      updateParsePreview(fullText);
    }
  }

  function triggerHaptic(duration) {
    if (navigator.vibrate) {
      navigator.vibrate(duration);
    }
  }

  function openDatabase() {
    return new Promise(function onOpen(resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function onUpgradeNeeded(event) {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true
          });
          store.createIndex('item_name', 'item_name', { unique: false });
          store.createIndex('created_at', 'created_at', { unique: false });
        }
      };

      request.onsuccess = function onSuccess(event) {
        db = event.target.result;
        resolve(db);
      };

      request.onerror = function onError(event) {
        reject(event.target.error);
      };
    });
  }

  function getAllItemsFromDB() {
    return new Promise(function onGetAll(resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = function onGetAllSuccess() {
        const items = request.result || [];
        items.sort(function onSort(a, b) {
          return b.created_at - a.created_at;
        });
        resolve(items);
      };

      request.onerror = function onGetAllError(event) {
        reject(event.target.error);
      };
    });
  }

  function addItemToDB(itemData) {
    return new Promise(function onAdd(resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const record = {
        item_name: itemData.item_name,
        location_name: itemData.location_name,
        raw_text: itemData.raw_text,
        created_at: itemData.created_at || Date.now()
      };
      const request = store.add(record);

      request.onsuccess = function onAddSuccess() {
        record.id = request.result;
        resolve(record);
      };

      request.onerror = function onAddError(event) {
        reject(event.target.error);
      };
    });
  }

  function deleteItemFromDB(id) {
    return new Promise(function onDelete(resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = function onDeleteSuccess() {
        resolve(id);
      };

      request.onerror = function onDeleteError(event) {
        reject(event.target.error);
      };
    });
  }

  function clearAllItemsFromDB() {
    return new Promise(function onClear(resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = function onClearSuccess() {
        resolve();
      };

      request.onerror = function onClearError(event) {
        reject(event.target.error);
      };
    });
  }

  function bulkInsertItems(items) {
    return new Promise(function onBulkInsert(resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let insertIndex = 0;

      function insertNext() {
        if (insertIndex >= items.length) {
          resolve();
          return;
        }

        const item = items[insertIndex];
        const record = {
          item_name: item.item_name,
          location_name: item.location_name,
          raw_text: item.raw_text || '',
          created_at: item.created_at || Date.now()
        };
        const request = store.add(record);

        request.onsuccess = function onItemInserted() {
          insertIndex = insertIndex + 1;
          insertNext();
        };

        request.onerror = function onItemInsertError(event) {
          reject(event.target.error);
        };
      }

      insertNext();
    });
  }

  function updateHistoryStats() {
    if (allItems.length === 0) {
      dom.historyStats.classList.add('history-stats--hidden');
      return;
    }

    dom.historyStats.classList.remove('history-stats--hidden');

    const locationSet = {};
    let locationIndex = 0;
    while (locationIndex < allItems.length) {
      locationSet[allItems[locationIndex].location_name.toLowerCase()] = true;
      locationIndex = locationIndex + 1;
    }
    const uniqueLocations = Object.keys(locationSet).length;
    dom.statLocations.textContent = uniqueLocations === 1 ? '1 location' : uniqueLocations + ' locations';

    if (allItems.length > 0) {
      dom.statRecent.textContent = 'Latest: ' + formatRelativeTime(allItems[0].created_at);
    }
  }

  function copyLocationToClipboard(item, cardElement) {
    const locationText = item.location_name;

    function onCopied() {
      cardElement.classList.add('history-card--copied');
      showToast('Copied location: ' + locationText, 'success');
      triggerHaptic(30);
      setTimeout(function onCopyReset() {
        cardElement.classList.remove('history-card--copied');
      }, 1200);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(locationText).then(onCopied).catch(function onCopyFail() {
        showToast(locationText, 'success');
      });
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = locationText;
      textarea.className = 'visually-hidden';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        onCopied();
      } catch (error) {
        showToast(locationText, 'success');
      }
      document.body.removeChild(textarea);
    }
  }

  function bindSwipeOnCard(wrapper, card, item) {
    let touchStartX = 0;
    let touchStartY = 0;
    let currentTranslateX = 0;
    let isSwiping = false;

    card.addEventListener('touchstart', function onTouchStart(event) {
      if (event.touches.length !== 1) {
        return;
      }
      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
      isSwiping = false;
      card.classList.add('history-card--swiping');
    }, { passive: true });

    card.addEventListener('touchmove', function onTouchMove(event) {
      if (event.touches.length !== 1) {
        return;
      }

      const deltaX = event.touches[0].clientX - touchStartX;
      const deltaY = event.touches[0].clientY - touchStartY;

      if (!isSwiping && Math.abs(deltaY) > Math.abs(deltaX)) {
        return;
      }

      if (Math.abs(deltaX) > 8) {
        isSwiping = true;
      }

      if (isSwiping && deltaX < 0) {
        event.preventDefault();
        currentTranslateX = Math.max(deltaX, -120);
        card.style.transform = 'translateX(' + currentTranslateX + 'px)';
      }
    }, { passive: false });

    card.addEventListener('touchend', function onTouchEnd() {
      card.classList.remove('history-card--swiping');

      if (currentTranslateX < -80) {
        card.style.transform = 'translateX(-120px)';
        setTimeout(function onSwipeDelete() {
          handleDeleteItem(item.id, wrapper);
        }, 150);
      } else {
        card.style.transform = 'translateX(0)';
      }

      currentTranslateX = 0;
      isSwiping = false;
    }, { passive: true });
  }

  function createHistoryCardElement(item) {
    const wrapper = document.createElement('li');
    wrapper.className = 'history-card-wrapper';
    wrapper.setAttribute('role', 'listitem');

    const deleteBg = document.createElement('div');
    deleteBg.className = 'history-card-wrapper__delete-bg';
    deleteBg.textContent = 'Delete';

    const card = document.createElement('div');
    card.className = 'history-card';
    card.dataset.id = String(item.id);

    card.innerHTML =
      '<div class="history-card__content" title="Tap to copy location">' +
        '<span class="history-card__item">' + escapeHtml(item.item_name) + '</span>' +
        '<div class="history-card__meta">' +
          '<span class="history-card__location">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
              '<path d="M12 21s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11z" stroke="currentColor" stroke-width="1.75"/>' +
              '<circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="1.75"/>' +
            '</svg>' +
            escapeHtml(item.location_name) +
          '</span>' +
          '<span class="history-card__time" data-timestamp="' + item.created_at + '">' +
            formatRelativeTime(item.created_at) +
          '</span>' +
        '</div>' +
      '</div>' +
      '<button class="history-card__delete" type="button" aria-label="Delete ' + escapeHtml(item.item_name) + '">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
          '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>' +
        '</svg>' +
      '</button>';

    const content = card.querySelector('.history-card__content');
    content.addEventListener('click', function onContentClick() {
      copyLocationToClipboard(item, card);
    });

    const deleteBtn = card.querySelector('.history-card__delete');
    deleteBtn.addEventListener('click', function onDeleteClick(event) {
      event.stopPropagation();
      handleDeleteItem(item.id, wrapper);
    });

    bindSwipeOnCard(wrapper, card, item);

    wrapper.appendChild(deleteBg);
    wrapper.appendChild(card);
    return wrapper;
  }

  function updateHistoryCount() {
    const count = allItems.length;
    dom.historyCount.textContent = count === 1 ? '1 item' : count + ' items';
  }

  function prependHistoryItem(item) {
    dom.historyList.classList.remove('history-list--hidden');
    dom.historyEmpty.classList.add('history-empty--hidden');
    const card = createHistoryCardElement(item);
    dom.historyList.insertBefore(card, dom.historyList.firstChild);
    updateHistoryCount();
    updateHistoryStats();
  }

  function renderHistoryList() {
    dom.historyList.innerHTML = '';

    if (allItems.length === 0) {
      dom.historyList.classList.add('history-list--hidden');
      dom.historyEmpty.classList.remove('history-empty--hidden');
      updateHistoryCount();
      updateHistoryStats();
      return;
    }

    dom.historyList.classList.remove('history-list--hidden');
    dom.historyEmpty.classList.add('history-empty--hidden');

    let renderIndex = 0;
    while (renderIndex < allItems.length) {
      dom.historyList.appendChild(createHistoryCardElement(allItems[renderIndex]));
      renderIndex = renderIndex + 1;
    }

    updateHistoryCount();
    updateHistoryStats();
  }

  function refreshRelativeTimes() {
    const timeElements = document.querySelectorAll('.history-card__time[data-timestamp]');
    let elementIndex = 0;
    while (elementIndex < timeElements.length) {
      const el = timeElements[elementIndex];
      const timestamp = parseInt(el.getAttribute('data-timestamp'), 10);
      if (!isNaN(timestamp)) {
        el.textContent = formatRelativeTime(timestamp);
      }
      elementIndex = elementIndex + 1;
    }
  }

  async function restoreDeletedItem() {
    if (!undoDeleteSnapshot) {
      return;
    }

    const snapshot = undoDeleteSnapshot;
    undoDeleteSnapshot = null;

    if (undoDeleteTimeoutId) {
      clearTimeout(undoDeleteTimeoutId);
      undoDeleteTimeoutId = null;
    }

    try {
      const restored = await addItemToDB({
        item_name: snapshot.item_name,
        location_name: snapshot.location_name,
        raw_text: snapshot.raw_text,
        created_at: snapshot.created_at
      });
      allItems.unshift(restored);
      allItems.sort(function onSort(a, b) {
        return b.created_at - a.created_at;
      });
      renderHistoryList();
      showToast('Restored: ' + restored.item_name, 'success');
    } catch (error) {
      showToast('Could not undo delete', 'error');
    }
  }

  async function handleDeleteItem(id, cardElement) {
    const deletedItem = allItems.find(function onFind(item) {
      return item.id === id;
    });

    if (!deletedItem) {
      return;
    }

    const target = cardElement.classList.contains('history-card-wrapper')
      ? cardElement
      : cardElement.closest('.history-card-wrapper') || cardElement;

    target.classList.add('history-card-wrapper--removing');

    setTimeout(async function onRemoveAnimationComplete() {
      try {
        await deleteItemFromDB(id);
        allItems = allItems.filter(function onFilter(item) {
          return item.id !== id;
        });
        renderHistoryList();

        undoDeleteSnapshot = {
          item_name: deletedItem.item_name,
          location_name: deletedItem.location_name,
          raw_text: deletedItem.raw_text,
          created_at: deletedItem.created_at
        };

        if (undoDeleteTimeoutId) {
          clearTimeout(undoDeleteTimeoutId);
        }

        undoDeleteTimeoutId = setTimeout(function onUndoExpire() {
          undoDeleteSnapshot = null;
          undoDeleteTimeoutId = null;
        }, 5000);

        showToast('Removed ' + deletedItem.item_name, 'success', 'Undo', restoreDeletedItem);
        triggerHaptic(30);
      } catch (error) {
        target.classList.remove('history-card-wrapper--removing');
        showToast('Failed to delete item', 'error');
      }
    }, 300);
  }

  async function saveParsedItem(rawText) {
    const parsed = parseStashInput(rawText);

    if (!parsed) {
      setEngineState('error');
      showToast('Nothing to save — try speaking again', 'error');
      setTimeout(function onResetState() {
        setEngineState('ready');
      }, 2000);
      return null;
    }

    setEngineState('processing');

    try {
      const savedItem = await addItemToDB(parsed);
      allItems.unshift(savedItem);
      prependHistoryItem(savedItem);
      setEngineState('saved');
      dom.parsePreview.classList.add('parse-preview--hidden');
      showToast('Stashed: ' + savedItem.item_name + ' → ' + savedItem.location_name, 'success');

      setTimeout(function onSavedReset() {
        setEngineState('ready');
        finalTranscriptBuffer = '';
        renderTranscriptWords([], []);
      }, 1800);

      return savedItem;
    } catch (error) {
      setEngineState('error');
      showToast('Failed to save item', 'error');
      setTimeout(function onErrorReset() {
        setEngineState('ready');
      }, 2000);
      return null;
    }
  }

  function getSearchMatches(query) {
    const trimmedQuery = query.trim().toLowerCase();
    if (trimmedQuery.length === 0) {
      return [];
    }

    return allItems.filter(function onFilter(item) {
      return (
        item.item_name.toLowerCase().indexOf(trimmedQuery) !== -1 ||
        item.location_name.toLowerCase().indexOf(trimmedQuery) !== -1 ||
        (item.raw_text && item.raw_text.toLowerCase().indexOf(trimmedQuery) !== -1)
      );
    });
  }

  function scrollToHistoryItem(itemId) {
    const card = dom.historyList.querySelector('[data-id="' + itemId + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('history-card--copied');
      setTimeout(function onHighlightEnd() {
        card.classList.remove('history-card--copied');
      }, 1500);
    }
  }

  function renderSearchResults(query) {
    const trimmedQuery = query.trim().toLowerCase();

    if (trimmedQuery.length === 0) {
      dom.searchResults.classList.add('search-results--hidden');
      dom.searchResults.innerHTML = '';
      dom.searchInput.setAttribute('aria-expanded', 'false');
      searchActiveIndex = -1;
      return;
    }

    const matchedItems = getSearchMatches(query);

    dom.searchResults.innerHTML = '';
    dom.searchInput.setAttribute('aria-expanded', 'true');

    if (matchedItems.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'search-results__empty';
      emptyEl.textContent = 'No matches found';
      dom.searchResults.appendChild(emptyEl);
      dom.searchResults.classList.remove('search-results--hidden');
      searchActiveIndex = -1;
      return;
    }

    if (searchActiveIndex >= matchedItems.length) {
      searchActiveIndex = matchedItems.length - 1;
    }

    let resultIndex = 0;
    while (resultIndex < matchedItems.length) {
      const item = matchedItems[resultIndex];
      const resultEl = document.createElement('div');
      resultEl.className = 'search-result-item';
      if (resultIndex === searchActiveIndex) {
        resultEl.classList.add('search-result-item--active');
      }
      resultEl.setAttribute('role', 'option');
      resultEl.dataset.itemId = String(item.id);
      resultEl.innerHTML =
        '<span class="search-result-item__item">' + highlightMatch(item.item_name, query) + '</span>' +
        '<span class="search-result-item__location">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path d="M12 21s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
          '</svg>' +
          highlightMatch(item.location_name, query) +
        '</span>' +
        '<span class="search-result-item__time">' + formatRelativeTime(item.created_at) + '</span>';

      resultEl.addEventListener('click', function onResultClick() {
        dom.searchInput.value = item.item_name;
        dom.searchClear.classList.remove('search-bar__clear--hidden');
        dom.searchResults.classList.add('search-results--hidden');
        scrollToHistoryItem(item.id);
      });

      dom.searchResults.appendChild(resultEl);
      resultIndex = resultIndex + 1;
    }

    dom.searchResults.classList.remove('search-results--hidden');

    if (searchActiveIndex >= 0) {
      const activeEl = dom.searchResults.children[searchActiveIndex];
      if (activeEl && activeEl.scrollIntoView) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function initTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');
    dom.html.setAttribute('data-theme', theme);
    updateThemeColorMeta(theme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function onSchemeChange(event) {
      if (!localStorage.getItem(THEME_STORAGE_KEY)) {
        const autoTheme = event.matches ? 'dark' : 'light';
        dom.html.setAttribute('data-theme', autoTheme);
        updateThemeColorMeta(autoTheme);
      }
    });
  }

  function updateThemeColorMeta(theme) {
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#09090b' : '#ffffff');
    }
  }

  function toggleTheme() {
    const currentTheme = dom.html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    dom.html.setAttribute('data-theme', newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    updateThemeColorMeta(newTheme);
  }

  async function requestStoragePersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        const isPersisted = await navigator.storage.persist();
        if (isPersisted) {
          dom.persistenceBadge.classList.remove('persistence-badge--hidden');
        }
      } catch (error) {
        /* persistence request failed silently — app still functional */
      }
    }
  }

  function showManualOverlay() {
    dom.manualOverlay.classList.remove('manual-overlay--hidden');
    dom.manualInput.value = '';
    dom.manualInput.focus();
    usingFallbackEngine = true;
    dom.engineLabel.textContent = 'Manual Text Engine';
  }

  function hideManualOverlay() {
    dom.manualOverlay.classList.add('manual-overlay--hidden');
    if (speechSupported) {
      usingFallbackEngine = false;
      dom.engineLabel.textContent = 'Native Speech Engine';
    }
  }

  function initSpeechRecognition() {
    const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      speechSupported = false;
      usingFallbackEngine = true;
      dom.engineLabel.textContent = 'Manual Text Engine';
      return false;
    }

    try {
      recognition = new SpeechRecognitionConstructor();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.maxAlternatives = 1;

      recognition.onstart = function onRecognitionStart() {
        isRecording = true;
        finalTranscriptBuffer = '';
        dom.recordButton.classList.add('record-button--active');
        dom.recordButton.setAttribute('aria-pressed', 'true');
        dom.recordButton.setAttribute('aria-label', 'Stop voice recording');
        dom.recordRipple.classList.add('record-ripple--active');
        setEngineState('listening');
        setListeningVisuals(true);
        triggerHaptic(50);
      };

      recognition.onresult = function onRecognitionResult(event) {
        let interimTranscript = '';
        let resultIndex = 0;

        while (resultIndex < event.results.length) {
          const result = event.results[resultIndex];
          if (result.isFinal) {
            finalTranscriptBuffer = finalTranscriptBuffer + result[0].transcript;
          } else {
            interimTranscript = interimTranscript + result[0].transcript;
          }
          resultIndex = resultIndex + 1;
        }

        const finalWords = finalTranscriptBuffer.trim().split(/\s+/).filter(function onFilter(w) {
          return w.length > 0;
        });
        const interimWords = interimTranscript.trim().split(/\s+/).filter(function onFilter(w) {
          return w.length > 0;
        });

        renderTranscriptWords(finalWords, interimWords);
      };

      recognition.onend = function onRecognitionEnd() {
        isRecording = false;
        dom.recordButton.classList.remove('record-button--active');
        dom.recordButton.setAttribute('aria-pressed', 'false');
        dom.recordButton.setAttribute('aria-label', 'Start voice recording');
        dom.recordRipple.classList.remove('record-ripple--active');
        setListeningVisuals(false);
        triggerHaptic(50);

        const textToSave = finalTranscriptBuffer.trim();
        if (textToSave.length > 0) {
          saveParsedItem(textToSave);
        } else {
          setEngineState('ready');
        }
      };

      recognition.onerror = function onRecognitionError(event) {
        isRecording = false;
        dom.recordButton.classList.remove('record-button--active');
        dom.recordButton.setAttribute('aria-pressed', 'false');
        dom.recordRipple.classList.remove('record-ripple--active');
        setListeningVisuals(false);

        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setEngineState('error');
          showToast('Microphone access denied — switching to manual entry', 'error');
          showManualOverlay();
        } else if (event.error === 'network') {
          setEngineState('error');
          showToast('Network unavailable — switching to manual entry', 'error');
          showManualOverlay();
        } else if (event.error === 'no-speech') {
          setEngineState('ready');
          showToast('No speech detected — try again', 'error');
        } else if (event.error === 'aborted') {
          setEngineState('ready');
        } else {
          setEngineState('error');
          showToast('Speech error — try manual entry', 'error');
          showManualOverlay();
        }
      };

      speechSupported = true;
      usingFallbackEngine = false;
      dom.engineLabel.textContent = 'Native Speech Engine';
      return true;
    } catch (error) {
      speechSupported = false;
      usingFallbackEngine = true;
      dom.engineLabel.textContent = 'Manual Text Engine';
      return false;
    }
  }

  function beginRecording() {
    if (usingFallbackEngine || !speechSupported) {
      showManualOverlay();
      return false;
    }

    if (isRecording) {
      return true;
    }

    try {
      recognition.start();
      return true;
    } catch (error) {
      if (error.name !== 'InvalidStateError') {
        showToast('Could not start microphone — use manual entry', 'error');
        showManualOverlay();
      }
      return false;
    }
  }

  function startRecording() {
    if (usingFallbackEngine || !speechSupported) {
      showManualOverlay();
      return;
    }

    if (isRecording) {
      stopRecording();
      return;
    }

    beginRecording();
  }

  function stopRecording() {
    if (recognition && isRecording) {
      try {
        recognition.stop();
      } catch (error) {
        isRecording = false;
        dom.recordButton.classList.remove('record-button--active');
        dom.recordRipple.classList.remove('record-ripple--active');
        setListeningVisuals(false);
        setEngineState('ready');
      }
    }
  }

  let holdRecordTimerId = null;

  function onRecordPointerDown(event) {
    if (usingFallbackEngine || !speechSupported) {
      return;
    }

    holdRecordPointerId = event.pointerId;
    holdRecordStartTime = Date.now();
    holdRecordActive = false;
    dom.recordButton.setPointerCapture(event.pointerId);

    holdRecordTimerId = setTimeout(function onHoldDelay() {
      if (holdRecordPointerId === event.pointerId && !isRecording) {
        holdRecordActive = true;
        beginRecording();
      }
    }, 180);
  }

  function onRecordPointerUp(event) {
    if (holdRecordPointerId !== event.pointerId) {
      return;
    }

    if (holdRecordTimerId) {
      clearTimeout(holdRecordTimerId);
      holdRecordTimerId = null;
    }

    const pressDuration = Date.now() - holdRecordStartTime;
    holdRecordPointerId = null;

    if (holdRecordActive && isRecording) {
      suppressClickToggle = true;
      stopRecording();
      holdRecordActive = false;
    } else if (pressDuration >= 180 && isRecording) {
      suppressClickToggle = true;
      stopRecording();
    }
  }

  function onRecordClick() {
    if (suppressClickToggle) {
      suppressClickToggle = false;
      return;
    }
    startRecording();
  }

  function initPWAInstall() {
    window.addEventListener('beforeinstallprompt', function onInstallPrompt(event) {
      event.preventDefault();
      deferredInstallPrompt = event;
      dom.installButton.classList.remove('install-button--hidden');
    });

    dom.installButton.addEventListener('click', async function onInstallClick() {
      if (!deferredInstallPrompt) {
        return;
      }
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        showToast('Vault installed — enjoy!', 'success');
      }
      deferredInstallPrompt = null;
      dom.installButton.classList.add('install-button--hidden');
    });

    window.addEventListener('appinstalled', function onAppInstalled() {
      deferredInstallPrompt = null;
      dom.installButton.classList.add('install-button--hidden');
    });
  }

  async function handleBackup() {
    try {
      const items = await getAllItemsFromDB();
      const exportData = {
        app: 'The Where Did I Put It Vault',
        version: 1,
        exported_at: new Date().toISOString(),
        items: items
      };
      const jsonString = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const dateStamp = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = 'vault-backup-' + dateStamp + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      showToast('Backup downloaded (' + items.length + ' items)', 'success');
    } catch (error) {
      showToast('Backup failed', 'error');
    }
  }

  async function handleImport(file) {
    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = async function onFileLoad(event) {
      try {
        const parsed = JSON.parse(event.target.result);
        let itemsToImport = [];

        if (Array.isArray(parsed)) {
          itemsToImport = parsed;
        } else if (parsed && Array.isArray(parsed.items)) {
          itemsToImport = parsed.items;
        } else {
          showToast('Invalid backup file format', 'error');
          return;
        }

        const validatedItems = [];
        let validateIndex = 0;
        while (validateIndex < itemsToImport.length) {
          const entry = itemsToImport[validateIndex];
          if (entry && typeof entry.item_name === 'string' && typeof entry.location_name === 'string') {
            validatedItems.push({
              item_name: entry.item_name,
              location_name: entry.location_name,
              raw_text: entry.raw_text || '',
              created_at: entry.created_at || Date.now()
            });
          }
          validateIndex = validateIndex + 1;
        }

        if (validatedItems.length === 0) {
          showToast('No valid items found in file', 'error');
          return;
        }

        const confirmReplace = allItems.length === 0 || window.confirm(
          'Import ' + validatedItems.length + ' items? This will replace your current ' + allItems.length + ' stashed items.'
        );

        if (!confirmReplace) {
          dom.importInput.value = '';
          return;
        }

        await clearAllItemsFromDB();
        await bulkInsertItems(validatedItems);
        allItems = await getAllItemsFromDB();
        renderHistoryList();
        showToast('Imported ' + validatedItems.length + ' items successfully', 'success');
      } catch (error) {
        showToast('Import failed — invalid JSON file', 'error');
      }

      dom.importInput.value = '';
    };

    reader.onerror = function onFileError() {
      showToast('Could not read file', 'error');
      dom.importInput.value = '';
    };

    reader.readAsText(file);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function onLoad() {
        navigator.serviceWorker.register('/service-worker.js').then(function onRegistered(registration) {
          registration.update();
        }).catch(function onRegisterError() {
          /* service worker registration failed — app still works online */
        });
      });
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function onLoad() {
        navigator.serviceWorker.register('./service-worker.js', { scope: './' }).then(function onRegistered(registration) {
          registration.update();
        }).catch(function onRegisterError() {
          /* service worker registration failed — app still works online */
        });
      });
    }
  }

  function handleExampleChip(exampleText) {
    if (speechSupported && !usingFallbackEngine) {
      renderTranscriptWords(exampleText.split(/\s+/), []);
      updateParsePreview(exampleText);
      saveParsedItem(exampleText);
    } else {
      dom.manualInput.value = exampleText;
      showManualOverlay();
    }
  }

  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', function onKeydown(event) {
      const tag = event.target.tagName.toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea';

      if (event.key === 'Escape') {
        if (!dom.manualOverlay.classList.contains('manual-overlay--hidden')) {
          hideManualOverlay();
          event.preventDefault();
        }
        dom.searchResults.classList.add('search-results--hidden');
        return;
      }

      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        dom.searchInput.focus();
        return;
      }

      if (event.key === ' ' && !isTyping && dom.manualOverlay.classList.contains('manual-overlay--hidden')) {
        event.preventDefault();
        startRecording();
        return;
      }

      if (dom.searchInput === document.activeElement && !dom.searchResults.classList.contains('search-results--hidden')) {
        const matches = getSearchMatches(dom.searchInput.value);
        if (matches.length === 0) {
          return;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          searchActiveIndex = Math.min(searchActiveIndex + 1, matches.length - 1);
          renderSearchResults(dom.searchInput.value);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          searchActiveIndex = Math.max(searchActiveIndex - 1, 0);
          renderSearchResults(dom.searchInput.value);
        } else if (event.key === 'Enter' && searchActiveIndex >= 0) {
          event.preventDefault();
          const selected = matches[searchActiveIndex];
          dom.searchInput.value = selected.item_name;
          dom.searchResults.classList.add('search-results--hidden');
          scrollToHistoryItem(selected.id);
        }
      }
    });
  }

  function bindEvents() {
    dom.themeToggle.addEventListener('click', toggleTheme);

    dom.searchInput.addEventListener('input', function onSearchInput() {
      const value = dom.searchInput.value;
      searchActiveIndex = -1;
      if (value.length > 0) {
        dom.searchClear.classList.remove('search-bar__clear--hidden');
      } else {
        dom.searchClear.classList.add('search-bar__clear--hidden');
      }
      renderSearchResults(value);
    });

    dom.searchClear.addEventListener('click', function onSearchClear() {
      dom.searchInput.value = '';
      dom.searchClear.classList.add('search-bar__clear--hidden');
      searchActiveIndex = -1;
      renderSearchResults('');
      dom.searchInput.focus();
    });

    document.addEventListener('click', function onDocumentClick(event) {
      if (!event.target.closest('.search-module')) {
        dom.searchResults.classList.add('search-results--hidden');
        dom.searchInput.setAttribute('aria-expanded', 'false');
      }
    });

    dom.recordButton.addEventListener('click', onRecordClick);
    dom.recordButton.addEventListener('pointerdown', onRecordPointerDown);
    dom.recordButton.addEventListener('pointerup', onRecordPointerUp);
    dom.recordButton.addEventListener('pointercancel', onRecordPointerUp);

    dom.manualEntryButton.addEventListener('click', showManualOverlay);

    dom.backupButton.addEventListener('click', handleBackup);

    dom.importInput.addEventListener('change', function onImportChange() {
      if (dom.importInput.files && dom.importInput.files.length > 0) {
        handleImport(dom.importInput.files[0]);
      }
    });

    dom.manualSubmit.addEventListener('click', async function onManualSubmit() {
      const text = dom.manualInput.value.trim();
      if (text.length === 0) {
        showToast('Please enter where you put something', 'error');
        return;
      }
      hideManualOverlay();
      renderTranscriptWords(text.split(/\s+/), []);
      updateParsePreview(text);
      await saveParsedItem(text);
    });

    dom.manualOverlayClose.addEventListener('click', hideManualOverlay);

    dom.manualOverlay.querySelector('.manual-overlay__backdrop').addEventListener('click', hideManualOverlay);

    dom.manualInput.addEventListener('input', function onManualInput() {
      updateParsePreview(dom.manualInput.value);
    });

    dom.manualInput.addEventListener('keydown', function onManualKeydown(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        dom.manualSubmit.click();
      }
    });

    const exampleChips = document.querySelectorAll('.example-chip');
    let chipIndex = 0;
    while (chipIndex < exampleChips.length) {
      exampleChips[chipIndex].addEventListener('click', function onChipClick() {
        handleExampleChip(this.getAttribute('data-example'));
      });
      chipIndex = chipIndex + 1;
    }

    bindKeyboardShortcuts();
  }

  async function init() {
    initTheme();
    initPWAInstall();
    bindEvents();
    registerServiceWorker();
    await requestStoragePersistence();

    try {
      await openDatabase();
      allItems = await getAllItemsFromDB();
      renderHistoryList();
    } catch (error) {
      showToast('Database initialization failed', 'error');
    }

    initSpeechRecognition();

    relativeTimeIntervalId = setInterval(refreshRelativeTimes, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
