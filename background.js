import {
    YoutubeTranscript,
    YoutubeTranscriptError,
    YoutubeTranscriptTooManyRequestError,
    YoutubeTranscriptVideoUnavailableError,
    YoutubeTranscriptDisabledError,
    YoutubeTranscriptNotAvailableError,
    YoutubeTranscriptNotAvailableLanguageError
} from './lib/youtube-transcript-lib.js';

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
const PREFERRED_LANGUAGES = ['en', 'ar']; 

let creatingOffscreenDocumentPromise = null;

async function hasOffscreenDocument(path) {
    const offscreenUrl = chrome.runtime.getURL(path);
    if (typeof globalThis.clients === 'undefined') { 
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });
        return contexts.length > 0;
    }

    const matchedClients = await globalThis.clients.matchAll();
    for (const client of matchedClients) {
        if (client.url === offscreenUrl) {
            return true;
        }
    }
    return false;
}

async function setupOffscreenDocument(path) {
    if (await hasOffscreenDocument(path)) {

        return;
    }

    if (creatingOffscreenDocumentPromise) {

        await creatingOffscreenDocumentPromise;
    } else {

        creatingOffscreenDocumentPromise = chrome.offscreen.createDocument({
            url: path,
            reasons: [chrome.offscreen.Reason.CLIPBOARD],
            justification: 'Needed to write text to the clipboard.'
        });
        try {
            await creatingOffscreenDocumentPromise;

        } catch (error) {
            console.error("Error creating offscreen document:", error);
            creatingOffscreenDocumentPromise = null; 
            throw error; 
        } finally {

             creatingOffscreenDocumentPromise = null;
        }
    }
}

async function copyToClipboardViaOffscreen(textToCopy) {
    if (typeof textToCopy !== 'string') {
         chrome.notifications.create('id_clipboard_invalid_data_' + Date.now(),{ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Clipboard Error', message: 'Invalid data for copying.' });
         return false;
    }

    try {
        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

        const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'copy-to-clipboard',
            data: textToCopy
        });

        if (response && response.success) {
            return true; 
        } else {
            console.error("Offscreen copy failed:", response?.error);
            chrome.notifications.create('id_clipboard_offscreen_fail_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Copy Failed', message: `Could not copy: ${response?.error || 'Unknown reason from offscreen utility'}` });
            return false;
        }
    } catch (err) {
        console.error("Error in copyToClipboardViaOffscreen:", err);
        let message = `Clipboard interaction failed: ${err?.message || 'Unknown error'}`;
        if (err.message && (err.message.toLowerCase().includes("no matching signature") || err.message.toLowerCase().includes("could not establish connection") )) {
            message = "Failed to communicate with clipboard utility. The utility might be closed. Please try again.";
        } else if (err.message && err.message.toLowerCase().includes("runtime.nocontext")) {
            message = "Clipboard utility was not available (no context). Please try again.";
        }
        chrome.notifications.create('id_clipboard_comms_error_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Clipboard Error', message: message });
        return false;
    }
}

function getYouTubeVideoId(url) {
    if (!url) return null;
    try {
        const urlObject = new URL(url);
        if (urlObject.hostname.includes('youtube.com') && urlObject.pathname === '/watch' && urlObject.searchParams.has('v')) {
            return urlObject.searchParams.get('v');
        }
        if (urlObject.hostname.includes('youtu.be')) {
            const pathParts = urlObject.pathname.substring(1).split('/');
            if (pathParts.length > 0 && pathParts[0].length === 11 && /^[a-zA-Z0-9_-]+$/.test(pathParts[0])) {
                return pathParts[0];
            }
        }
        if (urlObject.hostname.includes('youtube.com') && urlObject.pathname.startsWith('/embed/')) {
            const pathParts = urlObject.pathname.substring('/embed/'.length).split('/');
             if (pathParts.length > 0 && pathParts[0].length === 11 && /^[a-zA-Z0-9_-]+$/.test(pathParts[0])) {
                return pathParts[0];
            }
        }
        if (urlObject.hostname.includes('youtube.com') && urlObject.pathname.startsWith('/shorts/')) {
            const pathParts = urlObject.pathname.substring('/shorts/'.length).split('/');
            if (pathParts.length > 0 && pathParts[0].length === 11 && /^[a-zA-Z0-9_-]+$/.test(pathParts[0])) {
                return pathParts[0];
            }
        }
    } catch (e) {
        console.error("Error parsing URL for Video ID:", url, e);
    }
    console.warn("Could not extract YouTube Video ID from URL:", url);
    return null;
}

