document.addEventListener('DOMContentLoaded', () => {
  const copyButton = document.getElementById('copyTranscriptBtn');
  const summarizeButton = document.getElementById('summarizeStudioBtn');
  const statusElement = document.getElementById('statusMessage');

  function showStatus(message, type = 'info') { 
    statusElement.textContent = message;
    statusElement.className = 'status-message'; 
    if (type === 'error') {
      statusElement.classList.add('error');
    } else if (type === 'success') {
      statusElement.classList.add('success');
    }

  }

  function setLoadingState(button, isLoading, originalText) {
    if (isLoading) {
      button.disabled = true;
      button.textContent = 'Processing...';
    } else {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  copyButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const currentUrl = tabs[0]?.url;
      if (!currentUrl) {
        showStatus('Cannot get current tab URL.', 'error');
        return;
      }

      setLoadingState(copyButton, true, 'Copy Transcript');
      chrome.runtime.sendMessage({ action: 'copyTranscript', url: currentUrl }, (response) => {

        if (chrome.runtime.lastError) {
          showStatus(`Error sending request: ${chrome.runtime.lastError.message}`, 'error');
          setLoadingState(copyButton, false, 'Copy Transcript');
        } else {

        }

        window.close();
      });
    });
  });

  summarizeButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const currentUrl = tabs[0]?.url;
      if (!currentUrl) {
        showStatus('Cannot get current tab URL.', 'error');
        return;
      }

      setLoadingState(summarizeButton, true, 'Summarize in AI Studio');
      chrome.runtime.sendMessage({ action: 'summarizeInStudio', url: currentUrl }, (response) => {
        if (chrome.runtime.lastError) {
          showStatus(`Error sending request: ${chrome.runtime.lastError.message}`, 'error');
          setLoadingState(summarizeButton, false, 'Summarize in AI Studio');
        }
        window.close();
      });
    });
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentUrl = tabs[0]?.url;
    if (currentUrl && (currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/'))) {
      copyButton.disabled = false;
      summarizeButton.disabled = false;
      showStatus('Ready to process this YouTube video.');
    } else {
      copyButton.disabled = true;
      summarizeButton.disabled = true;
      showStatus('Open a YouTube video page to use these features.', 'info');
      copyButton.title = "Only active on YouTube video pages.";
      summarizeButton.title = "Only active on YouTube video pages.";
    }
  });
});