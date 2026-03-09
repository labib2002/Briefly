export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const directId = parsedUrl.searchParams.get('v');

    if (directId) {
      return directId;
    }

    if (parsedUrl.hostname.endsWith('youtu.be')) {
      return parsedUrl.pathname.slice(1) || null;
    }

    const pathnameMatch = parsedUrl.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{6,})/);
    return pathnameMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function normalizeYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
