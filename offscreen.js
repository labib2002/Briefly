// Briefly — Offscreen document script

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return; // ignore others

  // Ready handshake
  if (message.type === 'ping') {
    sendResponse({ ready: true });
    return; // sync response
  }

  if (message.type !== 'copy-to-clipboard') {
    sendResponse({ success: false, error: 'Unknown message type' });
    return;
  }

  (async () => {
    let success = false, errorMsg = null;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.data);
        success = true;
      }
    } catch (e) {
      errorMsg = `navigator.clipboard error: ${e?.message || e}`;
    }

    if (!success) {
      const textArea = document.createElement('textarea');
      textArea.style.position = 'absolute';
      textArea.style.left = '-9999px';
      textArea.setAttribute('aria-hidden', 'true');
      textArea.value = message.data == null ? '' : String(message.data);
      document.body.appendChild(textArea);
      try {
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        if (ok) {
          success = true;
          errorMsg = null;
        } else if (!errorMsg) {
          errorMsg = 'execCommand returned false';
        }
      } catch (e) {
        if (!errorMsg) errorMsg = `execCommand error: ${e?.message || e}`;
      } finally {
        document.body.removeChild(textArea);
      }
    }

    sendResponse({ success, error: errorMsg });
  })();

  return true; // keep port open for async response
});