// storage.js — Unified local data reading and writing layer
// All document/folder/highlight data is accessed through this module
// Data is split and stored in chrome.storage.local using multiple keys to avoid serializing large objects

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const Storage = (() => {
  // In-memory cache: folder tree + document metadata (excluding body content)
  let _folders = {};   // { folderId: FolderObj }
  let _docs = {};      // { docId: DocMetaObj }

  // ====== Utility Functions ======
  function generateId(prefix = '') {
    return prefix + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  // ====== Initialization: load metadata from local storage into memory cache ======
  async function init() {
    const data = await browserAPI.storage.local.get(['mdm_folders', 'mdm_docs']);
    _folders = data.mdm_folders || {};
    _docs = data.mdm_docs || {};
  }

  // ====== Folder Operations ======
  function getFolders() {
    return { ..._folders };
  }

  async function createFolder(name, parentId = null) {
    const id = generateId('f_');
    const folder = {
      id,
      name,
      parentId,
      order: Date.now(),
      createdAt: Date.now()
    };
    _folders[id] = folder;
    await browserAPI.storage.local.set({ mdm_folders: _folders });
    return folder;
  }

  async function renameFolder(id, newName) {
    if (!_folders[id]) return;
    _folders[id].name = newName;
    await browserAPI.storage.local.set({ mdm_folders: _folders });
  }

  async function deleteFolder(id) {
    if (!_folders[id]) return;

    // Hoist subfolders and subdocuments to the parent of the deleted folder
    const parentId = _folders[id].parentId;
    Object.values(_folders).forEach(f => {
      if (f.parentId === id) f.parentId = parentId;
    });
    Object.values(_docs).forEach(d => {
      if (d.folderId === id) d.folderId = parentId;
    });

    delete _folders[id];
    await browserAPI.storage.local.set({ mdm_folders: _folders, mdm_docs: _docs });
  }

  // ====== Document Metadata Operations ======
  function getDocMeta() {
    return { ..._docs };
  }

  async function getDocContent(id) {
    const key = `mdm_content_${id}`;
    const data = await browserAPI.storage.local.get(key);
    return data[key] || '';
  }

  async function createDoc(title, content = '', folderId = null) {
    const id = generateId('d_');
    const now = Date.now();
    const meta = {
      id,
      title,
      folderId,
      isBookmarked: false,
      createdAt: now,
      updatedAt: now
    };
    _docs[id] = meta;
    await browserAPI.storage.local.set({
      mdm_docs: _docs,
      [`mdm_content_${id}`]: content
    });
    return meta;
  }

  async function updateDocContent(id, content) {
    if (!_docs[id]) return;
    _docs[id].updatedAt = Date.now();
    await browserAPI.storage.local.set({
      mdm_docs: _docs,
      [`mdm_content_${id}`]: content
    });
  }

  async function updateDocMeta(id, changes) {
    if (!_docs[id]) return;
    Object.assign(_docs[id], changes, { updatedAt: Date.now() });
    await browserAPI.storage.local.set({ mdm_docs: _docs });
  }

  async function deleteDoc(id) {
    if (!_docs[id]) return;
    delete _docs[id];
    await browserAPI.storage.local.set({ mdm_docs: _docs });
    try {
      await browserAPI.storage.local.remove([`mdm_content_${id}`, `mdm_hl_${id}`]);
    } catch (e) {
      console.warn('Storage cleanup non-critical error:', e);
    }
  }

  async function toggleBookmark(id) {
    if (!_docs[id]) return false;
    _docs[id].isBookmarked = !_docs[id].isBookmarked;
    _docs[id].updatedAt = Date.now();
    await browserAPI.storage.local.set({ mdm_docs: _docs });
    return _docs[id].isBookmarked;
  }

  // ====== Highlight Operations ======
  async function getHighlights(docId) {
    const key = `mdm_hl_${docId}`;
    const data = await browserAPI.storage.local.get(key);
    return data[key] || [];
  }

  async function addHighlight(docId, highlight) {
    const highlights = await getHighlights(docId);
    highlight.id = generateId('hl_');
    highlights.push(highlight);
    await browserAPI.storage.local.set({ [`mdm_hl_${docId}`]: highlights });
    return highlight;
  }

  async function removeHighlight(docId, highlightId) {
    let highlights = await getHighlights(docId);
    highlights = highlights.filter(h => h.id !== highlightId);
    await browserAPI.storage.local.set({ [`mdm_hl_${docId}`]: highlights });
  }

  // ====== Global Search ======
  async function searchDocs(query) {
    if (!query || !query.trim()) return [];
    const q = query.toLowerCase().trim();
    const results = [];

    for (const doc of Object.values(_docs)) {
      let score = 0;

      // Title matches have higher weight
      if (doc.title.toLowerCase().includes(q)) score += 10;

      // Body content match
      const content = await getDocContent(doc.id);
      if (content.toLowerCase().includes(q)) score += 5;

      if (score > 0) {
        results.push({
          ...doc,
          score,
          snippet: _extractSnippet(content, q)
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  function _extractSnippet(content, query) {
    const idx = content.toLowerCase().indexOf(query);
    if (idx === -1) return content.substring(0, 80) + (content.length > 80 ? '...' : '');
    const start = Math.max(0, idx - 30);
    const end = Math.min(content.length, idx + query.length + 50);
    return (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
  }

  // ====== Asset Pool Operations ======
  async function saveAsset(base64Data, extension = 'png') {
    const assetId = generateId('asset_') + '.' + extension;
    const key = `mdm_asset_${assetId}`;
    await browserAPI.storage.local.set({ [key]: base64Data });
    return `local://${assetId}`;
  }

  async function getAsset(assetId) {
    const key = `mdm_asset_${assetId}`;
    const data = await browserAPI.storage.local.get(key);
    return data[key] || null;
  }

  // ====== Public API ======
  return {
    init,
    generateId,
    // Folders
    getFolders, createFolder, renameFolder, deleteFolder,
    // Documents
    getDocMeta, getDocContent, createDoc, updateDocContent, updateDocMeta, deleteDoc, toggleBookmark,
    // Highlights
    getHighlights, addHighlight, removeHighlight,
    // Search
    searchDocs,
    // Assets
    saveAsset, getAsset
  };
})();


// folder-tree.js — Sidebar nested folder and document tree component
// Responsible for rendering the sidebar document directory tree and bookmark list, supporting tree node collapse, and CRUD interactions

const FolderTree = (() => {
  let _collapsedFolders = new Set(JSON.parse(localStorage.getItem('mdm_collapsed_folders') || '[]'));
  let _activeDocId = null;
  let _onSelectDocCallback = null;

  // Initialize, passing in the callback function for clicking and selecting a document
  function init(onSelectDoc) {
    _onSelectDocCallback = onSelectDoc;
    render();
  }

  // Persistently save the folder collapsed state
  function saveCollapsed() {
    localStorage.setItem('mdm_collapsed_folders', JSON.stringify([..._collapsedFolders]));
  }

  // Render the entire folder tree
  function render() {
    const treeContainer = document.getElementById('folderTree');
    if (!treeContainer) return;
    treeContainer.textContent = '';

    const folders = Storage.getFolders();
    const docs = Storage.getDocMeta();

    // Establish tree-level mapping structure
    // foldersByParent: { parentId/root: [folderObj, ...] }
    // docsByFolder: { folderId/root: [docObj, ...] }
    const foldersByParent = {};
    const docsByFolder = {};

    Object.values(folders).forEach(f => {
      const pid = f.parentId || 'root';
      if (!foldersByParent[pid]) foldersByParent[pid] = [];
      foldersByParent[pid].push(f);
    });

    Object.values(docs).forEach(d => {
      const fid = d.folderId || 'root';
      if (!docsByFolder[fid]) docsByFolder[fid] = [];
      docsByFolder[fid].push(d);
    });

    // Sort folders and documents alphabetically to ensure stable rendering
    const sortByName = (a, b) => a.name.localeCompare(b.name, 'en-US');
    const sortByTitle = (a, b) => a.title.localeCompare(b.title, 'en-US');

    Object.keys(foldersByParent).forEach(k => foldersByParent[k].sort(sortByName));
    Object.keys(docsByFolder).forEach(k => docsByFolder[k].sort(sortByTitle));

    // Recursively build tree DOM nodes
    function buildTreeHTML(parentId) {
      const container = document.createElement('div');
      container.className = 'folder-children-container';

      // 1. First render all folders under the current level
      const childFolders = foldersByParent[parentId] || [];
      childFolders.forEach(folder => {
        const folderEl = document.createElement('div');
        folderEl.className = 'folder-item';
        folderEl.dataset.folderId = folder.id;

        const isCollapsed = _collapsedFolders.has(folder.id);

        // Folder header
        const header = document.createElement('div');
        header.className = 'folder-header';
        
        // Collapse arrow symbol
        const toggle = document.createElement('span');
        toggle.className = 'folder-toggle';
        toggle.textContent = isCollapsed ? '▸' : '▾';

        // Folder icon
        const icon = document.createElement('span');
        icon.className = 'folder-icon';
        icon.textContent = isCollapsed ? '' : '';

        // Folder name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'folder-name';
        nameSpan.textContent = folder.name;

        // Action buttons container
        const actions = document.createElement('div');
        actions.className = 'folder-actions';

        // New document button
        const addDoc = document.createElement('button');
        addDoc.className = 'icon-btn';
        addDoc.title = 'New document';
        addDoc.textContent = '+Doc';
        addDoc.addEventListener('click', async (e) => {
          e.stopPropagation();
          const title = prompt(`Create a new document in folder "${folder.name}", please enter the title:`);
          if (title && title.trim()) {
            const doc = await Storage.createDoc(title.trim(), '', folder.id);
            _collapsedFolders.delete(folder.id);
            saveCollapsed();
            render();
            if (_onSelectDocCallback) _onSelectDocCallback(doc.id);
          }
        });

        // New subfolder button
        const addFolder = document.createElement('button');
        addFolder.className = 'icon-btn';
        addFolder.title = 'New subfolder';
        addFolder.textContent = '+Dir';
        addFolder.addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = prompt(`Create a new subfolder in folder "${folder.name}", please enter the name:`);
          if (name && name.trim()) {
            await Storage.createFolder(name.trim(), folder.id);
            _collapsedFolders.delete(folder.id);
            saveCollapsed();
            render();
          }
        });

        // Rename folder on double click
        header.addEventListener('dblclick', async (e) => {
          e.stopPropagation();
          const newName = prompt('Rename folder to:', folder.name);
          if (newName && newName.trim() && newName.trim() !== folder.name) {
            await Storage.renameFolder(folder.id, newName.trim());
            render();
          }
        });

        // Delete folder button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'icon-btn';
        deleteBtn.title = 'Delete folder';
        deleteBtn.textContent = 'Del';
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Are you sure you want to delete the folder "${folder.name}"?\nAfter deletion, its files and subfolders will be safely hoisted to the parent directory.`)) {
            try {
              await Storage.deleteFolder(folder.id);
              _collapsedFolders.delete(folder.id);
              saveCollapsed();
              render();
            } catch (err) {
              console.error('Failed to delete folder', err);
              alert('Delete failed: ' + err.message);
            }
          }
        });

        actions.appendChild(addDoc);
        actions.appendChild(addFolder);
        actions.appendChild(deleteBtn);

        header.appendChild(toggle);
        header.appendChild(icon);
        header.appendChild(nameSpan);
        header.appendChild(actions);

        // Click folder header to expand/collapse
        header.addEventListener('click', (e) => {
          if (e.target.closest('.icon-btn')) return;
          if (_collapsedFolders.has(folder.id)) {
            _collapsedFolders.delete(folder.id);
            toggle.textContent = '▾';
            icon.textContent = '';
            childrenDiv.style.display = 'block';
          } else {
            _collapsedFolders.add(folder.id);
            toggle.textContent = '▸';
            icon.textContent = '';
            childrenDiv.style.display = 'none';
          }
          saveCollapsed();
        });

        folderEl.appendChild(header);

        // Folder children node container
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'folder-children';
        childrenDiv.style.display = isCollapsed ? 'none' : 'block';

        const subTree = buildTreeHTML(folder.id);
        if (subTree) childrenDiv.appendChild(subTree);

        folderEl.appendChild(childrenDiv);
        container.appendChild(folderEl);
      });

      // 2. Render all documents under the current level
      const childDocs = docsByFolder[parentId] || [];
      childDocs.forEach(doc => {
        const docEl = document.createElement('div');
        docEl.className = 'doc-item';
        if (doc.id === _activeDocId) docEl.classList.add('active');
        docEl.dataset.docId = doc.id;

        const icon = document.createElement('span');
        icon.className = 'doc-icon';
        icon.textContent = '';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'doc-title';
        titleSpan.textContent = doc.title;

        // Document hover action buttons
        const actions = document.createElement('div');
        actions.className = 'doc-actions';
        actions.style.display = 'none';
        actions.style.gap = '2px';
        actions.style.marginLeft = 'auto';



        // Delete document button
        const deleteDoc = document.createElement('button');
        deleteDoc.className = 'icon-btn';
        deleteDoc.title = 'Delete document';
        deleteDoc.textContent = 'Del';
        deleteDoc.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Are you sure you want to delete the document "${doc.title}"? This operation cannot be undone.`)) {
            try {
              await Storage.deleteDoc(doc.id);
              render();
              // If the deleted document is the currently opened one, switch back to blank state
              if (_activeDocId === doc.id && _onSelectDocCallback) {
                _onSelectDocCallback(null);
              }
            } catch (err) {
              console.error('Failed to delete document', err);
              alert('Delete failed: ' + err.message);
            }
          }
        });

        actions.appendChild(deleteDoc);

        docEl.appendChild(icon);
        docEl.appendChild(titleSpan);
        docEl.appendChild(actions);

        // Hover to show/hide action bar
        docEl.addEventListener('mouseenter', () => { actions.style.display = 'flex'; });
        docEl.addEventListener('mouseleave', () => { actions.style.display = 'none'; });

        // Click to open document, click again to rename
        docEl.addEventListener('click', (e) => {
          if (e.target.closest('.icon-btn')) return;
          const isAlreadyActive = docEl.classList.contains('active');

          _activeDocId = doc.id;
          document.querySelectorAll('.doc-item').forEach(el => el.classList.remove('active'));
          docEl.classList.add('active');
          if (_onSelectDocCallback) _onSelectDocCallback(doc.id);

          if (isAlreadyActive) {
            const newTitle = prompt('Rename document to:', doc.title);
            if (newTitle && newTitle.trim() && newTitle.trim() !== doc.title) {
              Storage.updateDocMeta(doc.id, { title: newTitle.trim() }).then(() => {
                render();
                const docTitleInput = document.getElementById('docTitleInput');
                if (_activeDocId === doc.id && docTitleInput) {
                  docTitleInput.value = newTitle.trim();
                }
              });
            }
          }
        });

        container.appendChild(docEl);
      });

      return container.children.length > 0 ? container : null;
    }

    const treeHTML = buildTreeHTML('root');
    if (treeHTML) {
      treeContainer.appendChild(treeHTML);
    } else {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No folders or documents yet. Click "+ Document" above to create a new note.';
      treeContainer.appendChild(hint);
    }

    // Re-render bookmark list
    renderBookmarks();
  }

  // Render quick bookmark list
  function renderBookmarks() {
    const listContainer = document.getElementById('bookmarkList');
    if (!listContainer) return;
    listContainer.textContent = '';

    const docs = Storage.getDocMeta();
    const bookmarks = Object.values(docs).filter(d => d.isBookmarked);

    if (bookmarks.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No bookmarks yet. Click Bookmark while editing to quickly add to favorites.';
      listContainer.appendChild(hint);
      return;
    }

    // Sort by update time, newest first
    bookmarks.sort((a, b) => b.updatedAt - a.updatedAt).forEach(doc => {
      const docEl = document.createElement('div');
      docEl.className = 'doc-item';
      if (doc.id === _activeDocId) docEl.classList.add('active');

      const icon = document.createElement('span');
      icon.className = 'doc-icon';
      icon.textContent = '';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'doc-title';
      titleSpan.textContent = doc.title;

      docEl.appendChild(icon);
      docEl.appendChild(titleSpan);

      docEl.addEventListener('click', () => {
        _activeDocId = doc.id;
        render(); // Synchronize corresponding node in highlight directory tree
        if (_onSelectDocCallback) _onSelectDocCallback(doc.id);
      });

      listContainer.appendChild(docEl);
    });
  }

  // Set and activate the specified document, automatically expanding parent folders
  function setActiveDoc(docId) {
    _activeDocId = docId;
    if (docId) {
      const docs = Storage.getDocMeta();
      const doc = docs[docId];
      if (doc && doc.folderId) {
        let currentFolderId = doc.folderId;
        const folders = Storage.getFolders();
        while (currentFolderId) {
          _collapsedFolders.delete(currentFolderId);
          const f = folders[currentFolderId];
          currentFolderId = f ? f.parentId : null;
        }
        saveCollapsed();
      }
    }
    render();
  }

  return {
    init,
    render,
    setActiveDoc
  };
})();


// editor.js — Editor and shortcut formatting control module
// Responsible for automatic line number generation, scroll synchronization, toolbar rich text formatting tools (bold, italic, code, link, LaTeX), and shortcut key support

const Editor = (() => {
  let _textarea = null;
  let _lineNumbers = null;
  let _onChangeCallback = null;

  // Initialize editor configuration
  function init(onChange) {
    _textarea = document.getElementById('editorTextarea');
    _lineNumbers = document.getElementById('lineNumbers');
    _onChangeCallback = onChange;

    if (!_textarea || !_lineNumbers) return;

    // Listen to input events: update line numbers in real-time, and trigger main controller's modify callback (e.g., render preview, auto-save)
    _textarea.addEventListener('input', () => {
      updateLineNumbers();
      if (_onChangeCallback) _onChangeCallback(getContent());
    });

    // Listen to scroll events: synchronize the scroll position of line numbers and text input box completely in the vertical direction
    _textarea.addEventListener('scroll', syncScroll);

    // Listen to keyboard press: support Tab indentation and common Ctrl/Cmd shortcuts
    _textarea.addEventListener('keydown', handleKeydown);

    // Bind toolbar formatting button events
    bindToolbarButtons();


    // Generate line numbers initially once
    updateLineNumbers();
  }

  // Synchronize scroll position
  function syncScroll() {
    if (_lineNumbers && _textarea) {
      _lineNumbers.scrollTop = _textarea.scrollTop;
    }
  }

  // Dynamically update line numbers
  function updateLineNumbers() {
    if (!_textarea || !_lineNumbers) return;
    const text = _textarea.value;
    const lines = text.split('\n');
    const lineCount = Math.max(1, lines.length);

    let lineNumbersHTML = '';
    for (let i = 1; i <= lineCount; i++) {
      lineNumbersHTML += i + '\n';
    }
    _lineNumbers.textContent = lineNumbersHTML;
    
    // Recalibrate scrollbar immediately after each line number update
    syncScroll();
  }

  // Insert specifically formatted Markdown marks at cursor position or wrap selected text
  function insertFormat(prefix, suffix, defaultText = '') {
    if (!_textarea) return;

    const start = _textarea.selectionStart;
    const end = _textarea.selectionEnd;
    const value = _textarea.value;

    const selectionText = value.substring(start, end);
    const contentToInsert = selectionText || defaultText;
    const insertion = prefix + contentToInsert + suffix;

    _textarea.value = value.substring(0, start) + insertion + value.substring(end);

    // Re-adjust cursor position so that the text selected by the user remains selected after formatting, or cursor is between syntax symbols
    _textarea.focus();
    if (selectionText) {
      _textarea.setSelectionRange(start + prefix.length, start + prefix.length + selectionText.length);
    } else {
      _textarea.setSelectionRange(start + prefix.length, start + prefix.length + defaultText.length);
    }

    // Trigger update
    updateLineNumbers();
    if (_onChangeCallback) _onChangeCallback(getContent());
  }

  // Bind events to toolbar buttons
  function bindToolbarButtons() {
    const boldBtn = document.getElementById('boldBtn');
    const italicBtn = document.getElementById('italicBtn');
    const codeBtn = document.getElementById('codeBtn');
    const linkBtn = document.getElementById('linkBtn');
    const latexBtn = document.getElementById('latexBtn');

    if (boldBtn) {
      boldBtn.addEventListener('click', () => insertFormat('**', '**', 'Bold Text'));
    }
    if (italicBtn) {
      italicBtn.addEventListener('click', () => insertFormat('*', '*', 'Italic Text'));
    }
    if (codeBtn) {
      codeBtn.addEventListener('click', () => {
        // Use block code block if selected text contains newlines; otherwise use inline code
        const start = _textarea.selectionStart;
        const end = _textarea.selectionEnd;
        const selection = _textarea.value.substring(start, end);
        if (selection.includes('\n')) {
          insertFormat('```javascript\n', '\n```', 'console.log("Hello World");');
        } else {
          insertFormat('`', '`', 'code');
        }
      });
    }
    if (linkBtn) {
      linkBtn.addEventListener('click', () => {
        const start = _textarea.selectionStart;
        const end = _textarea.selectionEnd;
        const selection = _textarea.value.substring(start, end);
        if (selection.startsWith('http://') || selection.startsWith('https://')) {
          // Selected content is a link
          insertFormat('[Link Text](', ')', selection);
        } else {
          // Selected content is plain text
          insertFormat('[', '](https://example.com)', selection || 'Link Name');
        }
      });
    }
    if (latexBtn) {
      latexBtn.addEventListener('click', () => {
        const start = _textarea.selectionStart;
        const end = _textarea.selectionEnd;
        const selection = _textarea.value.substring(start, end);
        // If multiple lines, insert block-level formula, otherwise inline formula
        if (selection.includes('\n')) {
          insertFormat('$$\n', '\n$$', 'E = mc^2');
        } else {
          insertFormat('$', '$', 'f(x) = x^2');
        }
      });
    }
  }

  // Keyboard shortcut listener
  function handleKeydown(e) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

    // 1. Support Tab key to input 2 spaces indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = _textarea.selectionStart;
      const end = _textarea.selectionEnd;
      const value = _textarea.value;

      _textarea.value = value.substring(0, start) + '  ' + value.substring(end);
      _textarea.setSelectionRange(start + 2, start + 2);

      updateLineNumbers();
      if (_onChangeCallback) _onChangeCallback(getContent());
      return;
    }

    // 2. Ctrl + B -> Bold
    if (ctrlKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      insertFormat('**', '**', 'Bold Text');
      return;
    }

    // 3. Ctrl + I -> Italic
    if (ctrlKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      insertFormat('*', '*', 'Italic Text');
      return;
    }

    // 4. Ctrl + K -> Link
    if (ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const start = _textarea.selectionStart;
      const end = _textarea.selectionEnd;
      const selection = _textarea.value.substring(start, end);
      insertFormat('[', '](url)', selection || 'Link Name');
      return;
    }
  }

  // Set editor content
  function setContent(content) {
    if (_textarea) {
      _textarea.value = content || '';
      updateLineNumbers();
    }
  }

  // Get editor content
  function getContent() {
    return _textarea ? _textarea.value : '';
  }

  // Expose API
  return {
    init,
    setContent,
    getContent,
    updateLineNumbers,
    syncScroll
  };
})();


