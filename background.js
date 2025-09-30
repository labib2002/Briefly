// Briefly — Background (MV3 Service Worker)

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';

// ---------------- Clipboard via Offscreen ----------------

let creatingOffscreen;

async function setupOffscreenDocument(path) {
  const url = chrome.runtime.getURL(path);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (existing.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Write to clipboard from service worker'
    });
  }
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function ensureOffscreenReady() {
  await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
  for (let i = 0; i < 10; i++) {
    try {
      const pong = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
      if (pong?.ready) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 50));
  }
}

async function copyToClipboardViaOffscreen(textToCopy) {
  if (typeof textToCopy !== 'string') {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/briefly-48.png',
      title: 'Clipboard Error', message: 'Invalid data for copying.'
    });
    return false;
  }

  await ensureOffscreenReady();

  const trySend = async () => {
    try {
      return await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'copy-to-clipboard', data: textToCopy
      });
    } catch (e) {
      return { success: false, error: e?.message || 'sendMessage failed' };
    }
  };

  let response = await trySend();

  if (!response || response.success !== true) {
    await new Promise(r => setTimeout(r, 120));
    response = await trySend();
  }

  if (response && response.success) return true;

  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/briefly-48.png',
    title: 'Copy Failed', message: `Could not copy: ${response?.error || 'Unknown reason'}`
  });
  return false;
}

// ---------------- Helpers ----------------

function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1).split('?')[0];
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(shorts|embed)\/([^/?#]+)/);
    if (m) return m[2];
  } catch {}
  return null;
}

function vttToPlainText(vtt) {
  const lines = vtt.split(/\r?\n/);
  const out = [];
  let currentText = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
        if(currentText) out.push(currentText);
        currentText = '';
        continue;
    };
    if (/^WEBVTT/i.test(line) || /^(NOTE|STYLE|REGION)/i.test(line) || /^\d+$/.test(line) || /-->/.test(line)) {
        if(currentText) out.push(currentText);
        currentText = '';
        continue;
    }
    currentText += (currentText ? ' ' : '') + line.replace(/<[^>]+>/g, '');
  }
  if(currentText) out.push(currentText);
  return out.filter((line, index, self) => self.indexOf(line) === index).join(' ');
}

// ---------------- Unofficial transcript (watch page scrape) ----------------

async function fetchTranscriptWeb(videoId, preferredLangs = ['en', 'en-US', 'en-GB']) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Accept-Language': 'en' }
  });
  const html = await res.text();

  const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
  if (!prMatch) throw new Error('Could not locate player response.');
  const player = JSON.parse(prMatch[1]);

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('No caption tracks found for this video.');

  const score = (t) => {
    let s = 0;
    if (!t.kind || !/asr/i.test(t.kind)) s += 5;
    if (preferredLangs.includes(t.languageCode)) s += 3;
    if (/^en\b/i.test(t.languageCode)) s += 2;
    return s;
    };
  tracks.sort((a, b) => score(b) - score(a));
  const track = tracks[0];
  let url = track?.baseUrl;
  if (!url) throw new Error('Selected caption track has no URL.');

  if (!/[?&]fmt=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'fmt=vtt';
  }

  const vttRes = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!vttRes.ok) throw new Error(`Caption fetch failed with status: ${vttRes.status}`);
  const vtt = await vttRes.text();
  const text = vttToPlainText(vtt);
  if (!text.trim()) throw new Error('Transcript is empty.');
  return text;
}

// ---------------- Official YouTube Data API (owned videos only) ----------------

async function getOAuthTokenInteractive() {
  return new Promise((resolve) => {
    if (!chrome.identity || !chrome.identity.getAuthToken) return resolve(null);
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(token || null);
    });
  });
}

async function fetchTranscriptOfficial(videoId) {
  const token = await getOAuthTokenInteractive();
  if (!token) throw new Error('OAuth not configured or user not signed in.');

  const listRes = await fetch(`https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!listRes.ok) throw new Error(`Official API (captions.list) failed: ${listRes.status}`);
  const list = await listRes.json();
  const item = list.items?.[0];
  if (!item?.id) throw new Error('No caption tracks available via API (or you lack permission).');

  const dlRes = await fetch(`https://www.googleapis.com/youtube/v3/captions/${item.id}?tfmt=vtt`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!dlRes.ok) throw new Error(`Official API (captions.download) failed: ${dlRes.status}`);
  const vtt = await dlRes.text();
  const text = vttToPlainText(vtt);
  if (!text.trim()) throw new Error('Empty transcript from official API.');
  return text;
}

// ---------------- Unified transcript fetch ----------------

const TRANSCRIPT_PROVIDER = 'auto'; // 'auto' | 'web' | 'official'

async function getTranscript(videoId) {
  if (TRANSCRIPT_PROVIDER === 'web') {
    return await fetchTranscriptWeb(videoId);
  }
  if (TRANSCRIPT_PROVIDER === 'official') {
    return await fetchTranscriptOfficial(videoId);
  }
  // auto
  try {
    return await fetchTranscriptWeb(videoId);
  } catch (e1) {
    try {
      return await fetchTranscriptOfficial(videoId);
    } catch (e2) {
      throw new Error(`Web: ${e1?.message || e1} | Official: ${e2?.message || e2}`);
    }
  }
}

// ---------------- Popup actions ----------------

async function handleCopyTranscript(url, sendResponse) {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    const payload = { status: 'error', message: 'Could not identify YouTube video ID.' };
    sendResponse?.(payload);
    return;
  }

  try {
    const transcript = await getTranscript(videoId);
    const copied = await copyToClipboardViaOffscreen(transcript);
    if (copied) {
      sendResponse?.({ status: 'success', message: 'Transcript copied!' });
    } else {
      sendResponse?.({ status: 'error', message: 'Failed to copy to clipboard.' });
    }
  } catch (err) {
    const payload = { status: 'error', message: String(err?.message || err) };
    sendResponse?.(payload);
  }
}

async function handleSummarizeInStudio(url, sendResponse) {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    sendResponse?.({ status: 'error', message: 'Could not identify YouTube video ID.' });
    return;
  }

  try {
    const transcript = await getTranscript(videoId);
    await chrome.storage.local.set({ 'briefly:lastTranscript': transcript });
    await chrome.tabs.create({ url: 'https://aistudio.google.com/' });
    sendResponse?.({ status: 'success_fetch', message: 'Transcript ready. Opening AI Studio…' });
  } catch (err) {
    sendResponse?.({ status: 'error', message: String(err?.message || err) });
  }
}

// Message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'copyTranscriptFromPopup' && message.url) {
    handleCopyTranscript(message.url, sendResponse);
    return true;
  }
  if (message?.action === 'summarizeInStudioFromPopup' && message.url) {
    handleSummarizeInStudio(message.url, sendResponse);
    return true;
  }
  return false;
});

// --- Context Menus ---
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info.linkUrl) return;

    if (info.menuItemId === "getAndCopyTranscript") {
        await handleCopyTranscript(info.linkUrl, null);
    } else if (info.menuItemId === "summarizeInAIStudio") {
        await handleSummarizeInStudio(info.linkUrl, null);
    }
});


console.log('Briefly background script loaded.');