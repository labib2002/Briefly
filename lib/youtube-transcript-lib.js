const RE_YOUTUBE =
  /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)";
const RE_XML_TRANSCRIPT =
  /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

export class YoutubeTranscriptError extends Error {
  constructor(message) {
    super(`[YoutubeTranscript] 🚨 ${message}`);
    this.name = "YoutubeTranscriptError";
  }
}

export class YoutubeTranscriptTooManyRequestError extends YoutubeTranscriptError {
  constructor() {
    super(
      "YouTube is receiving too many requests from this IP and now requires solving a captcha to continue"
    );
    this.name = "YoutubeTranscriptTooManyRequestError";
  }
}

export class YoutubeTranscriptVideoUnavailableError extends YoutubeTranscriptError {
  constructor(videoId) {
    super(`The video is no longer available (${videoId})`);
    this.name = "YoutubeTranscriptVideoUnavailableError";
  }
}

export class YoutubeTranscriptDisabledError extends YoutubeTranscriptError {
  constructor(videoId) {
    super(`Transcript is disabled on this video (${videoId})`);
    this.name = "YoutubeTranscriptDisabledError";
  }
}

export class YoutubeTranscriptNotAvailableError extends YoutubeTranscriptError {
  constructor(videoId) {
    super(`No transcripts are available for this video (${videoId})`);
    this.name = "YoutubeTranscriptNotAvailableError";
  }
}

export class YoutubeTranscriptNotAvailableLanguageError extends YoutubeTranscriptError {
  constructor(lang, availableLangs, videoId) {
    const langsString =
      availableLangs && availableLangs.length > 0
        ? availableLangs.join(", ")
        : "none found";
    super(
      `No transcripts are available in the requested language '${lang}' for this video (${videoId}). Available languages: ${langsString}`
    );
    this.name = "YoutubeTranscriptNotAvailableLanguageError";
    this.availableLangs = availableLangs || [];
  }
}

export class YoutubeTranscript {
  static async fetchTranscript(videoId, config = {}) {
    const identifier = this.retrieveVideoId(videoId);
    const requestedLang = config.lang || "en"; 

    const videoPageResponse = await fetch(`https://www.youtube.com/watch?v=${identifier}`,
      {
        headers: {

          "Accept-Language": requestedLang + ",en;q=0.9", 
          "User-Agent": USER_AGENT,
        },
      }
    );
    const videoPageBody = await videoPageResponse.text();

    const splittedHTML = videoPageBody.split('"captions":');

    if (splittedHTML.length <= 1) {
      if (videoPageBody.includes('class="g-recaptcha"')) {
        throw new YoutubeTranscriptTooManyRequestError();
      }
      if (!videoPageBody.includes('"playabilityStatus":')) {

        throw new YoutubeTranscriptVideoUnavailableError(identifier);
      }
      throw new YoutubeTranscriptDisabledError(identifier);
    }

    const captionsJson = (() => {
      try {
        return JSON.parse(
          splittedHTML[1].split(',"videoDetails')[0].replace(/\n/g, "") 
        );
      } catch (e) {
        console.error(
          "Failed to parse captions JSON from video page:",
          e,
          "Video ID:",
          identifier
        );
        return undefined;
      }
    })()?.playerCaptionsTracklistRenderer;

    if (!captionsJson) {

      console.warn(
        "captionsJson or playerCaptionsTracklistRenderer not found for video:",
        identifier
      );
      throw new YoutubeTranscriptDisabledError(identifier); 
    }

    if (
      !captionsJson.captionTracks ||
      captionsJson.captionTracks.length === 0
    ) {
      throw new YoutubeTranscriptNotAvailableError(identifier); 
    }

    let targetTrack;
    let finalLangCode = requestedLang; 

    targetTrack = captionsJson.captionTracks.find(
      (track) => track.languageCode === requestedLang
    );

    if (!targetTrack && requestedLang !== "en") {

      targetTrack = captionsJson.captionTracks.find(
        (track) => track.languageCode === "en"
      );
      if (targetTrack) {
        finalLangCode = "en";
      }
    }

    if (!targetTrack && captionsJson.captionTracks.length > 0) {

      targetTrack = captionsJson.captionTracks[0];
      finalLangCode = targetTrack.languageCode;
    }

    if (!targetTrack) {
      const availableLangs = captionsJson.captionTracks.map(
        (track) => track.languageCode
      );
      throw new YoutubeTranscriptNotAvailableLanguageError(
        requestedLang,
        availableLangs,
        identifier
      );
    }

    const transcriptURL = targetTrack.baseUrl;

    const transcriptResponse = await fetch(transcriptURL, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (!transcriptResponse.ok) {
      console.error(
        `Failed to fetch transcript XML from ${transcriptURL}. Status: ${transcriptResponse.status}`
      );
      throw new YoutubeTranscriptNotAvailableError(identifier); 
    }
    const transcriptBody = await transcriptResponse.text();
    const results = [...transcriptBody.matchAll(RE_XML_TRANSCRIPT)];

    if (results.length === 0 && transcriptBody.trim() !== "") {

    }

    return results.map((result) => ({
      text: this.unescapeHtml(result[3]),
      duration: parseFloat(result[2]),
      offset: parseFloat(result[1]),
      lang: finalLangCode, 
    }));
  }

  static retrieveVideoId(videoId) {
    if (typeof videoId !== "string") {
      throw new YoutubeTranscriptError("Video ID must be a string.");
    }

    if (videoId.length === 11 && /^[a-zA-Z0-9_-]+$/.test(videoId)) {
      return videoId;
    }
    const matchId = videoId.match(RE_YOUTUBE);
    if (matchId && matchId[1] && matchId[1].length === 11) {
      return matchId[1];
    }
    throw new YoutubeTranscriptError(
      `Impossible to retrieve Youtube video ID from "${videoId}". It should be an 11-char string or a valid YouTube URL.`
    );
  }

  static unescapeHtml(html) {
    if (typeof html !== "string") return "";

    try {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = html;
      return textarea.value;
    } catch (e) {

      return html
        .replace(/"/g, '"')
        .replace(/'/g, "'")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/&/g, "&"); 
    }
  }
}