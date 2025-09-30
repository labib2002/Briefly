// AI Studio Content Script.

// Waits for a DOM element to appear.
function waitForElement(selector, timeout = 15000, parentElement = document) {
    return new Promise((resolve, reject) => {
        const intervalTime = 500; let elapsedTime = 0;
        const interval = setInterval(() => {
            const element = parentElement.querySelector(selector);
            if (element) { clearInterval(interval); resolve(element); }
            else {
                elapsedTime += intervalTime;
                if (elapsedTime >= timeout) { clearInterval(interval); reject(new Error(`Element TIMED OUT: "${selector}"`));}
            }
        }, intervalTime);
    });
}

// Waits for a specific condition to become true.
function waitForCondition(conditionFn, timeout = 5000, conditionName = "condition") {
    return new Promise((resolve, reject) => {
        const intervalTime = 250; let elapsedTime = 0;
        const interval = setInterval(() => {
            if (conditionFn()) { clearInterval(interval); resolve(true); }
            else {
                elapsedTime += intervalTime;
                if (elapsedTime >= timeout) { clearInterval(interval); resolve(false);}
            }
        }, intervalTime);
    });
}

// Simulates user input into a textarea element.
function setTextAreaValue(textareaElement, value) {
    if (!textareaElement) return false;
    try {
        textareaElement.focus();
        textareaElement.value = ""; // Clear first
        textareaElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        textareaElement.value = value;
        textareaElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); // Crucial for frameworks
        return true;
    } catch (e) { return false; }
}

// Selects the desired AI model if not already selected.
async function selectModelIfNeeded(modelNameSubstring) {
    try {
        const modelSelectorCard = await waitForElement('ms-model-selector-v3 .model-selector-card');
        const currentModelDisplay = modelSelectorCard.querySelector('.title');
        const modelNameLower = modelNameSubstring.toLowerCase();

        // Robust check: case-insensitive
        if (currentModelDisplay && currentModelDisplay.textContent.toLowerCase().includes(modelNameLower)) {
            console.log(`Model "${modelNameSubstring}" is already selected.`);
            return true;
        }

        modelSelectorCard.click();
        const modelPanel = await waitForElement('ms-sliding-right-panel');
        let desiredOption = null;

        // Find the option. Prioritize data-test-id, then fall back to text content.
        const options = modelPanel.querySelectorAll('[data-test-id="model-name"], button, div.title');
        for (const el of options) {
            const elText = el.textContent.toLowerCase();
            if (elText.includes(modelNameLower)) {
                desiredOption = el.closest('button') || el; // Find the clickable parent
                break;
            }
        }

        if (desiredOption) {
            desiredOption.click();
            const success = await waitForCondition(
                () => modelSelectorCard.querySelector('.title')?.textContent.toLowerCase().includes(modelNameLower),
                5000,
                `Model update to "${modelNameSubstring}"`
            );
            if (!success) {
                 console.warn(`Failed to confirm model update to "${modelNameSubstring}" after clicking. Continuing anyway.`);
            }
            return true;
        } else {
            console.warn(`Could not find an option for model "${modelNameSubstring}".`);
            const closeButton = modelPanel.querySelector('button[aria-label="Close"]');
            if (closeButton) closeButton.click();
            return false;
        }
    } catch (error) {
        console.error("Error in selectModelIfNeeded:", error);
        return false;
    }
}

// Disables "Thinking mode" in AI Studio settings if enabled.
async function disableThinkingModeIfNeeded() {
    try {
        const runSettingsPanel = await waitForElement('ms-right-side-panel ms-run-settings');
        const thinkingModeSwitchButton = await waitForElement('mat-slide-toggle[data-test-toggle="enable-thinking"] button[role="switch"]', 5000, runSettingsPanel);

        // Check if the switch is disabled
        if (thinkingModeSwitchButton.disabled || thinkingModeSwitchButton.getAttribute('aria-disabled') === 'true') {
            console.warn("Thinking mode toggle is disabled. Cannot change setting.");
            return true; // Continue gracefully
        }

        // If it's on, try to turn it off
        if (thinkingModeSwitchButton.getAttribute('aria-checked') === 'true') {
            thinkingModeSwitchButton.click();
            const turnedOff = await waitForCondition(
                () => thinkingModeSwitchButton.getAttribute('aria-checked') === 'false',
                5000,
                "Thinking mode disable"
            );
            if (!turnedOff) {
                console.warn("Thinking mode did not toggle off after 5 seconds. Continuing anyway.");
            }
        }
        return true;
    } catch (error) {
        console.warn("Could not find or interact with the Thinking mode toggle. This might be expected.", error);
        return true; // Return true to not block the main process.
    }
}

// Main message listener for actions from the background script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'injectDataAndRun') {
        (async () => {
            let success = false;
            let errorMessage = "Automation sequence did not complete successfully.";
            try {
                await selectModelIfNeeded("Gemini 2.5 Flash Preview");
                await disableThinkingModeIfNeeded();

                const textareaSelector = 'textarea[aria-label="Type something or tab to choose an example prompt"]';
                const textareaFallbackSelector = 'ms-autosize-textarea textarea';
                let textarea;
                try { textarea = await waitForElement(textareaSelector); }
                catch (e) { textarea = await waitForElement(textareaFallbackSelector); }

                const runButton = await waitForElement('button[aria-label="Run"]');
                if (!setTextAreaValue(textarea, message.prompt)) throw new Error("Failed to set text in textarea.");
                await waitForCondition(() => runButton && !runButton.disabled, 5000, "Run button enable");
                if (!runButton || runButton.disabled) console.warn("Run button still disabled, attempting click anyway.");
                runButton.click();
                success = true;
                errorMessage = "Automation sequence initiated.";
            } catch (error) {
                errorMessage = error.message;
            } finally {
                 sendResponse({ success: success, error: success ? null : errorMessage });
            }
        })();
        return true; // Asynchronous response
    } else {
         sendResponse({ success: false, error: "Unknown action." });
    }
});