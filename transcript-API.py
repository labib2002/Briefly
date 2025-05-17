# transcript-API.py
# Flask API to fetch YouTube video transcripts.
import logging
import sys
import time
from xml.etree.ElementTree import ParseError

from flask import Flask, request, jsonify
from flask_cors import CORS
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
from youtube_transcript_api.formatters import TextFormatter

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Core logic for fetching and formatting YouTube transcript with retries.
def get_youtube_transcript(video_id, max_retries=2, retry_delay=1):
    for attempt in range(max_retries + 1):
        try:
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
            transcript_to_fetch = None
            preferred_langs = ['en', 'en-US', 'en-GB', 'ar'] # English and Arabic, can be appended to and changed.
            try:
                transcript_to_fetch = transcript_list.find_transcript(preferred_langs)
            except NoTranscriptFound:
                try: # Fallback to any generated transcript
                    transcript_to_fetch = transcript_list.find_generated_transcript([])
                except NoTranscriptFound:
                    raise # Re-raise to be caught by the outer NoTranscriptFound
            
            transcript_data = transcript_to_fetch.fetch()
            if not transcript_data:
                return {"status": "error", "message": "Fetched transcript data was empty."}

            formatter = TextFormatter()
            plain_text = formatter.format_transcript(transcript_data)
            return {"status": "success", "transcript": plain_text}

        except TranscriptsDisabled:
            return {"status": "error", "message": "Transcripts are disabled for this video."}
        except NoTranscriptFound as e:
            return {"status": "error", "message": str(e)}
        except ParseError as e:
            if attempt < max_retries: time.sleep(retry_delay); continue
            return {"status": "error", "message": f"Failed to parse transcript after {max_retries + 1} attempts."}
        except Exception as e:
            logging.error(f"Unexpected error for {video_id} (attempt {attempt + 1}): {e}", exc_info=True)
            if attempt < max_retries: time.sleep(retry_delay); continue
            return {"status": "error", "message": f"Unexpected server error: {type(e).__name__}"}
    return {"status": "error", "message": f"Failed after {max_retries + 1} attempts for {video_id}."}

app = Flask(__name__)
CORS(app)

# API endpoint to get transcript by video_id.
@app.route('/get_transcript', methods=['GET'])
def api_get_transcript():
    video_id = request.args.get('video_id')
    if not video_id:
        return jsonify({"status": "error", "message": "Missing 'video_id' parameter"}), 400

    result = get_youtube_transcript(video_id)
    if result["status"] == "success": return jsonify(result), 200
    if "disabled" in result["message"].lower() or "no transcript found" in result["message"].lower() or "could not retrieve" in result["message"].lower():
        return jsonify(result), 404
    if "parse" in result["message"].lower() or "malformed data" in result["message"].lower():
        return jsonify(result), 503 # Service Unavailable for parsing issues
    return jsonify(result), 500

if __name__ == '__main__':
    print("Starting Flask server for YouTube Transcripts...")
    print(f"Python Version: {sys.version.split()[0]}")
    print("Endpoint: http://127.0.0.1:5678/get_transcript?video_id=YOUR_VIDEO_ID")
    app.run(host='127.0.0.1', port=5678, debug=False)