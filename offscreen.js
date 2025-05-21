chrome.runtime.onMessage.addListener(handleMessages);

async function handleMessages(message, sender, sendResponse) {
    if (message.target !== 'offscreen') {

        return false; 
    }

    if (message.type !== 'copy-to-clipboard') {
        console.warn("Offscreen: Received unknown message type:", message.type);
        sendResponse({ success: false, error: "Unknown message type for offscreen document" });
        return true; 
    }

    let success = false;
    let errorMsg = null;

    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(message.data);
            success = true;

        } else {

        }
    } catch (err) {
        errorMsg = `navigator.clipboard error: ${err.message}`;

    }

    if (!success) { 
        const textArea = document.createElement("textarea");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        textArea.value = message.data;
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            document.execCommand('copy');
            success = true;

            if (errorMsg) { 

                errorMsg = null; 
            }
        } catch (err) {

            if (!errorMsg) errorMsg = `execCommand error: ${err.message}`; 
        }
        document.body.removeChild(textArea);
    }

    sendResponse({ success: success, error: errorMsg });
    return true; 
}

