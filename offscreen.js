// offscreen.js

// Use a non-async listener that returns true to keep the message port open for async sendResponse.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle different message types from the background script.
  if (message.target !== 'offscreen') {
    return false; // Not for us
  }

  switch (message.type) {
    case 'ping':
      // Respond immediately to the readiness check.
      sendResponse({ ready: true });
      break;

    case 'copy-to-clipboard':
      // Handle the copy request asynchronously.
      (async () => {
        let success = false;
        let errorMsg = null;
        const textToCopy = message.data;

        try {
          // Modern async clipboard API
          await navigator.clipboard.writeText(textToCopy);
          success = true;
        } catch (err) {
          // If the modern API fails, fall back to the legacy method.
          errorMsg = `navigator.clipboard.writeText failed: ${err.message}`;
        }

        // Fallback for environments where navigator.clipboard is not available or fails.
        if (!success) {
          const textArea = document.createElement("textarea");
          textArea.style.position = "absolute";
          textArea.style.left = "-9999px";
          textArea.value = textToCopy;
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          try {
            // execCommand is deprecated but a useful fallback.
            // It returns a boolean indicating success.
            if (document.execCommand('copy')) {
              success = true;
              errorMsg = null; // Clear previous error message if fallback succeeds.
            } else {
              errorMsg = 'document.execCommand("copy") returned false.';
            }
          } catch (err) {
            // Only set error if it wasn't already set by the primary method.
            if (!errorMsg) {
              errorMsg = `execCommand error: ${err.message}`;
            }
          } finally {
            document.body.removeChild(textArea);
          }
        }

        // Send the final response back to the background script.
        sendResponse({ success: success, error: errorMsg });
      })();
      break;

    default:
      console.warn("Offscreen: Received unknown message type:", message.type);
      sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      break;
  }

  // Return true to indicate that we will send a response asynchronously.
  return true;
});