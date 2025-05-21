document.addEventListener('DOMContentLoaded', () => {
  const copyButton = document.getElementById('copyTranscriptBtn');
  const summarizeButton = document.getElementById('summarizeStudioBtn');
  const statusElement = document.getElementById('statusMessage');

  const copyButtonTextSpan = copyButton.querySelector('span');
  const summarizeButtonTextSpan = summarizeButton.querySelector('span');

  const originalCopyText = copyButtonTextSpan.textContent;
  const originalSummarizeText = summarizeButtonTextSpan.textContent;

  function showStatus(message, type = 'info') {
    statusElement.textContent = message;
    statusElement.className = 'status-message'; 

    if (message) { 
        if (type === 'error') {
            statusElement.classList.add('error');
        } else if (type === 'success') {
            statusElement.classList.add('success');
        }

    }

  }

  function setButtonStates(activeButton, isLoading) {
    const otherButton = (activeButton === copyButton) ? summarizeButton : copyButton;
    const activeBtnTextSpan = (activeButton === copyButton) ? copyButtonTextSpan : summarizeButtonTextSpan;
    const otherBtnTextSpan = (otherButton === copyButton) ? copyButtonTextSpan : summarizeButtonTextSpan;

    const originalActiveText = (activeButton === copyButton) ? originalCopyText : originalSummarizeText;
    const originalOtherText = (otherButton === copyButton) ? originalCopyText : originalSummarizeText;

    if (isLoading) {
      activeButton.disabled = true;
      activeBtnTextSpan.textContent = 'Processing'; 
      activeButton.classList.add('processing');

      otherButton.disabled = true;
      otherBtnTextSpan.textContent = originalOtherText;
      otherButton.classList.remove('processing');
    } else {
      activeButton.disabled = false;
      activeBtnTextSpan.textContent = originalActiveText;
      activeButton.classList.remove('processing');

      otherButton.disabled = false;
      otherBtnTextSpan.textContent = originalOtherText;
      otherButton.classList.remove('processing');
    }
  }

  copyButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs || tabs.length === 0 || !tabs[0].url) {
        showStatus('Cannot access current tab information.', 'error');
        return;
      }
      const currentUrl = tabs[0].url;

      setButtonStates(copyButton, true);
      showStatus('Fetching transcript...', 'info'); 

      chrome.runtime.sendMessage({ action: 'copyTranscriptFromPopup', url: currentUrl }, (response) => {
        if (chrome.runtime.lastError) {
          if (document.body.contains(statusElement)) { 
            showStatus(`Error: ${chrome.runtime.lastError.message}`, 'error');
            setButtonStates(copyButton, false);
          }
          return;
        }

        if (!document.body.contains(statusElement)) return;

        if (response) {
          if (response.status === 'success') {
            showStatus(response.message || 'Transcript copied!', 'success'); 
            setTimeout(() => window.close(), 2500); 
          } else {
            showStatus(response.message || 'Failed to copy transcript.', 'error');
            setButtonStates(copyButton, false);
          }
        } else {
          showStatus('No response from background.', 'error');
          setButtonStates(copyButton, false);
        }
      });
    });
  });

  summarizeButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs || tabs.length === 0 || !tabs[0].url) {
        showStatus('Cannot access current tab information.', 'error');
        return;
      }
      const currentUrl = tabs[0].url;

      setButtonStates(summarizeButton, true);
      showStatus('Preparing summarization...', 'info'); 

      chrome.runtime.sendMessage({ action: 'summarizeInStudioFromPopup', url: currentUrl }, (response) => {
        if (chrome.runtime.lastError) {
          if (document.body.contains(statusElement)) {
            showStatus(`Error: ${chrome.runtime.lastError.message}`, 'error');
            setButtonStates(summarizeButton, false);
          }
          return;
        }

        if (!document.body.contains(statusElement)) return;

        if (response && response.status === 'error') {
            showStatus(response.message || "Failed to start summarization.", 'error');
            setButtonStates(summarizeButton, false);
        } else if (response && response.status === 'success_fetch') {
            showStatus(response.message || "Opening AI Studio...", 'info'); 
            setTimeout(() => window.close(), 1500);
        } else { 

            window.close(); 
        }
      });
    });
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0 || !tabs[0].url) {
        copyButton.disabled = true;
        summarizeButton.disabled = true;
        showStatus('Cannot determine YouTube page status.', 'error');
        return;
    }
    const currentUrl = tabs[0].url;
    const isYouTubeVideo = currentUrl && (currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/') || currentUrl.includes('youtube.com/shorts'));

    if (isYouTubeVideo) {
      copyButton.disabled = false;
      summarizeButton.disabled = false;
      showStatus('Ready to go!', 'info'); 
    } else {
      copyButton.disabled = true;
      summarizeButton.disabled = true;
      showStatus('Navigate to a YouTube video page.', 'info'); 
      copyButton.title = "Only active on YouTube video pages.";
      summarizeButton.title = "Only active on YouTube video pages.";
    }
  });
});