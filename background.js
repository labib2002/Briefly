// Import the new library and the core Innertube class
import Innertube, { YTNodes } from './node_modules/youtubei.js/bundle/browser.js';

// --- Core Setup ---
const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
let creatingOffscreenDocumentPromise = null;
let yt;

// Initialize the YouTube API client on startup
(async () => {
    try {
        yt = await Innertube.create({
            generate_session_locally: true,
            lang: 'en',
            fetch: self.fetch.bind(self)
        });
        console.log("Briefly: YouTube API client initialized successfully.");
    } catch (error) {
        console.error("Briefly: Failed to initialize YouTube API client.", error);
    }
})();

// --- Offscreen API for Clipboard (REVISED FOR ROBUSTNESS) ---

// Helper to create and ensure the offscreen document is ready.
async function ensureOffscreenReady() {
    // 1. Create the offscreen document if it doesn't exist.
    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

    // 2. Ping the offscreen document until it responds, with a timeout.
    return new Promise((resolve, reject) => {
        const timeout = 5000; // 5 seconds timeout
        const interval = 100;  // Ping every 100ms
        let elapsed = 0;

        const timer = setInterval(async () => {
            elapsed += interval;
            if (elapsed >= timeout) {
                clearInterval(timer);
                reject(new Error("Timeout waiting for offscreen document to become ready."));
                return;
            }

            try {
                const response = await chrome.runtime.sendMessage({
                    target: 'offscreen',
                    type: 'ping'
                });
                if (response?.ready) {
                    clearInterval(timer);
                    resolve(true);
                }
            } catch (error) {
                // This error is expected if the offscreen document is not yet ready to receive messages.
                // We'll just let the interval continue until the timeout.
            }
        }, interval);
    });
}

// Revised function to copy text to the clipboard with readiness check and retries.
async function copyToClipboardViaOffscreen(textToCopy) {
    if (typeof textToCopy !== 'string') {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Clipboard Error', message: 'Invalid data for copying.' });
        return false;
    }

    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 250;
    let lastError = 'Unknown reason';

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            // 1. Ensure the offscreen document is set up and responsive.
            await ensureOffscreenReady();

            // 2. Send the copy command.
            const response = await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'copy-to-clipboard',
                data: textToCopy
            });

            // 3. Check for success.
            if (response?.success) {
                return true; // Success!
            }
            lastError = response?.error || 'The offscreen page reported a failure.';
        } catch (error) {
            lastError = error.message;
            // This catch block handles errors from ensureOffscreenReady or sendMessage itself.
        }

        // If not the last attempt, wait before retrying.
        if (i < MAX_RETRIES - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    // If all retries fail, show a notification.
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/briefly-48.png',
        title: 'Copy Failed',
        message: `Could not copy after ${MAX_RETRIES} attempts: ${lastError}`
    });
    return false;
}


async function setupOffscreenDocument(path) {
    const offscreenUrl = chrome.runtime.getURL(path);
    if (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] }).then(contexts => contexts.length > 0)) {
        return;
    }
    if (creatingOffscreenDocumentPromise) {
        await creatingOffscreenDocumentPromise;
    } else {
        creatingOffscreenDocumentPromise = chrome.offscreen.createDocument({ url: path, reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'Needed to write text to the clipboard.' });
        try {
            await creatingOffscreenDocumentPromise;
        } finally {
            creatingOffscreenDocumentPromise = null;
        }
    }
}

// --- New API-Driven Transcript Logic ---

function getYouTubeVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return v;                           // https://www.youtube.com/watch?v=ID

    if (u.hostname.endsWith('youtu.be')) {     // https://youtu.be/ID
      return u.pathname.slice(1);
    }

    const m = u.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{6,})/); // shorts/embed
    if (m) return m[1];
  } catch (e) {
    console.error("Error parsing URL for Video ID:", url, e);
  }
  return null;
}

/**
 * FINAL CORRECTED LOGIC.
 * This mimics the logic from the Python innertube library's get_transcript example.
 * 1. Call /next to get page data.
 * 2. Find the transcript engagement panel and extract the 'params' for the transcript.
 * 3. Call /get_transcript with those specific params.
 * @param {string} videoId
 * @returns {Promise<{status: string, transcript?: string, message?: string}>}
 */
async function fetchTranscriptWithApi(videoId) {
  if (!yt) {
    return { status: "error", message: "YouTube API client is not initialized." };
  }

  try {
    const info = await yt.getInfo(videoId);                 // VideoInfo
    let tx = await info.getTranscript();                     // TranscriptInfo

    // No transcript at all?
    const list = tx?.transcript?.content?.body?.initial_segments;
    if (!list?.length) {
      return { status: "error", message: "No transcript available for this video." };
    }

    // Flatten segments -> plain text (using typed YTNodes)
    const segments = list
      .filter(seg => seg.is?.(YTNodes.TranscriptSegment))
      .map(seg => seg.as(YTNodes.TranscriptSegment).snippet?.toString().trim())
      .filter(Boolean);

    if (!segments.length) {
      return { status: "error", message: "Transcript was empty." };
    }

    const transcriptText = segments.join(' ');
    return { status: "success", transcript: transcriptText };
  } catch (err) {
    console.error("YouTube.js transcript failure:", err);
    return { status: "error", message: `YouTube transcript failed: ${err?.message || err}` };
  }
}


