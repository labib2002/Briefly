// Import the new library and the core Innertube class
import Innertube, { YTNodes } from './youtubei.js';

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

// --- Offscreen API for Clipboard (Unchanged) ---
async function copyToClipboardViaOffscreen(textToCopy) {
    if (typeof textToCopy !== 'string') {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Clipboard Error', message: 'Invalid data for copying.' });
        return false;
    }
    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy-to-clipboard', data: textToCopy });
    if (response && response.success) return true;
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Copy Failed', message: `Could not copy: ${response?.error || 'Unknown reason'}` });
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
        const urlObject = new URL(url);
        if (urlObject.hostname.includes('youtube.com') && urlObject.searchParams.has('v')) {
            return urlObject.searchParams.get('v');
        }
        if (urlObject.hostname.includes('youtu.be')) {
            return urlObject.pathname.substring(1);
        }
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
        // Step 1: Call /next to get the page data, which includes engagement panels
        const next_response = await yt.actions.execute("/next", { videoId });

        const engagement_panels = next_response.data.engagementPanels;
        if (!engagement_panels) {
            throw new Error("Engagement panels not found. Video may not have a transcript panel.");
        }

        // Step 2: Find the transcript panel and extract the parameters for the get_transcript call
        let transcript_params;
        for (const panel of engagement_panels) {
            if (panel.engagementPanelSectionListRenderer?.panelIdentifier === "engagement-panel-searchable-transcript") {
                transcript_params = panel.engagementPanelSectionListRenderer.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params;
                break;
            }
        }

        if (!transcript_params) {
            throw new Error("Transcript parameters not found. The video likely does not have a transcript.");
        }
        
        // Step 3: Call /get_transcript with the extracted parameters
        const transcript_response = await yt.actions.execute("/get_transcript", { params: transcript_params });
        
        const transcript_renderer = transcript_response.data.actions[0]?.updateEngagementPanelAction?.content?.transcriptRenderer;
        const segments = transcript_renderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
        
        if (segments && segments.length > 0) {
            const full_text = segments
                .map(segment => segment.transcriptSegmentRenderer.snippet.runs[0].text)
                .join(' ');
            return { status: "success", transcript: full_text };
        }

        return { status: "error", message: "No transcript content found in any available language." };

    } catch (error) {
        console.error("Error fetching transcript via API:", error);
        return { status: "error", message: `API Error: ${error.message}` };
    }
}


/**
 * NEW FALLBACK LOGIC
 * Fetches transcript using the official YouTube Data API v3.
 * @param {string} videoId
 * @returns {Promise<{status: string, transcript?: string, message?: string}>}
 */
async function fetchTranscriptWithOfficialApi(videoId) {
    const YOUTUBE_API_KEY = "YOUR_YOUTUBE_API_KEY"; // Placeholder for user's API key
    if (YOUTUBE_API_KEY === "YOUR_YOUTUBE_API_KEY") {
        return { status: "error", message: "Official YouTube API key is not set." };
    }

    try {
        // 1. List available caption tracks
        const listUrl = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${YOUTUBE_API_KEY}`;
        const listResponse = await fetch(listUrl);
        const listData = await listResponse.json();

        if (!listResponse.ok) {
            const errorMessage = listData.error?.message || `HTTP error! status: ${listResponse.status}`;
            throw new Error(errorMessage);
        }

        if (!listData.items || listData.items.length === 0) {
            return { status: "error", message: "No caption tracks found via official API." };
        }

        // 2. Prefer English, but fall back to the first available track
        const track = listData.items.find(item => item.snippet.language === 'en') || listData.items[0];

        // 3. Download the caption track in SRT format
        const downloadUrl = `https://www.googleapis.com/youtube/v3/captions/${track.id}?tfmt=srt&key=${YOUTUBE_API_KEY}`;
        const srtResponse = await fetch(downloadUrl);
         if (!srtResponse.ok) {
            const errorData = await srtResponse.json().catch(() => ({}));
            const errorMessage = errorData.error?.message || `HTTP error! status: ${srtResponse.status}`;
            throw new Error(`Failed to download SRT track: ${errorMessage}`);
        }
        const srtText = await srtResponse.text();

        // 4. Parse SRT: remove timestamps and line numbers to get clean text
        const parsedTranscript = srtText
            .split('\n')
            .filter(line => !/^\d+$/.test(line) && !line.includes('-->') && line.trim() !== '')
            .join(' ');

        if (parsedTranscript) {
            return { status: "success", transcript: parsedTranscript };
        }

        return { status: "error", message: "Failed to parse transcript from downloaded SRT file." };

    } catch (error) {
        console.error("Error fetching transcript via Official API:", error);
        return { status: "error", message: `Official API Error: ${error.message}` };
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

    let result = await fetchTranscriptWithApi(videoId);
    if (result.status !== "success") {
        console.log("Briefly: Primary API failed, trying official API fallback.");
        result = await fetchTranscriptWithOfficialApi(videoId);
    }

    if (result.status === "success" && result.transcript) {
        const copied = await copyToClipboardViaOffscreen(result.transcript);
        if (copied) {
            const payload = { status: "success", message: "Transcript copied!" };
             if (sendResponseToPopup) sendResponseToPopup(payload); else chrome.notifications.create({ type: 'basic', iconUrl: 'icons/briefly-48.png', title: 'Success', message: payload.message });
        } else {
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

    let result = await fetchTranscriptWithApi(videoId);
    if (result.status !== "success") {
        console.log("Briefly: Primary API failed, trying official API fallback for summarization.");
        result = await fetchTranscriptWithOfficialApi(videoId);
    }

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
    if (!info.linkUrl) return;
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
