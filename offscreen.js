// Handles clipboard operations in the offscreen document.
chrome.runtime.onMessage.addListener(handleMessages);

async function handleMessages(message, sender, sendResponse) {
    if (message.target !== 'offscreen' || message.type !== 'copy-to-clipboard') {
        // If not for us, or unknown type, do nothing or send a negative response.
        // i only expect 'copy-to-clipboard'..
        sendResponse({ success: false, error: "Message not for offscreen or unknown type" });
        return false;
    }

    let success = false;
    let errorMsg = null;

    try { // Try preferred navigator.clipboard API
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(message.data);
            success = true;
        } else {
           // Fallback will be attempted if navigator.clipboard is not available or fails
        }
    } catch (err) {
        errorMsg = `navigator.clipboard: ${err.message}`;
    }

    if (!success) { // Fallback to execCommand
        const textArea = document.createElement("textarea");
        textArea.style.position = "absolute"; // Keep it off-screen
        textArea.style.left = "-9999px";
        textArea.value = message.data;
        document.body.appendChild(textArea);
        textArea.focus(); // Element must be focused
        textArea.select();
        try {
            document.execCommand('copy');
            success = true;
            errorMsg = null; // Clear primary error if fallback succeeded
        } catch (err) {
            if (!errorMsg) errorMsg = `execCommand: ${err.message}`; // Only set if primary didn't set one
        }
        document.body.removeChild(textArea);
    }
    sendResponse({ success: success, error: errorMsg });
    return true; // asynchronous response
}