// --- Main Action Handlers (UPDATED) ---

async function automateAIStudio(tabId, promptText) {
    try {
        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content_script_aistudio.js'] });
        const response = await chrome.tabs.sendMessage(tabId, { action: 'injectDataAndRun', prompt: promptText });
        if (!response?.success) {
            throw new Error(response?.error || 'Content script error in AI Studio.');
        }
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'AI Studio Automation', message: 'AI Studio automation initiated.' });
    } catch (error) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'AI Studio Automation Failed', message: `Could not automate AI Studio: ${error.message}` });
    }
}

async function handleCopyTranscript(url, sendResponseToPopup) {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) {
        const payload = { status: "error", message: "Could not identify YouTube Video ID." };
        if (sendResponseToPopup) sendResponseToPopup(payload); else chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error', message: payload.message });
        return;
    }

    const result = await fetchTranscriptWithApi(videoId);

    if (result.status === "success" && result.transcript) {
        const copied = await copyToClipboardViaOffscreen(result.transcript);
        if (copied) {
            const payload = { status: "success", message: "Transcript copied!" };
             if (sendResponseToPopup) sendResponseToPopup(payload); else chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Success', message: payload.message });
        } else {
            // The clipboard function now handles its own error notifications.
            if (sendResponseToPopup) sendResponseToPopup({ status: "error", message: "Failed to copy to clipboard." });
        }
    } else {
        const payload = { status: "error", message: result.message || 'Failed to get transcript from all available sources.' };
        if (sendResponseToPopup) sendResponseToPopup(payload); else chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Transcript Error', message: payload.message });
    }
}

async function handleSummarizeInStudio(url, sendResponseToPopup) {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) {
        const payload = { status: "error", message: "Could not identify YouTube Video ID for summarization." };
        if (sendResponseToPopup) sendResponseToPopup(payload); else chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error', message: payload.message });
        return;
    }

    const result = await fetchTranscriptWithApi(videoId);

    if (result.status !== "success" || !result.transcript) {
        const payload = { status: "error", message: result.message || 'Failed to get a valid transcript for summarization from all sources.' };
        if (sendResponseToPopup) sendResponseToPopup(payload); else chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Automation Error', message: payload.message });
        return;
    }
    if (sendResponseToPopup) {
        sendResponseToPopup({ status: "success_fetch", message: "Transcript fetched. Opening AI Studio..." });
    }
    const promptText = `Summarize the following YouTube video transcript. Be concise but ensure all key information, data points, and unique insights are retained. The summary should be well-structured for easy reading:\n\n---\n\n${result.transcript}\n\n---`;
    try {
        const aiTab = await chrome.tabs.create({ url: "https://aistudio.google.com/", active: true });
        chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
            if (tabId === aiTab.id && changeInfo.status === 'complete' && changeInfo.url && changeInfo.url.startsWith("https://aistudio.google.com")) {
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(() => { automateAIStudio(aiTab.id, promptText); }, 1500);
            }
        });
    } catch (error) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error Opening Tab', message: `Could not open AI Studio: ${error.message}` });
    }
}


// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: "getAndCopyTranscript",
            title: "Briefly: Get & Copy Transcript",
            contexts: ["link"],
            targetUrlPatterns: ["*://*.youtube.com/watch*", "*://youtu.be/*", "*://*.youtube.com/shorts/*", "*://*.youtube.com/embed/*"]
        });
        chrome.contextMenus.create({
            id: "summarizeInAIStudio",
            title: "Briefly: Summarize in AI Studio",
            contexts: ["link"],
            targetUrlPatterns: ["*://*.youtube.com/watch*", "*://youtu.be/*", "*://*.youtube.com/shorts/*", "*://*.youtube.com/embed/*"]
        });
    });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
    if (!info.linkUrl) return.
    if (info.menuItemId === "getAndCopyTranscript") {
        await handleCopyTranscript(info.linkUrl, null);
    } else if (info.menuItemId === "summarizeInAIStudio") {
        await handleSummarizeInStudio(info.linkUrl, null);
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'copyTranscriptFromPopup' && message.url) {
        handleCopyTranscript(message.url, sendResponse);
        return true;
    } else if (message.action === 'summarizeInStudioFromPopup' && message.url) {
        handleSummarizeInStudio(message.url, sendResponse);
        return true;
    }
    return false;
});

console.log("Briefly background script loaded with new YouTube API module.");