// search.js — Full-text search engine interaction module
// Handles search bar input debouncing, full-text retrieval, search result title/content snippet highlighting, and click navigation

const Search = (() => {
  let _input = null;
  let _resultsContainer = null;
  let _debounceTimer = null;
  let _onSelectDocCallback = null;

  // Initialize search engine, pass in callback for selecting document
  function init(onSelectDoc) {
    _input = document.getElementById('searchInput');
    _resultsContainer = document.getElementById('searchResults');
    _onSelectDocCallback = onSelectDoc;

    if (!_input || !_resultsContainer) return;

    // Execute with debounce on input change (200ms) to avoid high-frequency retrieval slowing down response
    _input.addEventListener('input', () => {
      clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(performSearch, 200);
    });

    // Auto-hide results overlay when clicking outside search areas
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#searchInput') && !e.target.closest('#searchResults')) {
        hideResults();
      }
    });

    // Show results again when clicking on search box with existing input
    _input.addEventListener('click', () => {
      if (_input.value.trim().length > 0) {
        _resultsContainer.classList.remove('hidden');
      }
    });
  }

  // Hide search results list
  function hideResults() {
    if (_resultsContainer) {
      _resultsContainer.classList.add('hidden');
    }
  }

  // Execute search logic
  async function performSearch() {
    const query = _input.value.trim();
    if (!query) {
      hideResults();
      return;
    }

    _resultsContainer.classList.remove('hidden');
    _resultsContainer.textContent = '';
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'search-empty';
    emptyMsg.textContent = 'Searching...';
    _resultsContainer.appendChild(emptyMsg);

    try {
      const results = await Storage.searchDocs(query);
      if (results.length === 0) {
        _resultsContainer.textContent = '';
        const noMatchMsg = document.createElement('div');
        noMatchMsg.className = 'search-empty';
        noMatchMsg.textContent = 'No matching documents found';
        _resultsContainer.appendChild(noMatchMsg);
        return;
      }

      _resultsContainer.textContent = '';
      results.forEach(doc => {
        const item = document.createElement('div');
        item.className = 'search-result-item';

        // Safely wrap matching highlights for title and body snippets respectively
        const highlightedTitle = highlightKeyword(doc.title, query);
        const highlightedSnippet = highlightKeyword(doc.snippet || '', query);

        const title = document.createElement('div');
        title.className = 'search-result-title';
        const titleDoc = new DOMParser().parseFromString(highlightedTitle, "text/html");
        title.replaceChildren(...titleDoc.body.childNodes);

        const snippet = document.createElement('div');
        snippet.className = 'search-result-snippet';
        const snippetDoc = new DOMParser().parseFromString(highlightedSnippet, "text/html");
        snippet.replaceChildren(...snippetDoc.body.childNodes);

        item.appendChild(title);
        item.appendChild(snippet);

        // Open document and clear search state when clicking search result item
        item.addEventListener('click', () => {
          hideResults();
          _input.value = '';
          if (_onSelectDocCallback) {
            _onSelectDocCallback(doc.id);
          }
        });

        _resultsContainer.appendChild(item);
      });
    } catch (err) {
      console.error('Full-text search error:', err);
      _resultsContainer.textContent = '';
      const errMsg = document.createElement('div');
      errMsg.className = 'search-empty';
      errMsg.style.color = '#dc2626';
      errMsg.textContent = `Search failed: ${err.message}`;
      _resultsContainer.appendChild(errMsg);
    }
  }

  // Helper function: safely highlight matching text, preserving original case, preventing HTML injection attacks
  function highlightKeyword(text, keyword) {
    if (!text) return '';
    const escapedText = escapeHTML(text);
    const escapedKeyword = escapeHTML(keyword);
    
    // RegExp escaping, safely perform case-insensitive full-text replacement
    const regexPattern = escapedKeyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(${regexPattern})`, 'gi');
    return escapedText.replace(regex, '<mark>$1</mark>');
  }

  // Helper function: escape HTML special characters to prevent XSS
  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return {
    init,
    hideResults
  };
})();


// highlight.js — Selected text highlighting component
// Responsible for capturing selection range in the preview panel, positioning popup bubbles, saving highlight data, safely replacing rendering highlight effects via DOM, and clicking to undo

const Highlight = (() => {
  let _bubble = null;
  let _activeDocId = null;
  let _onHighlightChangedCallback = null;

  // Initialize highlight module, bind selection events and color buttons
  function init(onHighlightChanged) {
    _bubble = document.getElementById('highlightBubble');
    _onHighlightChangedCallback = onHighlightChanged;

    if (!_bubble) return;

    // Listen to mouse up and selection change events to intelligently position and show or hide highlight floating bubble
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleMouseUp);

    // Bind highlight color selection buttons
    const buttons = _bubble.querySelectorAll('.hl-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.dataset.color;
        applySelectedHighlight(color);
      });
    });

    // Bind click deletion mechanism for highlight marks
    const mdBody = document.getElementById('mdBody');
    if (mdBody) {
      mdBody.addEventListener('click', handleDeleteHighlightClick);
    }
  }

  // Bind currently selected document ID
  function setActiveDoc(docId) {
    _activeDocId = docId;
    hideBubble();
  }

  // Get and display selection position
  function handleSelectionChange() {
    if (!_activeDocId) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideBubble();
      return;
    }

    const range = selection.getRangeAt(0);
    const mdBody = document.getElementById('mdBody');
    if (!mdBody || !mdBody.contains(range.commonAncestorContainer)) {
      hideBubble();
      return;
    }

    // Avoid empty text or pure spaces selection
    if (selection.toString().trim().length === 0) {
      hideBubble();
      return;
    }

    // Get selection viewport position and precisely position bubble
    const rect = range.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    // Display bubble directly above selection
    _bubble.style.left = `${rect.left + scrollX + (rect.width / 2) - (_bubble.offsetWidth / 2)}px`;
    _bubble.style.top = `${rect.top + scrollY - _bubble.offsetHeight - 8}px`;
    _bubble.classList.remove('hidden');
  }

  function handleMouseUp(e) {
    // Delay detection to prevent closing during mouseup phase when clicking bubble buttons themselves
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hideBubble();
      }
    }, 100);
  }

  // Hide highlight bubble
  function hideBubble() {
    if (_bubble) {
      _bubble.classList.add('hidden');
    }
  }

  // Confirm highlight selection, write to storage
  async function applySelectedHighlight(color) {
    if (!_activeDocId) return;

    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text) return;

    const highlight = {
      text: text,
      color: color,
      createdAt: Date.now()
    };

    await Storage.addHighlight(_activeDocId, highlight);

    // Clear browser selection
    selection.removeAllRanges();
    hideBubble();

    // Notify rendering update
    if (_onHighlightChangedCallback) {
      _onHighlightChangedCallback();
    }
  }

  // Render highlight effect: use safe DOM tree traversal, ensure only text nodes are modified, without polluting Markdown original HTML and code block attributes
  async function applyHighlightsToDOM(container) {
    if (!_activeDocId || !container) return;

    const highlights = await Storage.getHighlights(_activeDocId);
    if (!highlights || highlights.length === 0) return;

    // Use TreeWalker to filter only text nodes contained in regular typography, avoiding special nodes like pre, code, a links, etc. to prevent breaking code logic and links
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const tagName = parent.tagName;
        // Reject code blocks, links, script nodes, etc.
        if (
          tagName === 'CODE' || 
          tagName === 'PRE' || 
          tagName === 'SCRIPT' || 
          parent.closest('pre') || 
          parent.closest('code') || 
          parent.closest('a')
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    let currentNode;
    while (currentNode = walker.nextNode()) {
      textNodes.push(currentNode);
    }

    // Sort by highlight string length from longest to shortest to prevent long strings from being truncated by short strings
    const sortedHls = [...highlights].sort((a, b) => b.text.length - a.text.length);

    // Iterate through all eligible text nodes, safely replace with mark tags
    textNodes.forEach(node => {
      const parent = node.parentElement;
      if (!parent) return;

      const text = node.nodeValue;

      // Recursive text segmentation function to find the earliest matching item and split
      function segmentText(str) {
        if (!str) return [];

        let earliestMatch = null;
        let earliestIndex = -1;
        let matchedHl = null;

        for (const hl of sortedHls) {
          if (!hl.text || hl.text.trim().length === 0) continue;

          const index = str.toLowerCase().indexOf(hl.text.toLowerCase());
          if (index !== -1) {
            if (earliestIndex === -1 || index < earliestIndex) {
              earliestIndex = index;
              earliestMatch = hl.text;
              matchedHl = hl;
            } else if (index === earliestIndex) {
              // Same start point, prioritize matching item with longer length
              if (hl.text.length > earliestMatch.length) {
                earliestMatch = hl.text;
                matchedHl = hl;
              }
            }
          }
        }

        if (earliestIndex !== -1) {
          const before = str.substring(0, earliestIndex);
          const match = str.substring(earliestIndex, earliestIndex + earliestMatch.length);
          const after = str.substring(earliestIndex + earliestMatch.length);

          const result = [];
          if (before) result.push(document.createTextNode(before));

          const mark = document.createElement('mark');
          mark.className = `hl-${matchedHl.color}`;
          mark.dataset.hlId = matchedHl.id;
          mark.textContent = match;
          result.push(mark);

          if (after) {
            result.push(...segmentText(after));
          }
          return result;
        }

        return [document.createTextNode(str)];
      }

      const segments = segmentText(text);
      // If actual segmentation occurred (i.e. includes mark tags, or multiple nodes exist)
      if (segments.length > 1 || (segments.length === 1 && segments[0].nodeType !== Node.TEXT_NODE)) {
        const fragment = document.createDocumentFragment();
        segments.forEach(seg => fragment.appendChild(seg));
        parent.replaceChild(fragment, node);
      }
    });
  }

  // Click highlight tag to delete highlight mark
  async function handleDeleteHighlightClick(e) {
    const mark = e.target.closest('mark[data-hl-id]');
    if (!mark || !_activeDocId) return;

    e.stopPropagation();
    if (confirm(`Are you sure you want to remove this highlight data?\n"${mark.textContent}"`)) {
      const hlId = mark.dataset.hlId;
      await Storage.removeHighlight(_activeDocId, hlId);

      // Notify rendering update
      if (_onHighlightChangedCallback) {
        _onHighlightChangedCallback();
      }
    }
  }

  return {
    init,
    setActiveDoc,
    applyHighlightsToDOM,
    hideBubble
  };
})();


// manager.js — Main control hub for Notes Manager
// Responsible for data initialization, view state management, two-way content real-time rendering, debounced auto-save, file drag-and-drop import, and toolbar action binding

const Manager = (() => {
  let _activeDocId = null;
  let _titleDebounceTimer = null;
  let _contentDebounceTimer = null;

  // DOM Element References
  const dom = {
    sidebar: document.getElementById('sidebar'),
    editorPane: document.getElementById('editorPane'),
    previewPane: document.getElementById('previewPane'),
    emptyState: document.getElementById('emptyState'),
    mdBody: document.getElementById('mdBody'),
    docTitleInput: document.getElementById('docTitleInput'),
    toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
    newDocBtn: document.getElementById('newDocBtn'),
    newFolderBtn: document.getElementById('newFolderBtn'),
    importBtn: document.getElementById('importBtn'),
    fileInput: document.getElementById('fileInput'),
    bookmarkBtn: document.getElementById('bookmarkBtn'),
    toggleViewBtn: document.getElementById('toggleViewBtn'),
    downloadMdBtn: document.getElementById('downloadMdBtn'),
    exportPdfBtn: document.getElementById('exportPdfBtn'),
    dragOverlay: document.getElementById('dragOverlay')
  };

  // Compatibility Adapter
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // Check and process auto-import from Gemini conversation
  async function checkAutoImport() {
    if (window.location.hash === '#import-active') {
      // Immediately clear hash to prevent duplicate import creating new notes on page refresh
      history.replaceState(null, '', window.location.pathname);

      try {
        const data = await browserAPI.storage.local.get(['activeMD', 'importFileName']);
        const mdText = data.activeMD;
        if (mdText && typeof mdText === 'string' && mdText.trim().length > 0) {
          let title = 'Gemini Export Conversation';
          
          if (data.importFileName) {
            // It's a local file import, use the filename
            title = data.importFileName.replace(/\.(md|markdown|txt)$/i, '');
          } else {
            // It's an extracted Gemini conversation, try to find # H1
            const match = mdText.match(/^#\s+(.+)$/m);
            if (match && match[1]) {
              title = match[1].trim();
            } else {
              const now = new Date();
              title = `Gemini Conversation ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            }
          }

          // Import and save to local storage
          const doc = await Storage.createDoc(title, mdText);

          // Set as currently active editing state
          _activeDocId = doc.id;
          localStorage.setItem('mdm_active_doc_id', doc.id);
          localStorage.setItem('mdm_view_mode', 'dual'); // Force dual view on import

          // Synchronously clear cache to avoid future interference
          await browserAPI.storage.local.remove(['activeMD', 'importFileName']);
        }
      } catch (err) {
        console.error('Failed to auto-import conversation:', err);
      }
    }
  }

  // Application entry initialization
  async function init() {
    // 1. Initialize storage engine
    await Storage.init();

    // 2. Initialize each sub-function component, connecting relation callbacks
    FolderTree.init(loadDocument);
    Editor.init(onContentChange);
    Search.init(loadDocument);
    Highlight.init(onHighlightChanged);

    // 3. Bind top toolbar global events
    bindToolbarEvents();

    // 4. Bind full-screen drag-and-drop import events
    bindDragAndDropEvents();

    // 5. Check auto import
    await checkAutoImport();

    // 6. Restore previous states (sidebar collapsed state, dual-pane state, last opened document)
    restoreStates();
  }

  // Restore previous layout and document states
  function restoreStates() {
    // Restore sidebar state
    const isSidebarCollapsed = localStorage.getItem('mdm_sidebar_collapsed') === 'true';
    if (isSidebarCollapsed) {
      dom.sidebar.classList.add('collapsed');
    }

    // Restore dual-pane mode
    const savedViewMode = localStorage.getItem('mdm_view_mode') || 'dual';
    setViewMode(savedViewMode);

    // Restore opened document
    const lastDocId = localStorage.getItem('mdm_active_doc_id');
    const docs = Storage.getDocMeta();
    if (lastDocId && docs[lastDocId]) {
      loadDocument(lastDocId);
    } else {
      loadDocument(null);
    }
  }

  // Load specified document into the editor
  async function loadDocument(docId) {
    _activeDocId = docId;

    if (!docId) {
      // Show empty state, hide editor
      localStorage.removeItem('mdm_active_doc_id');
      dom.emptyState.classList.remove('hidden');
      dom.editorPane.classList.add('collapsed');
      dom.mdBody.textContent = '';
      dom.docTitleInput.value = '';
      
      // Update sub-states
      FolderTree.setActiveDoc(null);
      Highlight.setActiveDoc(null);
      return;
    }

    localStorage.setItem('mdm_active_doc_id', docId);
    dom.emptyState.classList.add('hidden');
    
    // If not in preview-only mode, show editor pane
    const currentMode = localStorage.getItem('mdm_view_mode') || 'dual';
    if (currentMode !== 'preview') {
      dom.editorPane.classList.remove('collapsed');
    }

    const docMeta = Storage.getDocMeta()[docId];
    const content = await Storage.getDocContent(docId);

    if (!docMeta) return;

    // Fill title and body inputs
    dom.docTitleInput.value = docMeta.title;
    Editor.setContent(content);

    // Render preview
    renderMarkdown(content);

    // Apply and render highlight data
    Highlight.setActiveDoc(docId);
    await Highlight.applyHighlightsToDOM(dom.mdBody);

    // Update bookmark button state
    updateBookmarkButton(docMeta.isBookmarked);

    // Synchronize directory tree highlight display
    FolderTree.setActiveDoc(docId);

    // Reset scrollbar
    dom.previewPane.scrollTop = 0;
    
    // Force a line number regeneration and alignment
    Editor.updateLineNumbers();
  }

  // Render Markdown to HTML and process math formulas (Supports KaTeX)
  function renderMarkdown(mdText) {
    if (!dom.mdBody) return;

    // 1. Protect LaTeX syntax formula blocks from being mistakenly modified by marked parser
    const latexBlocks = [];
    let processed = mdText;

    // Protect block-level formulas $$ ... $$
    processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (match, latex) => {
      const idx = latexBlocks.length;
      latexBlocks.push({ type: 'block', latex: latex.trim() });
      return `%%LATEX_BLOCK_${idx}%%`;
    });

    // Protect inline formulas $ ... $ (excluding double dollar signs)
    processed = processed.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (match, latex) => {
      const idx = latexBlocks.length;
      latexBlocks.push({ type: 'inline', latex: latex.trim() });
      return `%%LATEX_INLINE_${idx}%%`;
    });

    // 2. Use marked to parse Markdown into HTML
    const html = marked.parse(processed, {
      gfm: true,
      breaks: false,
    });

    // 3. Replace KaTeX placeholders with real math HTML snippets
    let finalHtml = html;
    latexBlocks.forEach((item, idx) => {
      let rendered = '';
      try {
        rendered = katex.renderToString(item.latex, {
          displayMode: item.type === 'block',
          throwOnError: false,
          output: 'htmlAndMathml',
        });
      } catch (e) {
        rendered = item.type === 'block'
          ? `<pre><code>$$${item.latex}$$</code></pre>`
          : `<code>$${item.latex}$</code>`;
      }

      const placeholder = item.type === 'block'
        ? `%%LATEX_BLOCK_${idx}%%`
        : `%%LATEX_INLINE_${idx}%%`;

      // Restore block formula placeholders wrapped in <p> tags
      finalHtml = finalHtml.replace(
        new RegExp(`<p>\\s*${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</p>`, 'g'),
        item.type === 'block' ? `<div class="katex-display">${rendered}</div>` : rendered
      );
      finalHtml = finalHtml.replace(
        new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        rendered
      );
    });

    const finalDoc = new DOMParser().parseFromString(finalHtml, "text/html");
    dom.mdBody.replaceChildren(...finalDoc.body.childNodes);

    // 4. Lazy-load local assets and attach info for interaction
    const images = dom.mdBody.querySelectorAll('img');
    images.forEach(async (img) => {
      const originalSrc = img.getAttribute('src');
      img.dataset.mdSrc = originalSrc;
      img.dataset.mdAlt = img.getAttribute('alt') || '';
      if (originalSrc.startsWith('local://')) {
        const assetId = originalSrc.replace('local://', '');
        const base64Data = await Storage.getAsset(assetId);
        if (base64Data) {
          img.src = base64Data;
        }
      }
      // Setup image interaction
      img.setAttribute('draggable', 'true');
    });
  }

  // Listen to editor content real-time changes
  function onContentChange(content) {
    // 1. Re-parse Markdown and render preview
    renderMarkdown(content);

    // 2. Real-time mount highlight selection elements
    Highlight.applyHighlightsToDOM(dom.mdBody);

    // 3. Debounce auto-save (500ms), avoid frequent writes to IndexedDB/chrome.storage while typing
    clearTimeout(_contentDebounceTimer);
    _contentDebounceTimer = setTimeout(async () => {
      if (_activeDocId) {
        await Storage.updateDocContent(_activeDocId, content);
      }
    }, 500);
  }

  // Linkage callback after highlight changes
  async function onHighlightChanged() {
    if (!_activeDocId) return;
    // Re-render preview body and apply highlight effects
    const content = Editor.getContent();
    renderMarkdown(content);
    await Highlight.applyHighlightsToDOM(dom.mdBody);
  }

  // --- Image Interaction Logic (Toolbar & Drag-and-Drop) ---
  let _activeImage = null;

  function hideImageToolbar() {
    const toolbar = document.getElementById('imageToolbar');
    if (toolbar) toolbar.classList.add('hidden');
    if (_activeImage) {
      _activeImage.classList.remove('active');
      _activeImage = null;
    }
  }

  function showImageToolbar(img) {
    if (_activeImage === img) return;
    hideImageToolbar();
    _activeImage = img;
    img.classList.add('active');

    let toolbar = document.getElementById('imageToolbar');
    toolbar.classList.remove('hidden');

    // Position toolbar in the top-right corner of the image
    const rect = img.getBoundingClientRect();
    const bodyWidth = document.body.clientWidth;
    
    toolbar.style.top = `${rect.top + 8}px`;
    toolbar.style.left = 'auto';
    toolbar.style.right = `${bodyWidth - rect.right + 8}px`;
  }

  function getImageMarkdownSyntax(img) {
    const alt = img.dataset.mdAlt || '';
    const src = img.dataset.mdSrc || '';
    return `![${alt}](${src})`;
  }

  function replaceImageMarkdown(img, action) {
    if (!_activeDocId) return;
    const syntax = getImageMarkdownSyntax(img);
    let content = Editor.getContent();
    
    // Find the syntax in the content
    const idx = content.indexOf(syntax);
    if (idx === -1) return; // not found
    
    content = content.replace(syntax, '');
    content = content.trim();

    if (action === 'top') {
      content = syntax + '\n\n' + content;
    } else if (action === 'bottom') {
      content = content + '\n\n' + syntax;
    } // 'delete' does nothing else

    Editor.setContent(content);
    onContentChange(content);
    hideImageToolbar();
  }

  // Setup Image Interactions
  dom.mdBody.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG') {
      showImageToolbar(e.target);
    } else {
      hideImageToolbar();
    }
  });

  document.addEventListener('click', (e) => {
    const toolbar = document.getElementById('imageToolbar');
    if (toolbar && !toolbar.contains(e.target) && e.target.tagName !== 'IMG') {
      hideImageToolbar();
    }
  });
  
  dom.previewPane.addEventListener('scroll', hideImageToolbar);

  document.getElementById('imgBtnTop')?.addEventListener('click', () => {
    if (_activeImage) replaceImageMarkdown(_activeImage, 'top');
  });
  document.getElementById('imgBtnBottom')?.addEventListener('click', () => {
    if (_activeImage) replaceImageMarkdown(_activeImage, 'bottom');
  });
  document.getElementById('imgBtnDelete')?.addEventListener('click', () => {
    if (_activeImage) replaceImageMarkdown(_activeImage, 'delete');
  });

  // Handle Internal Drag and Drop
  let _draggedImageSyntax = null;
  let _dropIndicator = null;

  dom.mdBody.addEventListener('dragstart', (e) => {
    if (e.target.tagName === 'IMG') {
      _draggedImageSyntax = getImageMarkdownSyntax(e.target);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _draggedImageSyntax);
      setTimeout(() => e.target.classList.add('dragging'), 0);
      hideImageToolbar();
    }
  });

  dom.mdBody.addEventListener('dragend', (e) => {
    if (e.target.tagName === 'IMG') {
      e.target.classList.remove('dragging');
      _draggedImageSyntax = null;
      if (_dropIndicator) _dropIndicator.remove();
    }
  });

  dom.mdBody.addEventListener('dragover', (e) => {
    if (!_draggedImageSyntax) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Find the closest block element to show drop indicator
    const target = e.target;
    if (target !== dom.mdBody && !target.classList.contains('md-body')) {
      const rect = target.getBoundingClientRect();
      const isTop = (e.clientY - rect.top) < (rect.height / 2);
      
      if (!_dropIndicator) {
        _dropIndicator = document.createElement('div');
        _dropIndicator.className = 'drop-indicator';
      }
      
      if (isTop) {
        target.parentNode.insertBefore(_dropIndicator, target);
      } else {
        target.parentNode.insertBefore(_dropIndicator, target.nextSibling);
      }
    }
  });

  dom.mdBody.addEventListener('drop', (e) => {
    if (!_draggedImageSyntax) return;
    e.preventDefault();
    e.stopPropagation(); // prevent global file drop
    
    if (_dropIndicator) {
      let content = Editor.getContent();
      const syntax = _draggedImageSyntax;
      
      // Remove original syntax
      content = content.replace(syntax, '');
      
      // We need to insert the syntax into the DOM temporarily to find its new position, 
      // but since we rebuild from markdown, it's easier to append to the end 
      // or implement a rough text insertion based on block order.
      // For simplicity and exact placement, we use the drop indicator's sibling
      const nextSibling = _dropIndicator.nextElementSibling;
      const prevSibling = _dropIndicator.previousElementSibling;
      
      // Rough mapping: find text of next sibling in content
      if (nextSibling && nextSibling.textContent.trim()) {
        const siblingText = nextSibling.textContent.trim().substring(0, 20);
        const idx = content.indexOf(siblingText);
        if (idx !== -1) {
          content = content.substring(0, idx) + syntax + '\n\n' + content.substring(idx);
        } else {
          content += '\n\n' + syntax;
        }
      } else if (prevSibling && prevSibling.textContent.trim()) {
        const siblingText = prevSibling.textContent.trim().substring(0, 20);
        const idx = content.indexOf(siblingText);
        if (idx !== -1) {
          const insertIdx = idx + siblingText.length;
          content = content.substring(0, insertIdx) + '\n\n' + syntax + '\n\n' + content.substring(insertIdx);
        } else {
          content += '\n\n' + syntax;
        }
      } else {
         // fallback to top
         content = syntax + '\n\n' + content;
      }
      
      Editor.setContent(content.trim());
      onContentChange(Editor.getContent());
      _dropIndicator.remove();
    }
  });

  // Unified view multi-column mode setting
  function setViewMode(mode) {
    localStorage.setItem('mdm_view_mode', mode);

    if (mode === 'dual') {
      // Dual pane
      dom.editorPane.classList.remove('collapsed');
      dom.previewPane.style.display = 'block';
      dom.toggleViewBtn.textContent = 'Split';
    } else if (mode === 'edit') {
      // Edit only
      dom.editorPane.classList.remove('collapsed');
      dom.previewPane.style.display = 'none';
      dom.toggleViewBtn.textContent = 'Edit Only';
    } else if (mode === 'preview') {
      // Preview only
      dom.editorPane.classList.add('collapsed');
      dom.previewPane.style.display = 'block';
      dom.toggleViewBtn.textContent = 'Preview Only';
    }
    
    // Rearrange editor line numbers after viewport size change
    Editor.updateLineNumbers();
  }

  // Toggle bookmark star button visual color
  function updateBookmarkButton(isBookmarked) {
    if (isBookmarked) {
      dom.bookmarkBtn.style.color = '#e0a800'; // Yellow highlight
      dom.bookmarkBtn.style.fontWeight = 'bold';
    } else {
      dom.bookmarkBtn.style.color = '';
      dom.bookmarkBtn.style.fontWeight = '';
    }
  }

  // Bind global toolbar events
  function bindToolbarEvents() {
    // Toggle sidebar collapse/expand
    dom.toggleSidebarBtn.addEventListener('click', () => {
      const isCollapsed = dom.sidebar.classList.toggle('collapsed');
      localStorage.setItem('mdm_sidebar_collapsed', isCollapsed);
    });

    // New document (in root directory)
    dom.newDocBtn.addEventListener('click', async () => {
      const title = prompt('Please enter the title of the new document:');
      if (title && title.trim()) {
        const doc = await Storage.createDoc(title.trim(), '');
        FolderTree.render();
        loadDocument(doc.id);
      }
    });

    // New folder (in root directory)
    dom.newFolderBtn.addEventListener('click', async () => {
      const name = prompt('Please enter the name of the new folder:');
      if (name && name.trim()) {
        await Storage.createFolder(name.trim());
        FolderTree.render();
      }
    });

    // Import document button: triggers file picker
    dom.importBtn.addEventListener('click', () => {
      dom.fileInput.click();
    });

    dom.fileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        const fileArr = [];
        for (let i = 0; i < files.length; i++) {
          fileArr.push({ file: files[i], path: files[i].webkitRelativePath || files[i].name });
        }
        await processFiles(fileArr);
      }
    });

    // Bookmark toggle button
    dom.bookmarkBtn.addEventListener('click', async () => {
      if (!_activeDocId) return;
      const isStarred = await Storage.toggleBookmark(_activeDocId);
      updateBookmarkButton(isStarred);
      FolderTree.render();
    });

    // View mode toggle (cycle between "Dual pane -> Edit only -> Preview only")
    dom.toggleViewBtn.addEventListener('click', () => {
      const currentMode = localStorage.getItem('mdm_view_mode') || 'dual';
      if (currentMode === 'dual') {
        setViewMode('edit');
      } else if (currentMode === 'edit') {
        setViewMode('preview');
      } else {
        setViewMode('dual');
      }
    });

    // Download MD file (ZIP mode if it contains local assets)
    dom.downloadMdBtn.addEventListener('click', async () => {
      if (!_activeDocId) return;
      const docMeta = Storage.getDocMeta()[_activeDocId];
      let content = Editor.getContent();

      // Find all local:// assets
      const regex = /!\[.*?\]\((local:\/\/[^)]+)\)/g;
      const matches = [...content.matchAll(regex)];
      
      if (matches.length > 0 && typeof JSZip !== 'undefined') {
        const zip = new JSZip();
        const assetsFolder = zip.folder("assets");
        
        for (const match of matches) {
          const localUri = match[1];
          const assetId = localUri.replace('local://', '');
          const base64Data = await Storage.getAsset(assetId);
          
          if (base64Data) {
            // Extract pure base64
            const base64Content = base64Data.split(',')[1];
            if (base64Content) {
              assetsFolder.file(assetId, base64Content, {base64: true});
              // Rewrite markdown link to relative asset path
              content = content.replace(localUri, `assets/${assetId}`);
            }
          }
        }
        
        zip.file(`${docMeta.title}.md`, content);
        const zipBlob = await zip.generateAsync({type:"blob"});
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${docMeta.title}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        // Normal single MD download
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${docMeta.title}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });

    // Export PDF (calls print)
    dom.exportPdfBtn.addEventListener('click', () => {
      window.print();
    });

    // Document title input box change event (300ms debounce update title metadata)
    dom.docTitleInput.addEventListener('input', () => {
      if (!_activeDocId) return;
      const newTitle = dom.docTitleInput.value.trim() || 'Untitled Document';

      clearTimeout(_titleDebounceTimer);
      _titleDebounceTimer = setTimeout(async () => {
        await Storage.updateDocMeta(_activeDocId, { title: newTitle });
        FolderTree.render();
      }, 300);
    });
  }

  // Read file content as text
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = e => reject(e);
      reader.readAsText(file);
    });
  }

  // Read file content as Data URL
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = e => reject(e);
      reader.readAsDataURL(file);
    });
  }

  // Recursively traverse folder tree and get all files
  function traverseFileTree(item, path = '') {
    return new Promise((resolve) => {
      if (item.isFile) {
        item.file(file => resolve([{ file, path: path + file.name }]));
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const files = [];
        const readEntries = () => {
          dirReader.readEntries(entries => {
            if (entries.length === 0) {
              resolve(files);
            } else {
              const promises = [];
              for (let i = 0; i < entries.length; i++) {
                promises.push(traverseFileTree(entries[i], path + item.name + '/'));
              }
              Promise.all(promises).then(results => {
                results.forEach(arr => files.push(...arr));
                readEntries();
              });
            }
          });
        };
        readEntries();
      } else {
        resolve([]);
      }
    });
  }

  // Extract all files from dataTransfer (supports folders)
  async function getAllFiles(dataTransfer) {
    const files = [];
    if (dataTransfer.items) {
      const promises = [];
      for (let i = 0; i < dataTransfer.items.length; i++) {
        const item = dataTransfer.items[i];
        if (item.kind === 'file') {
          const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
          if (entry) {
            promises.push(traverseFileTree(entry));
          } else {
            const file = item.getAsFile();
            if (file) files.push({ file, path: file.name });
          }
        }
      }
      const results = await Promise.all(promises);
      results.forEach(arr => files.push(...arr));
    } else {
      for (let i = 0; i < dataTransfer.files.length; i++) {
        files.push({ file: dataTransfer.files[i], path: dataTransfer.files[i].name });
      }
    }
    return files;
  }

  // Helper: Compress image before saving
  function compressImage(file, maxWidth = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/webp', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Process multi-file import: automatically replace local image links in Markdown with Asset Pool refs
  async function processFiles(fileObjs) {
    const mdFiles = fileObjs.filter(f => f.file.name.match(/\.(md|markdown|txt)$/i));
    const imgFiles = fileObjs.filter(f => f.file.name.match(/\.(png|jpe?g|gif|svg|webp|bmp)$/i));

    if (mdFiles.length === 0) {
      // If it's only images, but they dropped it outside the textarea (since textarea handles its own drop)
      if (imgFiles.length > 0 && _activeDocId) {
        let content = Editor.getContent();
        for (const img of imgFiles) {
          try {
            const base64Data = await compressImage(img.file);
            const ext = img.file.name.split('.').pop() || 'png';
            const localUri = await Storage.saveAsset(base64Data, ext);
            content += `\n![${img.file.name}](${localUri})\n`;
          } catch(err) {
            console.error('Image compression failed', err);
          }
        }
        Editor.setContent(content);
        await Storage.updateDocContent(_activeDocId, content);
        renderMarkdown(content);
        return;
      }

      alert('No Markdown file found, please ensure it contains .md or .txt files.');
      return;
    }

    // For each imported md file
    for (const mdObj of mdFiles) {
      try {
        let mdText = await readFileAsText(mdObj.file);
        
        // Find image links in mdText: ![alt](url) or <img src="url">
        const urlRegex = /!\[.*?\]\((.*?)\)|<img.*?src=["'](.*?)["']/gi;
        let match;
        const urlsToReplace = new Set();
        while ((match = urlRegex.exec(mdText)) !== null) {
          const url = match[1] || match[2];
          if (url && !url.startsWith('http') && !url.startsWith('data:')) {
            urlsToReplace.add(url);
          }
        }

        for (const url of urlsToReplace) {
          const cleanUrl = url.replace(/^\.\//, '');
          // Find matching local image
          const matchedImg = imgFiles.find(img => {
            return img.path.endsWith(cleanUrl) || cleanUrl.endsWith(img.file.name);
          });

          if (matchedImg) {
            try {
              const base64Data = await compressImage(matchedImg.file);
              const ext = matchedImg.file.name.split('.').pop() || 'png';
              const localUri = await Storage.saveAsset(base64Data, ext);
              // Globally replace this local link with our Asset Pool ref
              mdText = mdText.split(url).join(localUri);
            } catch(err) {
              console.error('Image processing failed during import', err);
            }
          }
        }

        const title = mdObj.file.name.replace(/\.(md|markdown|txt)$/i, '');
        const doc = await Storage.createDoc(title, mdText);
        FolderTree.render();
        loadDocument(doc.id);
      } catch (err) {
        console.error('Import file parsing error:', err);
        alert('Import file parsing failed: ' + err.message);
      }
    }

    if (dom.fileInput) dom.fileInput.value = '';
  }

  // Bind drag-and-drop events (supports dragging .md / folders directly to the window to import and parse images with one click)
  function bindDragAndDropEvents() {
    let dragCounter = 0;

    function isOnlyImages(dt) {
      if (!dt.items) return false;
      let hasImg = false;
      let hasOther = false;
      for (let i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file') {
          if (dt.items[i].type.startsWith('image/')) hasImg = true;
          else hasOther = true;
        }
      }
      return hasImg && !hasOther;
    }

    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return; // Allow internal text drag-and-drop
      e.preventDefault();
      if (isOnlyImages(e.dataTransfer)) return; // Don't show full-screen overlay for purely image drags
      
      dragCounter++;
      if (dragCounter === 1 && dom.dragOverlay) {
        dom.dragOverlay.style.display = 'flex';
      }
    });

    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      if (isOnlyImages(e.dataTransfer)) return;

      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0 && dom.dragOverlay) {
        dom.dragOverlay.style.display = 'none';
      }
    });

    window.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      
      if (!isOnlyImages(e.dataTransfer)) {
        dragCounter = 0;
        if (dom.dragOverlay) {
          dom.dragOverlay.style.display = 'none';
        }
      }

      const files = await getAllFiles(e.dataTransfer);
      if (files && files.length > 0) {
        await processFiles(files);
      }
    });

    // Specifically handle dropping images directly into the textarea
    dom.editorTextarea.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
      }
    });

    dom.editorTextarea.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      
      const files = await getAllFiles(e.dataTransfer);
      const imgFiles = files.filter(f => f.file.name.match(/\.(png|jpe?g|gif|svg|webp|bmp)$/i));
      const otherFiles = files.filter(f => !f.file.name.match(/\.(png|jpe?g|gif|svg|webp|bmp)$/i));
      
      // If it's an image-only drag onto the textarea, insert them at the cursor
      if (imgFiles.length > 0 && otherFiles.length === 0) {
        e.preventDefault();
        e.stopPropagation(); // Stop window drop from firing
        
        const startPos = dom.editorTextarea.selectionStart;
        let content = Editor.getContent();
        
        let imgMarkdown = '';
        for (const img of imgFiles) {
          try {
            const base64Data = await compressImage(img.file);
            const ext = img.file.name.split('.').pop() || 'png';
            const localUri = await Storage.saveAsset(base64Data, ext);
            imgMarkdown += `\n![${img.file.name}](${localUri})\n`;
          } catch(err) {
            console.error('Image compression failed', err);
          }
        }
        
        content = content.substring(0, startPos) + imgMarkdown + content.substring(startPos);
        Editor.setContent(content);
        
        if (_activeDocId) {
          await Storage.updateDocContent(_activeDocId, content);
          renderMarkdown(content);
        }
      }
    });

    // Handle pasting images from clipboard
    dom.editorTextarea.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.items) return;
      const items = e.clipboardData.items;
      
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          e.preventDefault(); // Stop default paste
          
          try {
            const base64Data = await compressImage(file);
            const ext = file.type.split('/')[1] || 'png';
            const localUri = await Storage.saveAsset(base64Data, ext);
            
            const startPos = dom.editorTextarea.selectionStart;
            let content = Editor.getContent();
            const imgMarkdown = `![Pasted Image](${localUri})`;
            content = content.substring(0, startPos) + imgMarkdown + content.substring(dom.editorTextarea.selectionEnd);
            
            Editor.setContent(content);
            if (_activeDocId) {
              await Storage.updateDocContent(_activeDocId, content);
              renderMarkdown(content);
            }
          } catch(err) {
            console.error('Failed to paste image', err);
          }
        }
      }
    });
  }

  // Provide auxiliary rendering method for external calls
  function renderActiveDoc() {
    if (_activeDocId) {
      loadDocument(_activeDocId);
    }
  }

  return {
    init,
    loadDocument,
    renderActiveDoc
  };
})();

// Start manager when page DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  Manager.init();
});


