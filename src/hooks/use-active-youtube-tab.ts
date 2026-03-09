import { useEffect, useState } from 'react';

import { extractYouTubeVideoId } from '../utils/youtube';

type ActiveYouTubeTab = {
  tab: chrome.tabs.Tab | null;
  url: string | null;
  videoId: string | null;
  isYouTubeVideo: boolean;
};

async function queryActiveTab(): Promise<ActiveYouTubeTab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const url = tab?.url ?? null;
  const videoId = url ? extractYouTubeVideoId(url) : null;

  return {
    tab: tab ?? null,
    url,
    videoId,
    isYouTubeVideo: Boolean(videoId),
  };
}

export function useActiveYouTubeTab(): ActiveYouTubeTab {
  const [state, setState] = useState<ActiveYouTubeTab>({
    tab: null,
    url: null,
    videoId: null,
    isYouTubeVideo: false,
  });

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const next = await queryActiveTab();
      if (!cancelled) {
        setState(next);
      }
    };

    const handleActivated = () => {
      void refresh();
    };

    const handleUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
        void refresh();
      }
    };

    const handleFocusChanged = () => {
      void refresh();
    };

    void refresh();
    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);
    chrome.windows.onFocusChanged.addListener(handleFocusChanged);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.windows.onFocusChanged.removeListener(handleFocusChanged);
    };
  }, []);

  return state;
}
