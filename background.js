const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';

function getYouTubeVideoId(url) {
    if (!url) return null;
    try {
        const urlObject = new URL(url);
        if (urlObject.hostname.includes('youtube.com') && urlObject.searchParams.has('v')) {
            return urlObject.searchParams.get('v');
        }
        if (urlObject.hostname.includes('youtu.be')) {
            return urlObject.pathname.substring(1).split('/')[0] || null;
        }
    } catch (e) {
        console.error("Error parsing URL:", url, e);
    }
    return null;
}

async function fetchTranscriptFromLocalAPI(videoId) {
    const apiUrl = `http:
    let result = { status: "error", message: "API call did not complete." };
    try {
        const response = await fetch(apiUrl, { method: 'GET', mode: 'cors' });
        if (!response.ok) {
            let errorMsg = `HTTP error! Status: ${response.status}`;
            try {
                const errorData = await response.json();
                errorMsg = `API Error: ${errorData?.message || 'Unknown API response'}`;
            } catch (jsonError) {  }
            result = { status: "error", message: errorMsg };
        } else {
            const data = await response.json();
            result = data;
        }
    } catch (error) {
        const errorMsg = "Could not connect to the local transcript server. Is it running?";
        result = { status: "error", message: errorMsg };
    }
    return result;
}

async function copyToClipboardViaOffscreen(textToCopy) {
    if (typeof textToCopy !== 'string') {
         chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Clipboard Error', message: 'Invalid data for copying.' });
         return false;
    }
    try {
        const existingContexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)] });
        if (existingContexts.length === 0) {
            await chrome.offscreen.createDocument({ url: OFFSCREEN_DOCUMENT_PATH, reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'Needed to write text to the clipboard.' });
        }
        const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy-to-clipboard', data: textToCopy });
        if (response && response.success) {
            chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Copied to Clipboard', message: 'Transcript text copied successfully.' });
            return true;
        } else {
            chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Copy Failed', message: `Could not copy: ${response?.error || 'Unknown reason'}` });
            return false;
        }
    } catch (err) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Clipboard Error', message: `Clipboard interaction failed: ${err?.message || 'Unknown'}` });
        return false;
    }
}

async function automateAIStudio(tabId, promptText) {
    let success = false;
    let errorMessage = 'Automation did not complete.';
    try {
        if (typeof promptText !== 'string') throw new Error("Invalid prompt data type.");
        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content_script_aistudio.js'] });
        const response = await Promise.race([
             chrome.tabs.sendMessage(tabId, { action: 'injectDataAndRun', prompt: promptText }),
             new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for content script response")), 15000))
         ]);
        success = response?.success || false;
        errorMessage = success ? 'AI Studio automation initiated.' : (response?.error || 'Content script error or timeout.');
    } catch (error) {
        errorMessage = `Could not automate AI Studio: ${error?.message || 'Unknown injection/messaging error'}`;
         if (error?.message?.includes("Frame with ID") || error?.message?.includes("Receiving end does not exist") || error?.message?.includes("No tab with id") || error?.message?.includes("Timeout waiting")) {
              errorMessage = "AI Studio tab changed, closed, or script unresponsive.";
         }
    } finally {
         chrome.notifications.create({
             type: 'basic',
             iconUrl: 'icons/briefly-48.png',
             title: success ? 'AI Studio Automation' : 'AI Studio Automation Failed',
             message: errorMessage
         });
    }
    return success;
}

async function handleCopyTranscript(url) {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error', message: 'Could not identify YouTube Video ID.' });
        return;
    }
    const result = await fetchTranscriptFromLocalAPI(videoId);
    if (result?.status === "success" && result.transcript) {
        await copyToClipboardViaOffscreen(result.transcript);
    } else {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/briefly-48.png',
            title: 'Transcript Error',
            message: result?.message || 'Failed to get transcript for copying.'
        });
    }
}

async function handleSummarizeInStudio(url) {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error', message: 'Could not identify YouTube Video ID for summarization.' });
        return;
    }
    const result = await fetchTranscriptFromLocalAPI(videoId);
    if (result?.status !== "success" || typeof result.transcript !== 'string' || !result.transcript.trim()) {
        let message = result?.message || 'Failed to get a valid transcript for summarization.';
        if (result?.status === "success" && (typeof result.transcript !== 'string' || !result.transcript.trim())) {
            message = 'Transcript from API was empty or invalid.';
        }
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Automation Error', message: message });
        return;
    }
    const promptText = `Summarize the following YouTube video transcript. Be concise but ensure all key information, data points, and unique insights are retained. The summary should be well-structured for easy reading:\n\n---\n\n${result.transcript}\n\n---`;
    let aiTab;
    try {
         aiTab = await chrome.tabs.create({ url: "https://aistudio.google.com/", active: true });
         if (!aiTab?.id) throw new Error("Failed to get tab ID when creating AI Studio tab.");
    } catch (error) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Error Opening Tab', message: `Could not open AI Studio: ${error?.message || 'Unknown'}` });
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
                }, 500);
            }
        }
    };
    chrome.tabs.onUpdated.addListener(tabUpdateListener);
    const timeoutId = setTimeout(() => {
        if (listenerAttached) {
            listenerAttached = false;
            chrome.tabs.onUpdated.removeListener(tabUpdateListener);
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/briefly-48.png',
                title: 'Automation Warning',
                message: 'AI Studio tab took too long to load or did not reach the expected URL. Automation might not have run correctly.'
            });
            if (aiTab.id) {
                 automateAIStudio(aiTab.id, promptText);
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
            targetUrlPatterns: ["*://*.youtube.com/watch*", "*://youtu.be/*"]
        });
        chrome.contextMenus.create({
            id: "summarizeInAIStudio",
            title: "Briefly: Summarize in AI Studio",
            contexts: ["link"],
            targetUrlPatterns: ["*://*.youtube.com/watch*", "*://youtu.be/*"]
        });
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info.linkUrl) return;
    if (info.menuItemId === "getAndCopyTranscript") {
        await handleCopyTranscript(info.linkUrl);
    } else if (info.menuItemId === "summarizeInAIStudio") {
        await handleSummarizeInStudio(info.linkUrl);
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'copyTranscript' && message.url) {
        handleCopyTranscript(message.url);
        return false; 
    } else if (message.action === 'summarizeInStudio' && message.url) {
        handleSummarizeInStudio(message.url);
        return false; 
    }
    return false; 
});

console.log("Briefly background script loaded.");