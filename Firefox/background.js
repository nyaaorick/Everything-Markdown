// Compatibility declaration: adapt for Firefox (browser) and Chrome/Edge (chrome)
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

// Initiate download in background page: closing popup cancels blobs created in its document
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "export-md") {
    return false;
  }

  // Execute async download flow immediately
  (async () => {
    try {
      const { mdText } = message;
      if (typeof mdText !== "string") {
        sendResponse({ ok: false, error: "Invalid exported content (not a string format)" });
        return;
      }

      // Convert to UTF-8 Blob format and create local temporary download link
      const blob = new Blob([mdText], { type: "text/markdown;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);

      // Call browser's underlying download API
      await browserAPI.downloads.download({
        url: blobUrl,
        filename: `Gemini_Export_${Date.now()}.md`,
        saveAs: true,
      });

      // Revoke temporary Blob URL after 60 seconds to release browser memory
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

      sendResponse({ ok: true });
    } catch (e) {
      console.error("Background download error:", e);
      sendResponse({ ok: false, error: e.message || "Failed to invoke browser download component" });
    }
  })();

  // Return true to keep message channel open for async response (sendResponse)
  return true;
});