async function fetchTranscriptWithJSLibrary(videoId, preferredLang = 'en') {
    try {
        const transcriptEntries = await YoutubeTranscript.fetchTranscript(videoId, { lang: preferredLang });

        if (!transcriptEntries || transcriptEntries.length === 0) {
            return { status: "error", message: `No transcript content found for ${preferredLang} after fetch (empty entries).` };
        }

        const fullTranscriptText = transcriptEntries.map(entry => entry.text).join(' ');
        return { status: "success", transcript: fullTranscriptText, lang: transcriptEntries[0]?.lang || preferredLang };

    } catch (error) {
        let errorMessage = `Failed to fetch transcript for video ID ${videoId}.`;

        if (error.name === 'YoutubeTranscriptDisabledError') {
            errorMessage = `Transcripts are disabled for this video.`;
        } else if (error.name === 'YoutubeTranscriptNotAvailableError') {
            errorMessage = `No transcript could be found for this video.`;
        } else if (error.name === 'YoutubeTranscriptNotAvailableLanguageError') {
            errorMessage = `Transcript in language '${preferredLang}' is not available. Available: ${error.availableLangs?.join(', ') || 'unknown'}.`;
        } else if (error.name === 'YoutubeTranscriptVideoUnavailableError') {
            errorMessage = `The video is no longer available.`;
        } else if (error.name === 'YoutubeTranscriptTooManyRequestError') {
            errorMessage = 'YouTube is temporarily blocking requests (too many requests). Please try again later.';
        } else if (error.name === 'YoutubeTranscriptError') {
            errorMessage = `Transcript library error: ${error.message}`;
        } else if (error?.message) {
            errorMessage = `Error fetching transcript: ${error.message}`;
        }

        console.error(`JS Transcript Fetch Error Details: Video ID ${videoId}, Lang ${preferredLang}, Error Name: ${error.name}, Message: ${error.message}`, error);
        return { status: "error", message: errorMessage };
    }
}

async function fetchTranscriptWithPreferences(videoId) {
    let lastErrorResult = null;
    for (const lang of PREFERRED_LANGUAGES) {
        const result = await fetchTranscriptWithJSLibrary(videoId, lang);
        if (result.status === "success") {
            return result;
        }
        lastErrorResult = result;
    }
    const defaultAttemptResult = await fetchTranscriptWithJSLibrary(videoId, 'en');
    if (defaultAttemptResult.status === "success") {
        return defaultAttemptResult;
    }
    return lastErrorResult || defaultAttemptResult || { status: "error", message: "Could not retrieve transcript in any preferred or default language." };
}

async function automateAIStudio(tabId, promptText) {
    let success = false;
    let errorMessage = 'Automation did not complete.';
    try {
        if (typeof promptText !== 'string') throw new Error("Invalid prompt data type.");

        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content_script_aistudio.js'] });

        const response = await Promise.race([
             chrome.tabs.sendMessage(tabId, { action: 'injectDataAndRun', prompt: promptText }),
             new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for content script response from AI Studio")), 15000)) 
         ]);
        success = response?.success || false;
        errorMessage = success ? 'AI Studio automation initiated.' : (response?.error || 'Content script error or timeout in AI Studio.');
    } catch (error) {
        errorMessage = `Could not automate AI Studio: ${error?.message || 'Unknown injection/messaging error'}`;
         if (error?.message?.includes("Frame with ID") || 
             error?.message?.includes("Receiving end does not exist") || 
             error?.message?.includes("No tab with id") || 
             error?.message?.includes("Timeout waiting")) {
              errorMessage = "AI Studio tab changed, closed, or script unresponsive.";
         } else if (error.message && error.message.toLowerCase().includes("cannot access a chrome extension url")) {
              errorMessage = "Error injecting script into AI Studio. Check permissions or page security.";
         }
    } finally {
         chrome.notifications.create('id_aistudio_result_' + Date.now(), {
             type: 'basic',
             iconUrl: 'icons/briefly-48.png',
             title: success ? 'AI Studio Automation' : 'AI Studio Automation Failed',
             message: errorMessage
         });
    }
    return success;
}

