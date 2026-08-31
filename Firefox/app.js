// storage.js — Unified local data reading and writing layer
// All document/folder/highlight data is accessed through this module
// Data is split and stored in chrome.storage.local using multiple keys to avoid serializing large objects

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const Storage = (() => {
  const db = new Dexie('EverythingMD_DB');
  db.version(1).stores({
    folders: 'id, parentId',
    docs: 'id, folderId',
    contents: 'id',
    highlights: 'id, docId',
    assets: 'id'
  });

  let _folders = {};
  let _docs = {};

  function generateId(prefix = '') {
    return prefix + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  async function init() {
    await db.open();
    const folderArr = await db.folders.toArray();
    const docArr = await db.docs.toArray();
    _folders = {};
    folderArr.forEach(f => _folders[f.id] = f);
    _docs = {};
    docArr.forEach(d => _docs[d.id] = d);

    // Drop legacy text-only highlights. They were located by searching for their text, which
    // could not survive a selection crossing an inline element; they carry no block/offset
    // anchor and cannot be converted.
    await db.highlights.filter(h => h.start === undefined).delete();
  }

  function getFolders() { return { ..._folders }; }

  async function createFolder(name, parentId = null) {
    const id = generateId('f_');
    const folder = { id, name, parentId, order: Date.now(), createdAt: Date.now() };
    await db.folders.put(folder);
    _folders[id] = folder;
    return folder;
  }

  async function renameFolder(id, newName) {
    if (!_folders[id]) return;
    await db.folders.update(id, { name: newName });
    _folders[id].name = newName;
  }

  async function deleteFolder(id) {
    if (!_folders[id]) return;
    const parentId = _folders[id].parentId;

    const subfs = await db.folders.where('parentId').equals(id).toArray();
    for (const f of subfs) {
      await db.folders.update(f.id, { parentId });
      if (_folders[f.id]) _folders[f.id].parentId = parentId;
    }

    const subdocs = await db.docs.where('folderId').equals(id).toArray();
    for (const d of subdocs) {
      await db.docs.update(d.id, { folderId: parentId });
      if (_docs[d.id]) _docs[d.id].folderId = parentId;
    }

    await db.folders.delete(id);
    delete _folders[id];
  }

  function getDocMeta() { return { ..._docs }; }

  async function getDocContent(id) {
    const record = await db.contents.get(id);
    return record ? record.content : '';
  }

  async function createDoc(title, content = '', folderId = null) {
    const id = generateId('d_');
    const now = Date.now();
    const meta = { id, title, folderId, isBookmarked: false, createdAt: now, updatedAt: now };

    await db.transaction('rw', db.docs, db.contents, async () => {
      await db.docs.put(meta);
      await db.contents.put({ id, content });
    });

    _docs[id] = meta;
    return meta;
  }

  async function updateDocContent(id, content) {
    if (!_docs[id]) return;
    const now = Date.now();
    await db.transaction('rw', db.docs, db.contents, async () => {
      await db.docs.update(id, { updatedAt: now });
      await db.contents.put({ id, content });
    });
    _docs[id].updatedAt = now;
  }

  async function updateDocMeta(id, changes) {
    if (!_docs[id]) return;
    changes.updatedAt = Date.now();
    await db.docs.update(id, changes);
    Object.assign(_docs[id], changes);
  }

  async function deleteDoc(id) {
    if (!_docs[id]) return;
    await db.transaction('rw', db.docs, db.contents, db.highlights, async () => {
      await db.docs.delete(id);
      await db.contents.delete(id);
      await db.highlights.where('docId').equals(id).delete();
    });
    delete _docs[id];
  }

  async function toggleBookmark(id) {
    if (!_docs[id]) return false;
    const newState = !_docs[id].isBookmarked;
    const now = Date.now();
    await db.docs.update(id, { isBookmarked: newState, updatedAt: now });
    _docs[id].isBookmarked = newState;
    _docs[id].updatedAt = now;
    return newState;
  }

  async function getHighlights(docId) {
    return await db.highlights.where('docId').equals(docId).toArray();
  }

  async function addHighlight(docId, highlight) {
    highlight.id = generateId('hl_');
    highlight.docId = docId;
    await db.highlights.put(highlight);
    return highlight;
  }

  async function removeHighlight(docId, highlightId) {
    await db.highlights.delete(highlightId);
  }

  async function searchDocs(query) {
    if (!query || !query.trim()) return [];
    const q = query.toLowerCase().trim();
    const results = [];

    await db.contents.each(record => {
      const doc = _docs[record.id];
      if (!doc) return;
      let score = 0;
      if (doc.title.toLowerCase().includes(q)) score += 10;
      if (record.content.toLowerCase().includes(q)) score += 5;

      if (score > 0) {
        results.push({
          ...doc,
          score,
          snippet: _extractSnippet(record.content, q)
        });
      }
    });

    return results.sort((a, b) => b.score - a.score);
  }

  function _extractSnippet(content, query) {
    const idx = content.toLowerCase().indexOf(query);
    if (idx === -1) return content.substring(0, 80) + (content.length > 80 ? '...' : '');
    const start = Math.max(0, idx - 30);
    const end = Math.min(content.length, idx + query.length + 50);
    return (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
  }

  // Save pure binary asset (Blob/File/Uint8Array) and return relative physical path
  async function saveAsset(blobData, filenameOrExt = 'png') {
    if (!blobData) {
      throw new Error('saveAsset failed: blobData is required');
    }

    let relativePath;
    if (typeof filenameOrExt === 'string' && filenameOrExt.includes('.')) {
      const cleanName = filenameOrExt.replace(/^[./\\]+/, '').replace(/^assets\//, '');
      relativePath = `assets/${cleanName}`;
    } else {
      const ext = (typeof filenameOrExt === 'string' ? filenameOrExt : 'png').replace(/^\./, '') || 'png';
      const cleanId = generateId('img_');
      relativePath = `assets/${cleanId}.${ext}`;
    }

    let blob = blobData;
    if (blobData instanceof Uint8Array || blobData instanceof ArrayBuffer) {
      blob = new Blob([blobData]);
    }

    await db.assets.put({ id: relativePath, data: blob });
    return relativePath;
  }

  // Recognize a local asset reference (assets/..., ./assets/..., local://...)
  function isLocalAssetRef(ref) {
    return typeof ref === 'string' && /^(?:\.\/)?assets\/|^local:\/\//.test(ref);
  }

  // Strip local asset ref prefixes (local://, ./, assets/) down to the bare filename
  function normalizeAssetPath(ref) {
    return (ref || '').replace(/^local:\/\//, '').replace(/^\.\//, '').replace(/^assets\//, '');
  }

  async function getAsset(assetPathOrId) {
    if (!assetPathOrId) return null;
    const bareName = normalizeAssetPath(assetPathOrId);
    let record = await db.assets.get(`assets/${bareName}`);
    if (!record) {
      record = await db.assets.get(bareName);
    }
    return record ? record.data : null;
  }

  return {
    db,
    init,
    generateId,
    getFolders, createFolder, renameFolder, deleteFolder,
    getDocMeta, getDocContent, createDoc, updateDocContent, updateDocMeta, deleteDoc, toggleBookmark,
    getHighlights, addHighlight, removeHighlight,
    searchDocs,
    saveAsset, getAsset, isLocalAssetRef, normalizeAssetPath
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
        let deleteBtnArmed = false;
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!deleteBtnArmed) {
            deleteBtnArmed = true;
            deleteBtn.style.color = '#ef4444'; // Turn red to arm
            deleteBtn.style.fontWeight = 'bold';
            return;
          }
          try {
            await Storage.deleteFolder(folder.id);
            _collapsedFolders.delete(folder.id);
            saveCollapsed();
            render();
          } catch (err) {
            console.error('Failed to delete folder', err);
          }
        });
        deleteBtn.addEventListener('mouseleave', () => {
          if (deleteBtnArmed) {
            deleteBtnArmed = false;
            deleteBtn.style.color = '';
            deleteBtn.style.fontWeight = '';
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
        let deleteDocArmed = false;
        deleteDoc.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!deleteDocArmed) {
            deleteDocArmed = true;
            deleteDoc.style.color = '#ef4444'; // Turn red to arm
            deleteDoc.style.fontWeight = 'bold';
            return;
          }
          try {
            await Storage.deleteDoc(doc.id);
            render();
            // If the deleted document is the currently opened one, switch back to blank state
            if (_activeDocId === doc.id && _onSelectDocCallback) {
              _onSelectDocCallback(null);
            }
          } catch (err) {
            console.error('Failed to delete document', err);
          }
        });
        deleteDoc.addEventListener('mouseleave', () => {
          if (deleteDocArmed) {
            deleteDocArmed = false;
            deleteDoc.style.color = '';
            deleteDoc.style.fontWeight = '';
          }
        });

        const bookmarkDoc = document.createElement('button');
        bookmarkDoc.className = 'icon-btn';
        bookmarkDoc.title = 'Toggle Bookmark';
        bookmarkDoc.textContent = doc.isBookmarked ? '★' : '☆';
        if (doc.isBookmarked) {
          bookmarkDoc.style.color = '#e0a800';
        }
        bookmarkDoc.addEventListener('click', async (e) => {
          e.stopPropagation();
          await Storage.toggleBookmark(doc.id);
          render();
        });

        actions.appendChild(bookmarkDoc);
        actions.appendChild(deleteDoc);

        docEl.appendChild(icon);
        docEl.appendChild(titleSpan);
        docEl.appendChild(actions);

        // Hover to show/hide action bar
        docEl.addEventListener('mouseenter', () => { actions.style.display = 'flex'; });
        docEl.addEventListener('mouseleave', () => { actions.style.display = 'none'; });

        // Click to open document, click again to rename
        docEl.addEventListener('click', async (e) => {
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
// Powered by CodeMirror 6: Markdown syntax highlighting, line numbers, line wrapping, history, keymaps, and toolbar integration

const Editor = (() => {
  let _view = null;
  let _container = null;
  let _onChangeCallback = null;
  let _onSelectionChangeCallback = null;
  let _isSettingContent = false;
  let _wrapCompartment = null;

  // Initialize editor configuration
  function init(options) {
    _container = document.getElementById('editorContainer');
    if (!_container) {
      throw new Error('Fail-Fast: #editorContainer DOM element not found');
    }
    if (typeof CodeMirror6 === 'undefined') {
      throw new Error('Fail-Fast: CodeMirror6 library bundle is not loaded');
    }

    options = (options && typeof options === 'object') ? options : {};
    _onChangeCallback = options.onChange;
    _onSelectionChangeCallback = options.onSelectionChange;

    const {
      EditorView,
      EditorState,
      Compartment,
      basicSetup,
      markdown,
      autocompletion,
      snippet,
      indentWithTab,
      keymap,
      placeholder
    } = CodeMirror6;

    _wrapCompartment = new Compartment();

    // 1. Custom keybindings for Markdown shortcuts (Ctrl/Cmd+B, Ctrl/Cmd+I, Ctrl/Cmd+K)
    const customMarkdownKeymap = [
      {
        key: 'Mod-b',
        run: () => {
          insertFormat('**', '**', 'Bold Text');
          return true;
        }
      },
      {
        key: 'Mod-i',
        run: () => {
          insertFormat('*', '*', 'Italic Text');
          return true;
        }
      },
      {
        key: 'Mod-k',
        run: () => {
          const sel = getSelectedText();
          insertFormat('[', '](url)', sel || 'Link Name');
          return true;
        }
      }
    ];

    // 2. Markdown Slash Commands & Snippet Completion (/table, /math, /code, /quote, /task)
    const markdownSnippets = [
      {
        label: '/table',
        detail: 'Markdown Table',
        type: 'keyword',
        apply: snippet ? snippet('| Header 1 | Header 2 |\n|---|---|\n| ${1:Cell 1} | ${2:Cell 2} |') : '| Header 1 | Header 2 |\n|---|---|\n| Cell 1 | Cell 2 |'
      },
      {
        label: '/math',
        detail: 'LaTeX Block Formula',
        type: 'keyword',
        apply: snippet ? snippet('$$\n${1:f(x) = x^2}\n$$') : '$$\nf(x) = x^2\n$$'
      },
      {
        label: '/code',
        detail: 'Code Block',
        type: 'keyword',
        apply: snippet ? snippet('```${1:javascript}\n${2:// code}\n```') : '```javascript\n// code\n```'
      },
      {
        label: '/quote',
        detail: 'Blockquote',
        type: 'keyword',
        apply: snippet ? snippet('> ${1:Quote text}') : '> Quote text'
      },
      {
        label: '/task',
        detail: 'Task Checklist Item',
        type: 'keyword',
        apply: snippet ? snippet('- [ ] ${1:Task item}') : '- [ ] Task item'
      }
    ];

    const slashCommandsExtension = autocompletion ? autocompletion({
      override: [
        (context) => {
          const match = context.matchBefore(/\/\w*/);
          if (!match) return null;
          if (match.from === match.to && !context.explicit) return null;
          return {
            from: match.from,
            options: markdownSnippets
          };
        }
      ]
    }) : [];

    // 3. Document change listener
    const changeListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        if (!_isSettingContent && _onChangeCallback) {
          _onChangeCallback(getContent());
        }
      }
      if (update.selectionSet && _onSelectionChangeCallback) {
        // Debounce or directly call
        _onSelectionChangeCallback(update.state);
      }
    });

    // 4. Native DOM event handlers for drag/drop and paste
    const domHandlers = EditorView.domEventHandlers({
      dragover(e) {
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
        }
      },
      drop(e, view) {
        if (options && options.onDrop) {
          return options.onDrop(e, view);
        }
        return false;
      },
      paste(e, view) {
        if (options && options.onPaste) {
          return options.onPaste(e, view);
        }
        return false;
      }
    });

    const startState = EditorState.create({
      doc: '',
      extensions: [
        // basicSetup already provides bracketMatching, closeBrackets, foldGutter,
        // highlightSelectionMatches, autocompletion, history, and the default/search/history/
        // fold/closeBrackets keymaps — only genuinely additional extensions belong below.
        basicSetup,
        markdown(),
        _wrapCompartment.of(EditorView.lineWrapping),
        slashCommandsExtension,
        placeholder('Start writing Markdown... (type / for snippets)'),
        keymap.of([
          ...customMarkdownKeymap,
          indentWithTab
        ]),
        domHandlers,
        changeListener
      ]
    });

    _view = new EditorView({
      state: startState,
      parent: _container
    });

    // Bind toolbar formatting button events
    bindToolbarButtons();
  }

  // Get selected text
  function getSelectedText() {
    if (!_view) return '';
    const state = _view.state;
    const { from, to } = state.selection.main;
    return state.sliceDoc(from, to);
  }

  // Insert formatted Markdown marks at cursor or around selection
  function insertFormat(prefix, suffix, defaultText = '') {
    if (typeof prefix !== 'string' || typeof suffix !== 'string') {
      throw new TypeError('Fail-Fast: prefix and suffix must be strings');
    }
    if (!_view) return;

    const state = _view.state;
    const { from, to } = state.selection.main;
    const selectionText = state.sliceDoc(from, to);
    const contentToInsert = selectionText || defaultText;
    const insertion = prefix + contentToInsert + suffix;

    _view.dispatch({
      changes: { from, to, insert: insertion },
      selection: {
        anchor: from + prefix.length,
        head: selectionText ? from + prefix.length + selectionText.length : from + prefix.length + defaultText.length
      }
    });

    _view.focus();
    if (_onChangeCallback) _onChangeCallback(getContent());
  }

  // Insert text at specific position or current cursor
  function insertText(text, pos = null) {
    if (typeof text !== 'string') {
      throw new TypeError('Fail-Fast: text must be a string');
    }
    if (!_view) return;
    const insertPos = (typeof pos === 'number' && pos >= 0) ? pos : _view.state.selection.main.from;
    _view.dispatch({
      changes: { from: insertPos, insert: text },
      selection: { anchor: insertPos + text.length }
    });
    _view.focus();
    if (_onChangeCallback) _onChangeCallback(getContent());
  }

  // AST-based Headings / TOC inspection utility
  function getHeadings() {
    if (!_view) return [];
    const { syntaxTree } = CodeMirror6;
    if (!syntaxTree) return [];

    const headings = [];
    const state = _view.state;
    const tree = syntaxTree(state);

    tree.iterate({
      enter: (node) => {
        if (node.name.startsWith('ATXHeading')) {
          const level = parseInt(node.name.replace('ATXHeading', ''), 10) || 1;
          const raw = state.sliceDoc(node.from, node.to);
          const text = raw.replace(/^#+\s*/, '').trim();
          headings.push({ level, text, from: node.from, to: node.to });
        }
      }
    });
    return headings;
  }

  // Markdown syntax nodes that carry no rendered text: the delimiters themselves (**, *, `, #,
  // >, -), plus link targets which become attributes rather than visible text.
  const MARKUP_NODE_RE = /Mark$|^URL$|^LinkTitle$|^CodeInfo$/;

  // Build the source <-> rendered character map for a source range, using CodeMirror's own
  // Markdown syntax tree to decide which characters survive into the rendered output.
  // Returns { rendered, srcToRen, renToSrc } where the maps hold character offsets relative
  // to `from` (source) and to the start of `rendered`.
  function mapBlock(from, to) {
    if (!_view) return null;
    const { syntaxTree } = CodeMirror6;
    if (!syntaxTree) return null;

    const state = _view.state;
    const doc = state.doc.toString();
    to = Math.min(to, doc.length);
    if (from >= to) return null;

    // Collect markup spans, then merge them so nested marks can't double-count
    const skips = [];
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (MARKUP_NODE_RE.test(node.name)) skips.push([node.from, node.to]);
      }
    });
    skips.sort((a, b) => a[0] - b[0]);

    let rendered = '';
    const srcToRen = new Map();
    const renToSrc = new Map();
    let pos = from;

    const emit = (until) => {
      for (let i = pos; i < until; i++) {
        srcToRen.set(i, rendered.length);
        renToSrc.set(rendered.length, i);
        rendered += doc[i];
      }
    };

    for (const [s, e] of skips) {
      if (s > pos) emit(s);
      pos = Math.max(pos, e);
    }
    emit(to);

    return { rendered, srcToRen, renToSrc };
  }

  // Dynamic Word Wrap Configuration
  function setWordWrap(enabled) {
    if (!_view || !_wrapCompartment) return;
    const { EditorView } = CodeMirror6;
    _view.dispatch({
      effects: _wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : [])
    });
  }

  // Bind events to toolbar buttons
  function bindToolbarButtons() {
    const boldBtn = document.getElementById('boldBtn');
    const italicBtn = document.getElementById('italicBtn');
    const codeBtn = document.getElementById('codeBtn');
    const linkBtn = document.getElementById('linkBtn');
    const latexBtn = document.getElementById('latexBtn');

    if (boldBtn) boldBtn.addEventListener('click', () => insertFormat('**', '**', 'Bold Text'));
    if (italicBtn) italicBtn.addEventListener('click', () => insertFormat('*', '*', 'Italic Text'));
    if (codeBtn) {
      codeBtn.addEventListener('click', () => {
        const sel = getSelectedText();
        if (sel.includes('\n')) {
          insertFormat('```javascript\n', '\n```', 'console.log("Hello World");');
        } else {
          insertFormat('`', '`', 'code');
        }
      });
    }
    if (linkBtn) {
      linkBtn.addEventListener('click', () => {
        const sel = getSelectedText();
        if (sel.startsWith('http://') || sel.startsWith('https://')) {
          insertFormat('[Link Text](', ')', sel);
        } else {
          insertFormat('[', '](https://example.com)', sel || 'Link Name');
        }
      });
    }
    if (latexBtn) {
      latexBtn.addEventListener('click', () => {
        const sel = getSelectedText();
        if (sel.includes('\n')) {
          insertFormat('$$\n', '\n$$', 'E = mc^2');
        } else {
          insertFormat('$', '$', 'f(x) = x^2');
        }
      });
    }
  }

  // Set editor content
  function setContent(content) {
    if (typeof content !== 'string') {
      content = (content === null || content === undefined) ? '' : String(content);
    }
    if (!_view) return;
    const currentContent = getContent();
    if (currentContent === content) return;

    _isSettingContent = true;
    try {
      _view.dispatch({
        changes: { from: 0, to: _view.state.doc.length, insert: content }
      });
    } finally {
      _isSettingContent = false;
    }
  }

  // Get editor content
  function getContent() {
    return _view ? _view.state.doc.toString() : '';
  }

  // Focus editor
  function focus() {
    if (_view) _view.focus();
  }

  // Get EditorView instance
  function getView() {
    return _view;
  }

  // Compatibility helpers
  function updateLineNumbers() {
    if (_view) _view.requestMeasure();
  }

  // Set selection given anchor and head
  function setSelection(anchor, head) {
    if (!_view) return;
    _view.dispatch({
      selection: { anchor, head },
      effects: CodeMirror6.EditorView.scrollIntoView(anchor, { y: 'center' })
    });
  }

  return {
    init,
    setContent,
    getContent,
    insertFormat,
    insertText,
    getHeadings,
    setWordWrap,
    focus,
    getView,
    updateLineNumbers,
    setSelection,
    mapBlock
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


// sync-guard.js — Single suppression gate for editor/preview cross-syncing
// Any programmatic scroll or selection is wrapped in SyncGuard.run(origin, fn); handlers on the
// opposite side consult SyncGuard.isBusy() to avoid echoing a sync back at its own source.
const SyncGuard = (() => {
  let _origin = null;
  let _timer = null;

  // Mark `origin` as driving a sync for the duration of fn plus a short settle window.
  // DOM selectionchange/scroll events are delivered asynchronously, so the window has to
  // outlive the call itself.
  function run(origin, fn, settleMs = 120) {
    _origin = origin;
    clearTimeout(_timer);
    try {
      return fn();
    } finally {
      _timer = setTimeout(() => { _origin = null; }, settleMs);
    }
  }

  // True when a sync is in flight from an origin other than the caller's
  function isBusy(exceptOrigin = null) {
    return _origin !== null && _origin !== exceptOrigin;
  }

  function clear() {
    clearTimeout(_timer);
    _origin = null;
  }

  return { run, isBusy, clear };
})();


// block-map.js — Addresses preview text by block anchor + character offset
// The `.sync-marker` spans injected during render carry data-line; every position used by the
// highlight and selection-sync features is expressed relative to the block that owns one,
// rather than by searching for text strings (which breaks across inline elements).
const BlockMap = (() => {
  // Resolve the block element owning `node`, i.e. the ancestor that directly contains a
  // .sync-marker. Returns { blockEl, line } or null.
  function getBlock(node) {
    const mdBody = document.getElementById('mdBody');
    if (!node || !mdBody || !mdBody.contains(node)) return null;

    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== mdBody) {
      const marker = el.querySelector(':scope > .sync-marker');
      if (marker) {
        const line = parseInt(marker.dataset.line, 10);
        if (!isNaN(line)) return { blockEl: el, line };
      }
      el = el.parentElement;
    }
    return null;
  }

  // Find the block element carrying a given data-line value
  function getBlockByLine(line) {
    const mdBody = document.getElementById('mdBody');
    if (!mdBody) return null;
    const marker = mdBody.querySelector(`.sync-marker[data-line="${line}"]`);
    return marker ? marker.parentElement : null;
  }

  // Ordered list of text nodes inside a block, paired with their running offset within
  // blockEl.textContent. The marker span holds no text, so it contributes nothing.
  function textNodesOf(blockEl) {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let offset = 0;
    let node;
    while (node = walker.nextNode()) {
      const len = node.nodeValue.length;
      nodes.push({ node, start: offset, end: offset + len });
      offset += len;
    }
    return nodes;
  }

  // Character offset of (node, offset) within blockEl.textContent.
  // Measured with a Range so it works whether the boundary sits in a text node or on an
  // element (selectNodeContents, double-click and cross-element selections all produce the
  // latter). The zero-width .sync-marker span contributes no text, so offsets stay aligned
  // with textContent.
  function offsetInBlock(blockEl, node, offset) {
    if (!blockEl || !node || !blockEl.contains(node)) return -1;
    try {
      const range = document.createRange();
      range.setStart(blockEl, 0);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch (e) {
      return -1;
    }
  }

  // Build a DOM Range spanning [start, end) of blockEl.textContent
  function rangeFromOffsets(blockEl, start, end) {
    const entries = textNodesOf(blockEl);
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;

    for (const entry of entries) {
      if (!startNode && entry.end > start) {
        startNode = entry.node;
        startOffset = start - entry.start;
      }
      if (startNode && entry.end >= end) {
        endNode = entry.node;
        endOffset = end - entry.start;
        break;
      }
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, startOffset));
    range.setEnd(endNode, Math.max(0, endOffset));
    return range;
  }

  // Text-node slices covered by [start, end). Each slice can be wrapped independently, which
  // is what lets a highlight survive crossing <strong>/<em>/<a> boundaries — a single
  // range.surroundContents() would throw on those partially-selected elements.
  function segmentsInRange(blockEl, start, end) {
    const segments = [];
    for (const entry of textNodesOf(blockEl)) {
      const from = Math.max(start, entry.start);
      const to = Math.min(end, entry.end);
      if (from < to) {
        segments.push({ node: entry.node, from: from - entry.start, to: to - entry.start });
      }
    }
    return segments;
  }

  return { getBlock, getBlockByLine, textNodesOf, offsetInBlock, rangeFromOffsets, segmentsInRange };
})();


// highlight.js — Selected text highlighting component
// Responsible for capturing selection range in the preview panel, positioning popup bubbles, saving highlight data, safely replacing rendering highlight effects via DOM, and clicking to undo

const Highlight = (() => {
  let _bubble = null;
  let _activeDocId = null;
  let _onHighlightChangedCallback = null;
  // Highlights for the active doc, cached so re-rendering on every keystroke costs no I/O
  let _cache = [];

  // Initialize highlight module, bind selection events and color buttons
  function init(onHighlightChanged) {
    _bubble = document.getElementById('highlightBubble');
    _onHighlightChangedCallback = onHighlightChanged;

    if (!_bubble) return;

    document.addEventListener('selectionchange', handleSelectionChange);

    // Dismiss on a click that starts outside the bubble, and whenever the preview scrolls —
    // the bubble is pinned to viewport coordinates and would otherwise detach from its text.
    document.addEventListener('mousedown', (e) => {
      if (!_bubble.contains(e.target)) hideBubble();
    });
    const previewPane = document.getElementById('previewPane');
    if (previewPane) {
      previewPane.addEventListener('scroll', hideBubble);
    }

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
      mdBody.addEventListener('dblclick', handleDeleteHighlightDblClick);
    }
  }

  // Bind currently selected document ID
  async function setActiveDoc(docId) {
    _activeDocId = docId;
    hideBubble();
    _cache = docId ? await Storage.getHighlights(docId) : [];
  }

  // Get and display selection position
  function handleSelectionChange() {
    if (!_activeDocId) return;

    // A selection mirrored in from the editor is not a user gesture — don't offer to highlight it
    if (SyncGuard.isBusy('preview')) {
      hideBubble();
      return;
    }

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

    // getBoundingClientRect is already viewport-relative and the bubble is position:fixed,
    // so no scroll offsets are involved — this is what keeps it attached while #previewPane scrolls.
    const rect = range.getBoundingClientRect();
    _bubble.classList.remove('hidden');

    const left = rect.left + (rect.width / 2) - (_bubble.offsetWidth / 2);
    let top = rect.top - _bubble.offsetHeight - 8;
    // Selection near the top of the viewport: flip below rather than render off-screen
    if (top < 4) top = rect.bottom + 8;

    const maxLeft = window.innerWidth - _bubble.offsetWidth - 4;
    _bubble.style.left = `${Math.max(4, Math.min(left, maxLeft))}px`;
    _bubble.style.top = `${top}px`;
  }

  // Hide highlight bubble
  function hideBubble() {
    if (_bubble) {
      _bubble.classList.add('hidden');
    }
  }

  // Confirm highlight selection, write to storage.
  // Stored as a block anchor (data-line) plus character offsets within that block's rendered
  // text, so the highlight can be replayed exactly rather than searched for.
  async function applySelectedHighlight(color) {
    if (!_activeDocId) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const text = selection.toString();
    if (!text.trim()) return;

    const range = selection.getRangeAt(0);
    const block = BlockMap.getBlock(range.startContainer);
    if (!block) return;

    const start = BlockMap.offsetInBlock(block.blockEl, range.startContainer, range.startOffset);
    let end;
    if (BlockMap.getBlock(range.endContainer)?.blockEl === block.blockEl) {
      end = BlockMap.offsetInBlock(block.blockEl, range.endContainer, range.endOffset);
    } else {
      // Selection ran past this block; clamp to the end of the anchor block
      end = start + text.length;
    }

    if (start < 0 || end <= start) return;

    const highlight = {
      line: block.line,
      start,
      end,
      text: block.blockEl.textContent.slice(start, end),
      color: color,
      createdAt: Date.now()
    };

    const saved = await Storage.addHighlight(_activeDocId, highlight);
    _cache.push(saved);

    // Clear browser selection
    selection.removeAllRanges();
    hideBubble();

    // Notify rendering update
    if (_onHighlightChangedCallback) {
      _onHighlightChangedCallback();
    }
  }

  // Render highlights by replaying stored block+offset anchors.
  // Each stored range is redrawn by wrapping every text-node slice it covers in its own <mark>,
  // which is what allows a highlight spanning <strong>/<em>/<a> to survive a re-render.
  function applyHighlightsToDOM(container) {
    if (!_activeDocId || !container || _cache.length === 0) return;

    // Group by block so each block's offsets are resolved against one stable textContent
    const byLine = new Map();
    for (const hl of _cache) {
      if (hl.start === undefined) continue;
      if (!byLine.has(hl.line)) byLine.set(hl.line, []);
      byLine.get(hl.line).push(hl);
    }

    for (const [line, hls] of byLine) {
      const blockEl = BlockMap.getBlockByLine(line);
      if (!blockEl) continue;

      const blockText = blockEl.textContent;
      const resolved = [];

      for (const hl of hls) {
        let { start, end } = hl;

        // Offsets drift when the block is edited. Repair by searching for the stored text,
        // scoped to this block only — never document-wide, which is what produced spurious
        // marks on unrelated duplicate text before.
        if (blockText.slice(start, end) !== hl.text) {
          const idx = blockText.indexOf(hl.text);
          if (idx === -1) continue;
          start = idx;
          end = idx + hl.text.length;
        }
        resolved.push({ hl, start, end });
      }

      // Wrap back-to-front: replacing a text node invalidates the offsets of everything after it
      resolved.sort((a, b) => b.start - a.start);

      for (const { hl, start, end } of resolved) {
        const segments = BlockMap.segmentsInRange(blockEl, start, end);
        for (const seg of segments) {
          wrapTextSlice(seg.node, seg.from, seg.to, hl);
        }
      }
    }
  }

  // Wrap [from, to) of a single text node in a <mark>, splitting the node as needed
  function wrapTextSlice(node, from, to, hl) {
    if (!node.parentNode || from >= to) return;
    // Never mark inside code or links — matches the exclusions the previous renderer applied
    const parent = node.parentElement;
    if (!parent || parent.closest('pre, code, a')) return;

    const target = from > 0 ? node.splitText(from) : node;
    if (to - from < target.nodeValue.length) target.splitText(to - from);

    const mark = document.createElement('mark');
    mark.className = `hl-${hl.color}`;
    mark.dataset.hlId = hl.id;
    target.parentNode.replaceChild(mark, target);
    mark.appendChild(target);
  }

  // Double click highlight tag to delete highlight mark
  async function handleDeleteHighlightDblClick(e) {
    const mark = e.target.closest('mark[data-hl-id]');
    if (!mark || !_activeDocId) return;

    e.stopPropagation();
    const hlId = mark.dataset.hlId;
    await Storage.removeHighlight(_activeDocId, hlId);
    _cache = _cache.filter(h => h.id !== hlId);

    // Notify rendering update
    if (_onHighlightChangedCallback) {
      _onHighlightChangedCallback();
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
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

  function initScrollSync() {
    const editorScrollDOM = Editor.getView()?.scrollDOM;
    const previewPane = dom.previewPane;

    if (!editorScrollDOM || !previewPane) return;

    editorScrollDOM.addEventListener('scroll', () => {
      if (SyncGuard.isBusy('editor')) return;

      const view = Editor.getView();
      if (!view) return;

      const topInfo = view.lineBlockAtHeight(editorScrollDOM.scrollTop);
      const docPos = topInfo.from;
      const line = view.state.doc.lineAt(docPos).number;

      SyncGuard.run('editor', () => scrollToPreviewLine(line), 60);
    });

    previewPane.addEventListener('scroll', () => {
      if (SyncGuard.isBusy('preview')) return;

      const marker = getTopmostVisibleMarker(previewPane);
      if (marker) {
        const line = parseInt(marker.dataset.line, 10);
        if (!isNaN(line)) {
          SyncGuard.run('preview', () => scrollToEditorLine(line), 60);
        }
      }
    });

    // Preview to Editor selection sync
    document.addEventListener('selectionchange', handlePreviewSelectionChange);
  }

  // Mirror a preview selection back into the editor by mapping rendered offsets to source
  // offsets through CodeMirror's syntax tree, anchored on the block that owns the selection.
  function handlePreviewSelectionChange() {
    if (!_activeDocId || SyncGuard.isBusy('preview')) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!dom.mdBody.contains(range.commonAncestorContainer)) return;

    const view = Editor.getView();
    if (!view) return;

    const startBlock = BlockMap.getBlock(range.startContainer);
    const endBlock = BlockMap.getBlock(range.endContainer);
    if (!startBlock) return;

    // KaTeX output is regenerated rather than passed through, so its rendered text does not
    // align with the source-derived map. Skip instead of mis-mapping.
    if (startBlock.blockEl.querySelector('.katex')) return;

    const startSrc = sourceOffsetFor(startBlock, range.startContainer, range.startOffset);
    if (startSrc === null) return;

    let endSrc;
    if (endBlock && endBlock.blockEl === startBlock.blockEl) {
      endSrc = sourceOffsetFor(startBlock, range.endContainer, range.endOffset, true);
    } else if (endBlock) {
      // Multi-block selection: anchor the tail in its own block
      endSrc = sourceOffsetFor(endBlock, range.endContainer, range.endOffset, true);
    }
    if (endSrc === null || endSrc === undefined || endSrc <= startSrc) return;

    SyncGuard.run('preview', () => Editor.setSelection(startSrc, endSrc));
  }

  // Translate a (node, offset) position inside a rendered block into a source document offset.
  //
  // Start and end boundaries are not symmetric. A start maps to where its character begins; an
  // end must map to just past the last *included* character, otherwise the trailing markup
  // (the closing ** of **bold**) gets swallowed into the selection.
  function sourceOffsetFor(block, node, offset, isEnd = false) {
    const view = Editor.getView();
    if (!view) return null;

    const renderedOffset = BlockMap.offsetInBlock(block.blockEl, node, offset);
    if (renderedOffset < 0) return null;

    const map = mapForBlock(block);
    if (!map) return null;

    if (isEnd) {
      // Last rendered character inside the selection, then step past it
      for (let i = renderedOffset - 1; i >= 0; i--) {
        if (map.renToSrc.has(i)) return map.renToSrc.get(i) + 1;
      }
      return map.from;
    }

    // First rendered character at or after the boundary
    for (let i = renderedOffset; i <= map.rendered.length; i++) {
      if (map.renToSrc.has(i)) return map.renToSrc.get(i);
    }
    return map.from;
  }

  // Build the source<->rendered map for a block, and verify the block really owns that source
  // range before trusting it.
  //
  // Not every block type gets a .sync-marker (tables, fenced code, hr and raw html have none),
  // so an anchor can end up covering source text that belongs to a *later* unanchored block.
  // Comparing the map's reconstructed text against what the block actually renders catches
  // every such mismatch at once, which is far more robust than trying to emit a marker for
  // each remaining block type.
  function mapForBlock(block) {
    const span = sourceRangeOfLine(block.line);
    if (!span) return null;

    const map = Editor.mapBlock(span.from, span.to);
    if (!map) return null;

    const normalize = (s) => s.replace(/\s+/g, ' ').trim();
    const fromSource = normalize(map.rendered);
    const fromDom = normalize(block.blockEl.textContent);

    // The anchor is only trustworthy when the block renders what its source range says it should
    if (!fromSource.startsWith(fromDom) && !fromDom.startsWith(fromSource)) return null;

    map.from = span.from;
    return map;
  }

  // Source character range covered by the block anchored at `line`, ending where the next
  // anchored block begins.
  function sourceRangeOfLine(line) {
    const view = Editor.getView();
    if (!view) return null;
    const doc = view.state.doc;
    if (line < 1 || line > doc.lines) return null;

    const from = doc.line(line).from;

    // The next marker's line bounds this block
    let nextLine = null;
    for (const marker of getSyncMarkers()) {
      const l = parseInt(marker.dataset.line, 10);
      if (!isNaN(l) && l > line && (nextLine === null || l < nextLine)) nextLine = l;
    }

    const to = (nextLine !== null && nextLine <= doc.lines)
      ? doc.line(nextLine).from
      : doc.length;

    return { from, to };
  }

  function getSyncMarkers() {
    return Array.from(dom.mdBody.querySelectorAll('.sync-marker'));
  }

  function scrollToPreviewLine(line) {
    const markers = getSyncMarkers();
    let bestMarker = null;
    let minDiff = Infinity;
    for (const marker of markers) {
      const markerLine = parseInt(marker.dataset.line, 10);
      if (markerLine === line) {
        bestMarker = marker;
        break;
      } else if (markerLine < line && (line - markerLine < minDiff)) {
        minDiff = line - markerLine;
        bestMarker = marker;
      }
    }
    
    if (bestMarker) {
      const parent = bestMarker.parentElement;
      if (parent) {
        dom.previewPane.scrollTop = parent.offsetTop - 20;
      }
    }
  }

  function getTopmostVisibleMarker(container) {
    const markers = getSyncMarkers();
    const scrollTop = container.scrollTop;

    let bestMarker = null;
    for (const marker of markers) {
      const parent = marker.parentElement;
      if (parent && parent.offsetTop >= scrollTop + 20) {
        return bestMarker || marker;
      }
      bestMarker = marker;
    }
    return bestMarker;
  }

  function scrollToEditorLine(line) {
    const view = Editor.getView();
    if (!view) return;
    const doc = view.state.doc;
    if (line >= 1 && line <= doc.lines) {
      const lineInfo = doc.line(line);
      const top = view.lineBlockAt(lineInfo.from).top;
      view.scrollDOM.scrollTop = top;
    }
  }

  // Mirror an editor selection into the preview by mapping source offsets to rendered offsets
  // through CodeMirror's syntax tree, so markup characters (**, [](), `, #) are handled instead
  // of breaking the match the way a raw text search did.
  function handleEditorSelectionChange(state) {
    if (!_activeDocId || SyncGuard.isBusy('editor')) return;

    const { from, to } = state.selection.main;
    if (from === to) return;

    const text = state.sliceDoc(from, to);
    if (!text || text.trim() === '') return;

    const startLine = state.doc.lineAt(from).number;
    const endLine = state.doc.lineAt(to).number;

    const startBlock = blockForLine(startLine);
    if (!startBlock) return;
    if (startBlock.blockEl.querySelector('.katex')) return;

    const startOffset = renderedOffsetFor(startBlock, from);
    if (startOffset === null) return;

    // A selection running past this block ends at the tail of its own block
    const endBlock = (endLine === startLine) ? startBlock : (blockForLine(endLine) || startBlock);
    const endOffset = (endBlock.blockEl === startBlock.blockEl)
      ? renderedOffsetFor(startBlock, to, true)
      : endBlock.blockEl.textContent.length;

    if (endOffset === null || endOffset <= startOffset) return;

    const range = (endBlock.blockEl === startBlock.blockEl)
      ? BlockMap.rangeFromOffsets(startBlock.blockEl, startOffset, endOffset)
      : spanningRange(startBlock.blockEl, startOffset, endBlock.blockEl, endOffset);
    if (!range) return;

    SyncGuard.run('editor', () => {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      dom.previewPane.scrollTop = startBlock.blockEl.offsetTop - 40;
    });
  }

  // Resolve the rendered block anchored at or immediately before `line`
  function blockForLine(line) {
    let best = null;
    let minDiff = Infinity;
    for (const marker of getSyncMarkers()) {
      const markerLine = parseInt(marker.dataset.line, 10);
      if (!isNaN(markerLine) && markerLine <= line && (line - markerLine) < minDiff) {
        minDiff = line - markerLine;
        best = { blockEl: marker.parentElement, line: markerLine };
      }
    }
    return (best && best.blockEl) ? best : null;
  }

  // Translate a source document offset into an offset within a rendered block's text
  // Inverse of sourceOffsetFor, with the same start/end asymmetry: a source position sitting
  // inside markup (between the asterisks of **) has no rendered counterpart, so a start scans
  // forward to the first rendered character and an end scans back to the last included one.
  function renderedOffsetFor(block, sourcePos, isEnd = false) {
    const map = mapForBlock(block);
    if (!map) return null;

    if (isEnd) {
      for (let i = sourcePos - 1; i >= map.from; i--) {
        if (map.srcToRen.has(i)) return map.srcToRen.get(i) + 1;
      }
      return 0;
    }

    const limit = map.from + map.rendered.length + (sourcePos - map.from);
    for (let i = sourcePos; i <= limit; i++) {
      if (map.srcToRen.has(i)) return map.srcToRen.get(i);
    }
    return 0;
  }

  // Range spanning from an offset in one block to an offset in a later block
  function spanningRange(startEl, startOffset, endEl, endOffset) {
    const head = BlockMap.rangeFromOffsets(startEl, startOffset, startEl.textContent.length);
    const tail = BlockMap.rangeFromOffsets(endEl, 0, endOffset);
    if (!head || !tail) return null;

    const range = document.createRange();
    range.setStart(head.startContainer, head.startOffset);
    range.setEnd(tail.endContainer, tail.endOffset);
    return range;
  }

  // DOM Element References
  const dom = {
    sidebar: document.getElementById('sidebar'),
    splitContainer: document.getElementById('splitContainer'),
    editorPane: document.getElementById('editorPane'),
    editorContainer: document.getElementById('editorContainer'),
    paneResizer: document.getElementById('paneResizer'),
    previewPane: document.getElementById('previewPane'),
    emptyState: document.getElementById('emptyState'),
    mdBody: document.getElementById('mdBody'),
    docTitleInput: document.getElementById('docTitleInput'),
    toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
    newDocBtn: document.getElementById('newDocBtn'),
    newFolderBtn: document.getElementById('newFolderBtn'),
    importBtn: document.getElementById('importBtn'),
    fileInput: document.getElementById('fileInput'),
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
    Editor.init({
      onChange: onContentChange,
      onSelectionChange: handleEditorSelectionChange,
      onDrop: handleEditorDrop,
      onPaste: handleEditorPaste
    });
    Search.init(loadDocument);
    Highlight.init(onHighlightChanged);

    // 3. Bind top toolbar global events & pane resizer
    bindToolbarEvents();
    initSplitPaneResizer();

    // 4. Bind full-screen drag-and-drop import events
    bindDragAndDropEvents();

    // 5. Check auto import
    await checkAutoImport();

    // 6. Restore previous states (sidebar collapsed state, last opened document)
    restoreStates();

    // 7. Initialize Scroll Sync
    initScrollSync();
  }

  // Restore previous layout and document states
  function restoreStates() {
    // Restore sidebar state
    const isSidebarCollapsed = localStorage.getItem('mdm_sidebar_collapsed') === 'true';
    if (isSidebarCollapsed) {
      dom.sidebar.classList.add('collapsed');
    }

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
      // Show empty state, hide editor and resizer
      localStorage.removeItem('mdm_active_doc_id');
      dom.emptyState.classList.remove('hidden');
      dom.editorPane.classList.add('collapsed');
      if (dom.paneResizer) dom.paneResizer.classList.add('collapsed');
      dom.mdBody.textContent = '';
      dom.docTitleInput.value = '';

      // Update sub-states
      FolderTree.setActiveDoc(null);
      await Highlight.setActiveDoc(null);
      return;
    }

    localStorage.setItem('mdm_active_doc_id', docId);
    dom.emptyState.classList.add('hidden');
    dom.editorPane.classList.remove('collapsed');
    if (dom.paneResizer) dom.paneResizer.classList.remove('collapsed');

    const docMeta = Storage.getDocMeta()[docId];
    const content = await Storage.getDocContent(docId);

    if (!docMeta) return;

    // Fill title and body inputs
    dom.docTitleInput.value = docMeta.title;
    Editor.setContent(content);

    // Render preview
    renderMarkdown(content);

    // Apply and render highlight data (setActiveDoc warms the highlight cache)
    await Highlight.setActiveDoc(docId);
    Highlight.applyHighlightsToDOM(dom.mdBody);

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
      const newlines = (match.match(/\n/g) || []).length;
      return `%%LATEX_BLOCK_${idx}_NL_${newlines}%%`;
    });

    // Protect inline formulas $ ... $ (excluding double dollar signs)
    processed = processed.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (match, latex) => {
      const idx = latexBlocks.length;
      latexBlocks.push({ type: 'inline', latex: latex.trim() });
      const newlines = (match.match(/\n/g) || []).length;
      return `%%LATEX_INLINE_${idx}_NL_${newlines}%%`;
    });

    // 2. Use marked to parse Markdown into HTML tokens
    const options = {
      gfm: true,
      breaks: false,
    };
    const tokens = marked.lexer(processed, options);

    // Count source lines spanned by a raw token/item, including newlines swallowed by LaTeX placeholders
    function rawLineCount(raw) {
      const visibleLines = (raw.match(/\n/g) || []).length;
      const hiddenLines = [...raw.matchAll(/%%LATEX_(?:BLOCK|INLINE)_\d+_NL_(\d+)%%/g)].reduce((sum, m) => sum + parseInt(m[1]), 0);
      return visibleLines + hiddenLines;
    }

    // Inject source line markers for scroll synchronization
    function injectSourceLines(tokensList, startLine) {
      let line = startLine;
      for (const token of tokensList) {
        if (token.type === 'paragraph' || token.type === 'heading' || token.type === 'blockquote') {
          if (token.tokens) {
            token.tokens.unshift({
              type: 'html',
              raw: '',
              text: `<span data-line="${line}" class="sync-marker"></span>`
            });
          }
        } else if (token.type === 'list') {
          let listLine = line;
          for (const item of token.items) {
            if (item.tokens) {
              item.tokens.unshift({
                type: 'html',
                raw: '',
                text: `<span data-line="${listLine}" class="sync-marker"></span>`
              });
            }
            listLine += rawLineCount(item.raw);
          }
        }

        line += rawLineCount(token.raw);
      }
    }

    injectSourceLines(tokens, 1);
    const html = marked.parser(tokens, options);

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

      const placeholderRegexStr = item.type === 'block'
        ? `%%LATEX_BLOCK_${idx}_NL_\\d+%%`
        : `%%LATEX_INLINE_${idx}_NL_\\d+%%`;

      // Restore block formula placeholders wrapped in <p> tags
      finalHtml = finalHtml.replace(
        new RegExp(`<p>\\s*<span data-line="\\d+" class="sync-marker"><\\/span>\\s*${placeholderRegexStr}\\s*<\\/p>`, 'g'),
        (match) => {
          // Extract the injected span so we don't lose the scroll marker
          const spanMatch = match.match(/<span data-line="\d+" class="sync-marker"><\/span>/);
          const span = spanMatch ? spanMatch[0] : '';
          return item.type === 'block' ? `<div class="katex-display">${span}${rendered}</div>` : `${span}${rendered}`;
        }
      );
      
      finalHtml = finalHtml.replace(
        new RegExp(`<p>\\s*${placeholderRegexStr}\\s*<\\/p>`, 'g'),
        item.type === 'block' ? `<div class="katex-display">${rendered}</div>` : rendered
      );
      
      finalHtml = finalHtml.replace(
        new RegExp(placeholderRegexStr, 'g'),
        rendered
      );
    });

    const finalDoc = new DOMParser().parseFromString(finalHtml, "text/html");
    dom.mdBody.replaceChildren(...finalDoc.body.childNodes);

    // 4. Lazy-load local physical assets and attach info for interaction
    const images = dom.mdBody.querySelectorAll('img');
    images.forEach(async (img) => {
      const originalSrc = img.getAttribute('src') || '';
      img.dataset.mdSrc = originalSrc;
      img.dataset.mdAlt = img.getAttribute('alt') || '';

      // Tag images sitting in a paragraph that carries no prose, so they render as
      // centred blocks. textContent covers the .sync-marker span (always empty) and
      // any surrounding text, which CSS cannot distinguish. Images written on
      // consecutive lines share one paragraph, so this must not require a lone image.
      const holder = img.closest('p');
      if (holder && !holder.textContent.trim()) {
        img.classList.add('md-block-img');
        // The paragraph carries the page-break guard: see .md-figure in the print styles
        holder.classList.add('md-figure');
      }
      if (Storage.isLocalAssetRef(originalSrc)) {
        const blob = await Storage.getAsset(originalSrc);
        if (blob) {
          img.src = URL.createObjectURL(blob);
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
  function onHighlightChanged() {
    if (!_activeDocId) return;
    // Re-render preview body and apply highlight effects
    const content = Editor.getContent();
    renderMarkdown(content);
    Highlight.applyHighlightsToDOM(dom.mdBody);
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

  // Initialize draggable split-pane resizer (IDE-style)
  function initSplitPaneResizer() {
    if (!dom.paneResizer || !dom.editorPane || !dom.splitContainer) return;

    // Restore saved split ratio (percentage, default 50%)
    const savedRatio = parseFloat(localStorage.getItem('mdm_split_ratio')) || 50;
    const clampedRatio = Math.min(85, Math.max(15, savedRatio));
    dom.editorPane.style.width = `${clampedRatio}%`;

    let isDragging = false;

    const onPointerDown = (e) => {
      // Only primary mouse button (left button) or touch
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      isDragging = true;

      dom.paneResizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      if (dom.paneResizer.setPointerCapture && e.pointerId !== undefined) {
        try {
          dom.paneResizer.setPointerCapture(e.pointerId);
        } catch (_) { }
      }

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      e.preventDefault();

      const splitRect = dom.splitContainer.getBoundingClientRect();
      const containerWidth = splitRect.width;
      if (containerWidth <= 0) return;

      // Calculate exact mouse position relative to split-container left edge
      const exactOffset = e.clientX - splitRect.left;

      // Clamp editor width: min 180px, max (containerWidth - 180px)
      const minPx = Math.min(180, containerWidth * 0.15);
      const maxPx = Math.max(containerWidth - 180, containerWidth * 0.85);
      const clampedPx = Math.min(maxPx, Math.max(minPx, exactOffset));

      const percent = (clampedPx / containerWidth) * 100;
      dom.editorPane.style.width = `${percent}%`;

      // Live measure CodeMirror view layout
      Editor.updateLineNumbers();
    };

    const onPointerUp = (e) => {
      if (!isDragging) return;
      isDragging = false;

      dom.paneResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (dom.paneResizer.releasePointerCapture && e.pointerId !== undefined) {
        try {
          dom.paneResizer.releasePointerCapture(e.pointerId);
        } catch (_) { }
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      // Save ratio to storage
      const currentPercent = parseFloat(dom.editorPane.style.width) || 50;
      localStorage.setItem('mdm_split_ratio', currentPercent.toFixed(2));
      Editor.updateLineNumbers();
    };

    dom.paneResizer.addEventListener('pointerdown', onPointerDown);

    // Double click resizer to reset to 50:50
    dom.paneResizer.addEventListener('dblclick', () => {
      dom.editorPane.style.width = '50%';
      localStorage.setItem('mdm_split_ratio', '50');
      Editor.updateLineNumbers();
    });
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

    // Download MD file (Bundled into .7z archive if it contains local image assets)
    dom.downloadMdBtn.addEventListener('click', async () => {
      if (!_activeDocId) return;
      const docMeta = Storage.getDocMeta()[_activeDocId];
      if (!docMeta) return;

      const safeTitle = (docMeta.title || 'Document').replace(/[/\\?%*:|"<>]/g, '_');
      let content = Editor.getContent();

      // Find all local image asset references (e.g. assets/..., ./assets/..., local://...)
      const imgRegex = /!\[.*?\]\(((?:assets\/|\.\/assets\/|local:\/\/)[^)]+)\)|<img.*?src=["']((?:assets\/|\.\/assets\/|local:\/\/)[^"']+)["']/gi;
      const matches = [...content.matchAll(imgRegex)];
      const assetsToBundle = new Map();

      for (const match of matches) {
        const rawUri = match[1] || match[2];
        if (!rawUri) continue;

        const filename = Storage.normalizeAssetPath(rawUri);
        const targetRelativePath = `assets/${filename}`;

        // Normalize Markdown link to relative physical path
        if (rawUri !== targetRelativePath) {
          content = content.replaceAll(rawUri, targetRelativePath);
        }

        if (!assetsToBundle.has(targetRelativePath)) {
          const blob = await Storage.getAsset(rawUri);
          if (blob) {
            assetsToBundle.set(targetRelativePath, blob);
          }
        }
      }

      if (assetsToBundle.size > 0 && typeof SevenZip !== 'undefined') {
        try {
          const sevenZip = await SevenZip({
            locateFile: (file) => (typeof browser !== 'undefined' && browser.runtime?.getURL ? browser.runtime.getURL('lib/' + file) : 'lib/' + file)
          });

          const mdFileName = `${safeTitle}.md`;
          const archiveName = `${safeTitle}.7z`;

          // Write markdown file to virtual 7z root
          sevenZip.FS.writeFile(mdFileName, content);

          // Create assets directory
          try {
            sevenZip.FS.mkdir('assets');
          } catch (_) { }

          // Write each asset to virtual FS
          for (const [relPath, blob] of assetsToBundle.entries()) {
            const arrayBuffer = await blob.arrayBuffer();
            sevenZip.FS.writeFile(relPath, new Uint8Array(arrayBuffer));
          }

          // Call 7z to create archive
          sevenZip.callMain(['a', archiveName, mdFileName, 'assets']);

          const archiveBytes = sevenZip.FS.readFile(archiveName);
          const archiveBlob = new Blob([archiveBytes], { type: 'application/x-7z-compressed' });
          const url = URL.createObjectURL(archiveBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = archiveName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);

          // Cleanup virtual FS
          try {
            sevenZip.FS.unlink(archiveName);
            sevenZip.FS.unlink(mdFileName);
            for (const relPath of assetsToBundle.keys()) {
              sevenZip.FS.unlink(relPath);
            }
          } catch (_) { }
          return;
        } catch (err) {
          console.error('7z archive creation failed, falling back to .md download:', err);
        }
      }

      // Normal single MD download if no local assets or fallback
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeTitle}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // Export PDF (calls print)
    dom.exportPdfBtn.addEventListener('click', async () => {
      await downscaleImagesForPrint();
      window.print();
    });

    window.addEventListener('afterprint', restoreImagesAfterPrint);

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

  // Helper: Compress image into binary Blob (Zero Base64)
  function compressImage(file, maxWidth = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
      if (!file || !(file instanceof Blob)) {
        return reject(new TypeError('compressImage: file must be a Blob or File'));
      }

      const objectUrl = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return resolve(file);
        }
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            resolve(file);
          }
        }, 'image/webp', quality);
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(file);
      };

      img.src = objectUrl;
    });
  }

  // Firefox's PDF writer decodes every image to raw RGB and stores it as FlateDecode,
  // so PDF size tracks pixel count, not file size. Swap in narrower renditions for the
  // print pass only, leaving the on-screen assets untouched.
  const PRINT_MAX_WIDTH = 900;
  const _printSwaps = [];

  async function downscaleImagesForPrint() {
    for (const img of dom.mdBody.querySelectorAll('img')) {
      const mdSrc = img.dataset.mdSrc || '';
      if (!Storage.isLocalAssetRef(mdSrc)) continue;
      // naturalWidth is 0 while an image is still decoding: fall through and let compressImage decide
      if (img.naturalWidth && img.naturalWidth <= PRINT_MAX_WIDTH) continue;

      try {
        const blob = await Storage.getAsset(mdSrc);
        if (!blob) continue;
        // Re-encode lossy: the smoothing compresses far better than a lossless raster
        const printBlob = await compressImage(blob, PRINT_MAX_WIDTH, 0.8);
        const url = URL.createObjectURL(printBlob);
        _printSwaps.push({ img, originalSrc: img.src, url });
        img.src = url;
        // Print must not start before the replacement is decoded and laid out
        await img.decode().catch(() => { });
      } catch (err) {
        console.error('Print downscale failed, keeping full-resolution image', err);
      }
    }
  }

  function restoreImagesAfterPrint() {
    while (_printSwaps.length) {
      const { img, originalSrc, url } = _printSwaps.pop();
      img.src = originalSrc;
      URL.revokeObjectURL(url);
    }
  }

  // Compress an image file and persist it as an asset, returning its relative path
  async function saveImageFile(file) {
    const blob = await compressImage(file);
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return Storage.saveAsset(blob, cleanName);
  }

  // Process multi-file import: automatically replace local image links in Markdown with physical relative paths
  async function processFiles(fileObjs) {
    const mdFiles = fileObjs.filter(f => f.file.name.match(/\.(md|markdown|txt)$/i));
    const imgFiles = fileObjs.filter(f => IMAGE_EXT_RE.test(f.file.name));

    if (mdFiles.length === 0) {
      if (imgFiles.length === 0) {
        alert('No Markdown file found, please ensure it contains .md or .txt files.');
        return;
      }

      // Image-only import: append to the open document, or create one named after the first image
      if (!_activeDocId) {
        const title = imgFiles[0].file.name.replace(/\.[^.]+$/, '');
        const doc = await Storage.createDoc(title, '');
        FolderTree.render();
        await loadDocument(doc.id);
      }

      let content = Editor.getContent();
      const wasEmpty = content.trim() === '';
      for (const img of imgFiles) {
        try {
          const localPath = await saveImageFile(img.file);
          content += `\n![${img.file.name}](${localPath})\n`;
        } catch (err) {
          console.error('Image compression failed', err);
        }
      }
      if (wasEmpty) content = content.replace(/^\n+/, '');

      Editor.setContent(content);
      await Storage.updateDocContent(_activeDocId, content);
      renderMarkdown(content);
      if (dom.fileInput) dom.fileInput.value = '';
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
          const cleanUrl = Storage.normalizeAssetPath(url);
          // Find matching local image
          const matchedImg = imgFiles.find(img => {
            return img.path.endsWith(cleanUrl) || cleanUrl.endsWith(img.file.name) || img.file.name === cleanUrl;
          });

          if (matchedImg) {
            try {
              const localPath = await saveImageFile(matchedImg.file);
              // Globally replace this local link with our relative physical path
              mdText = mdText.split(url).join(localPath);
            } catch (err) {
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

  }

  // Handle dropping images directly into CodeMirror 6 editor
  async function handleEditorDrop(e, view) {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return false;
    const files = await getAllFiles(e.dataTransfer);
    const imgFiles = files.filter(f => IMAGE_EXT_RE.test(f.file.name));
    const otherFiles = files.filter(f => !IMAGE_EXT_RE.test(f.file.name));

    if (imgFiles.length > 0 && otherFiles.length === 0) {
      e.preventDefault();
      e.stopPropagation();

      let imgMarkdown = '';
      for (const img of imgFiles) {
        try {
          const localPath = await saveImageFile(img.file);
          imgMarkdown += `\n![${img.file.name}](${localPath})\n`;
        } catch (err) {
          console.error('Image processing failed', err);
        }
      }

      const dropPos = view ? view.posAtCoords({ x: e.clientX, y: e.clientY }) : null;
      if (dropPos !== null) {
        Editor.insertText(imgMarkdown, dropPos);
      } else {
        Editor.insertText(imgMarkdown);
      }

      if (_activeDocId) {
        await Storage.updateDocContent(_activeDocId, Editor.getContent());
        renderMarkdown(Editor.getContent());
      }
      return true;
    }
    return false;
  }

  // Handle pasting images from clipboard into CodeMirror 6 editor
  async function handleEditorPaste(e, view) {
    if (!e.clipboardData || !e.clipboardData.items) return false;
    const items = e.clipboardData.items;
    let handled = false;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (!file) continue;
        e.preventDefault();
        handled = true;

        try {
          const blob = await compressImage(file);
          const ext = file.type.split('/')[1] || 'png';
          const localPath = await Storage.saveAsset(blob, ext);

          const imgMarkdown = `![Pasted Image](${localPath})`;
          Editor.insertText(imgMarkdown);

          if (_activeDocId) {
            await Storage.updateDocContent(_activeDocId, Editor.getContent());
            renderMarkdown(Editor.getContent());
          }
        } catch (err) {
          console.error('Failed to paste image', err);
        }
      }
    }
    return handled;
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


