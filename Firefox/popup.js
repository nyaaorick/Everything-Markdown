// Compatibility declaration: adapt for Firefox (browser) and Chrome/Edge (chrome)
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

// DOM Element References
const panels = {
  ready: document.getElementById('readyPanel'),
  loading: document.getElementById('loadingPanel'),
  success: document.getElementById('successPanel'),
  error: document.getElementById('errorPanel'),
  invalidPage: document.getElementById('invalidPagePanel')
};

const statusText = document.getElementById('statusText');
const errorDesc = document.getElementById('errorDesc');
const successDesc = document.getElementById('successDesc');

const metadataToggle = document.getElementById('metadataToggle');

// Unified status panel switching function
function showPanel(targetKey) {
  Object.keys(panels).forEach(key => {
    if (key === targetKey) {
      panels[key].classList.remove('hidden');
    } else {
      panels[key].classList.add('hidden');
    }
  });

  const panelDivider = document.getElementById('panelDivider');
  if (panelDivider) {
    if (targetKey === 'ready' || targetKey === 'invalidPage') {
      panelDivider.classList.remove('hidden');
    } else {
      panelDivider.classList.add('hidden');
    }
  }
}

// Format date as YYYY-MM-DD HH:mm:ss
function formatDateTime(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// ====== Public: Inject content.js and extract Markdown text ======
async function extractMarkdown() {
  showPanel('loading');
  statusText.textContent = "Getting active tab...";

  const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab) {
    throw new Error("Unable to find the currently active browser tab, please refresh the page and try again.");
  }

  statusText.textContent = "Parsing and converting Markdown...";
  const results = await browserAPI.scripting.executeScript({
    target: { tabId: activeTab.id },
    files: ['content.js']
  }).catch(e => {
    throw new Error(`Page script injection failed: ${e.message}\n(Hint: Make sure you didn't click this extension on a built-in browser system page)`);
  });

  if (!results || results.length === 0) {
    throw new Error("The scraping engine returned empty data, please make sure the conversation is fully loaded.");
  }

  if (results[0].error) {
    throw new Error(`Export engine parsing exception: ${results[0].error}`);
  }

  let mdText = results[0].result;
  if (!mdText || mdText.includes("Gemini conversation nodes not recognized")) {
    throw new Error("Failed to capture the Gemini conversation content on the page.\n\nPlease confirm you are currently on a valid Gemini conversation page, and the content has loaded successfully.");
  }

  // Add metadata based on user option
  if (metadataToggle.checked) {
    const nowStr = formatDateTime(new Date());
    const metadataHeader = `---\n` +
                           `Export Time: ${nowStr}\n` +
                           `Source Conversation URL: ${activeTab.url}\n` +
                           `---\n\n`;
    mdText = metadataHeader + mdText;
  }

  return mdText;
}

// ====== Export to MD File ======
async function startExportProcess() {
  try {
    const mdText = await extractMarkdown();

    statusText.textContent = "Preparing to save file...";
    const reply = await browserAPI.runtime.sendMessage({
      type: "export-md",
      mdText: mdText
    }).catch(err => {
      throw new Error(`Background saving module communication failed: ${err.message}`);
    });

    if (!reply || !reply.ok) {
      throw new Error(`Download save failed: ${reply && reply.error ? reply.error : "Unknown error"}`);
    }

    showPanel('success');
  } catch (err) {
    console.error("Export exception details:", err);
    errorDesc.textContent = err.message || "Unknown exception, please check the extension background log.";
    showPanel('error');
  }
}



// ====== Open Notes Manager and auto-import current conversation ======
async function startManagerProcess() {
  try {
    const mdText = await extractMarkdown();

    statusText.textContent = "Opening notes manager and importing conversation...";
    
    // IndexedDB approach via Dexie
    const db = new Dexie('EverythingMD_DB');
    db.version(1).stores({
      folders: 'id, parentId',
      docs: 'id, folderId',
      contents: 'id',
      highlights: 'id, docId',
      assets: 'id'
    });
    await db.open();

    const id = 'd_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    let title = 'Gemini Export Conversation';
    const match = mdText.match(/^#\s+(.+)$/m);
    if (match && match[1]) {
      title = match[1].trim();
    } else {
      const now = new Date();
      title = `Gemini Conversation ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    
    const nowTime = Date.now();
    const meta = {
      id,
      title,
      folderId: null,
      isBookmarked: false,
      createdAt: nowTime,
      updatedAt: nowTime
    };
    
    await db.transaction('rw', db.docs, db.contents, async () => {
      await db.docs.put(meta);
      await db.contents.put({ id, content: mdText });
    });
    
    localStorage.setItem('mdm_active_doc_id', id);
    localStorage.setItem('mdm_view_mode', 'dual');

    const managerUrl = browserAPI.runtime.getURL("manager.html");
    await browserAPI.tabs.create({ url: managerUrl, active: true });

    setTimeout(() => {
      window.close();
    }, 80);
  } catch (err) {
    console.error("Open notes manager exception details:", err);
    errorDesc.textContent = err.message || "Unknown exception, please check the extension background log.";
    showPanel('error');
  }
}

// ====== Direct open Notes Manager (no current conversation) ======
function openNoteManagerDirect() {
  const managerUrl = browserAPI.runtime.getURL("manager.html");
  browserAPI.tabs.create({ url: managerUrl, active: true });
  setTimeout(() => {
    window.close();
  }, 80);
}

// Page initialization and routing logic
async function init() {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    const url = activeTab?.url || "";

    // Strict security check: Only allow working within the official Google Gemini domain
    const isGemini = url.includes("gemini.google.com");

    if (isGemini) {
      showPanel('ready');
    } else {
      showPanel('invalidPage');
    }
  } catch (e) {
    console.error("Initialization validation failed:", e);
    errorDesc.textContent = "Environment validation failed: " + e.message;
    showPanel('error');
  }
}

// Event bindings
document.getElementById('exportBtn').addEventListener('click', startExportProcess);
document.getElementById('managerBtn').addEventListener('click', startManagerProcess);

const managerBtnInvalid = document.getElementById('managerBtnInvalid');
if (managerBtnInvalid) {
  managerBtnInvalid.addEventListener('click', openNoteManagerDirect);
}

document.getElementById('openGeminiBtn').addEventListener('click', () => {
  browserAPI.tabs.create({ url: "https://gemini.google.com/" });
  window.close();
});

document.getElementById('successCloseBtn').addEventListener('click', () => {
  showPanel('ready');
});

document.getElementById('errorBackBtn').addEventListener('click', () => {
  showPanel('ready');
});

document.getElementById('errorRetryBtn').addEventListener('click', startExportProcess);

if (document.getElementById('openManagerReadyBtn')) {
  document.getElementById('openManagerReadyBtn').addEventListener('click', openNoteManagerDirect);
}

// Start validation
init();