async function handleCopyTranscript(url, sendResponseToPopup) {
    const videoId = getYouTubeVideoId(url);
    let responsePayload = { status: "error", message: "Could not identify YouTube Video ID." };

    if (!videoId) {
        chrome.notifications.create('id_copy_novideoid_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error', message: responsePayload.message });
        if (sendResponseToPopup) sendResponseToPopup(responsePayload);
        return;
    }

    const result = await fetchTranscriptWithPreferences(videoId);
    if (result?.status === "success" && result.transcript) {
        const copied = await copyToClipboardViaOffscreen(result.transcript);
        if (copied) {
            responsePayload = { status: "success", message: "Transcript copied to clipboard!" };
            chrome.notifications.create('id_copy_success_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Copied to Clipboard', message: 'Transcript text copied successfully.' });
        } else {

            responsePayload = { status: "error", message: "Failed to copy transcript to clipboard (see details above)." };
        }
    } else {
        responsePayload = { status: "error", message: result?.message || 'Failed to get transcript for copying.' };
        chrome.notifications.create('id_copy_fetch_error_' + Date.now(),{
            type: 'basic',
            iconUrl: 'icons/briefly-48.png',
            title: 'Transcript Error',
            message: responsePayload.message
        });
    }
    if (sendResponseToPopup) sendResponseToPopup(responsePayload);
}

async function handleSummarizeInStudio(url, sendResponseToPopup) {
    const videoId = getYouTubeVideoId(url);
    let responsePayload = { status: "error", message: "Could not identify YouTube Video ID for summarization." };

    if (!videoId) {
        chrome.notifications.create('id_sum_novideoid_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error', message: responsePayload.message });
        if (sendResponseToPopup) sendResponseToPopup(responsePayload);
        return;
    }

    const result = await fetchTranscriptWithPreferences(videoId);
    if (result?.status !== "success" || typeof result.transcript !== 'string' || !result.transcript.trim()) {
        let message = result?.message || 'Failed to get a valid transcript for summarization.';
        if (result?.status === "success" && (typeof result.transcript !== 'string' || !result.transcript.trim())) {
            message = 'Transcript from API was empty or invalid.';
        }
        responsePayload = { status: "error", message: message };
        chrome.notifications.create('id_sum_fetch_error_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Automation Error', message: message });
        if (sendResponseToPopup) sendResponseToPopup(responsePayload);
        return;
    }

    if (sendResponseToPopup) {
        sendResponseToPopup({ status: "success_fetch", message: "Transcript fetched. Opening AI Studio..." });
    }

    const promptText = `Summarize the following YouTube video transcript. Be concise but ensure all key information, data points, and unique insights are retained. The summary should be well-structured for easy reading:\n\n---\n\n${result.transcript}\n\n---`;
    let aiTab;
    try {
         aiTab = await chrome.tabs.create({ url: "https://aistudio.google.com/", active: true });
         if (!aiTab?.id) throw new Error("Failed to get tab ID when creating AI Studio tab.");
    } catch (error) {
        chrome.notifications.create('id_sum_opentab_error_' + Date.now(), { type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error Opening Tab', message: `Could not open AI Studio: ${error?.message || 'Unknown'}` });
        return;
    }

    let listenerAttached = true;
    const tabUpdateListener = async (updatedTabId, changeInfo, tab) => {
        if (listenerAttached && updatedTabId === aiTab.id && changeInfo.status === 'complete') {
            if (tab.url && tab.url.startsWith("https://aistudio.google.com")) {
                listenerAttached = false;
                chrome.tabs.onUpdated.removeListener(tabUpdateListener);
                clearTimeout(timeoutId);
                setTimeout(async () => {
                    await automateAIStudio(aiTab.id, promptText);
                }, 1200); 
            }
        }
    };
    chrome.tabs.onUpdated.addListener(tabUpdateListener);
    const timeoutId = setTimeout(() => {
        if (listenerAttached) {
            listenerAttached = false;
            chrome.tabs.onUpdated.removeListener(tabUpdateListener);
            chrome.notifications.create('id_sum_timeout_warn_' + Date.now(), {
                type: 'basic',
                iconUrl: 'icons/briefly-48.png',
                title: 'Automation Warning',
                message: 'AI Studio tab took too long to load or did not reach the expected URL. Attempting automation anyway.'
            });
            if (aiTab.id) {
                 setTimeout(async () => {
                    await automateAIStudio(aiTab.id, promptText);
                }, 700); 
            }
        }
    }, 25000);
}

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
    if (!info.linkUrl) return;

    if (info.menuItemId === "getAndCopyTranscript") {
        await handleCopyTranscript(info.linkUrl, null); 
    } else if (info.menuItemId === "summarizeInAIStudio") {
        await handleSummarizeInStudio(info.linkUrl, null); 
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'copyTranscriptFromPopup' && message.url) {
        (async () => {
            await handleCopyTranscript(message.url, sendResponse);
        })();
        return true; 
    } else if (message.action === 'summarizeInStudioFromPopup' && message.url) {
        (async () => {
            await handleSummarizeInStudio(message.url, sendResponse);
        })();
        return true; 
    }
    return false; 
});

console.log("Briefly background script loaded. Offscreen doc management updated.");