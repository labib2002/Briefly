export type CaptionTrackName =
  | string
  | {
      simpleText?: string;
      runs?: Array<{
        text?: string;
      }>;
    };

export type CaptionTrackLike = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: CaptionTrackName;
  vssId?: string;
};

export type TranslationLanguageLike = {
  languageCode?: string;
};

export function getCaptionTrackName(track: CaptionTrackLike): string {
  if (typeof track.name === 'string') {
    return track.name.trim();
  }

  if (track.name?.simpleText) {
    return track.name.simpleText.trim();
  }

  return track.name?.runs?.map((run) => run.text ?? '').join('').trim() ?? '';
}

export function summarizeCaptionTrack(track: CaptionTrackLike) {
  return {
    languageCode: track.languageCode,
    kind: track.kind,
    vssId: track.vssId,
    name: getCaptionTrackName(track),
  };
}

export function selectCaptionTrack<T extends CaptionTrackLike>(
  tracks: T[] | undefined,
): T | null {
  if (!tracks?.length) {
    return null;
  }

  const rankedTracks = [...tracks].sort((left, right) => {
    const score = (track: CaptionTrackLike) => {
      const language = track.languageCode ?? '';
      const name = getCaptionTrackName(track).toLowerCase();
      let total = 0;

      if (language.startsWith('en')) {
        total += 4;
      }

      if (track.kind !== 'asr') {
        total += 3;
      }

      if (name.includes('english')) {
        total += 2;
      }

      if (track.vssId?.includes('.en')) {
        total += 1;
      }

      return total;
    };

    return score(right) - score(left);
  });

  return rankedTracks[0] ?? null;
}

export function resolveCaptionTrackSelection<T extends CaptionTrackLike>(
  tracks: T[] | undefined,
  translationLanguages: TranslationLanguageLike[] | undefined,
  preferredLanguageCode = 'en',
): {
  track: T | null;
  targetLanguageCode?: string;
} {
  const track = selectCaptionTrack(tracks);

  if (!track) {
    return {
      track: null,
    };
  }

  if ((track.languageCode ?? '').startsWith(preferredLanguageCode)) {
    return {
      track,
    };
  }

  const translatedLanguage = translationLanguages?.find((language) =>
    (language.languageCode ?? '').startsWith(preferredLanguageCode),
  );

  if (!translatedLanguage?.languageCode) {
    return {
      track,
    };
  }

  return {
    track,
    targetLanguageCode: translatedLanguage.languageCode,
  };
}
