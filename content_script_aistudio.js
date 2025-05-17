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
        const modelSelectorTrigger = await waitForElement('prompt-header ms-model-selector mat-select');
        const currentModelDisplay = modelSelectorTrigger.querySelector('.mat-mdc-select-value-text .gmat-body-medium');
        if (currentModelDisplay && currentModelDisplay.textContent.includes(modelNameSubstring)) return true;

        modelSelectorTrigger.click();
        const modelDropdownPanel = await waitForElement('div.cdk-overlay-container div.mat-mdc-select-panel');
        let desiredOption = null;
        modelDropdownPanel.querySelectorAll('mat-option').forEach(opt => {
            const txtEl = opt.querySelector('.model-option-content .gmat-body-medium');
            if(txtEl && txtEl.textContent.includes(modelNameSubstring)) desiredOption = opt;
        });
        if (desiredOption) {
            desiredOption.click();
            return await waitForCondition(() => modelSelectorTrigger.querySelector('.mat-mdc-select-value-text .gmat-body-medium')?.textContent.includes(modelNameSubstring), 5000, "Model update");
        } else {
            if (document.querySelector('div.cdk-overlay-container div.mat-mdc-select-panel')) modelSelectorTrigger.click(); // Close dropdown
            return false;
        }
    } catch (error) { return false; }
}

// Disables "Thinking mode" in AI Studio settings if enabled.
async function disableThinkingModeIfNeeded() {
    try {
        const runSettingsPanelToggle = await waitForElement('ms-right-side-panel .toggles-container button[aria-label="Run settings"]');
        const runSettingsPanel = await waitForElement('ms-right-side-panel ms-run-settings');
        if (!runSettingsPanel.classList.contains('expanded')) {
            runSettingsPanelToggle.click();
            if (!await waitForCondition(() => runSettingsPanel.classList.contains('expanded'), 5000, "Run settings open")) return false;
        }
        const thinkingModeSwitch = await waitForElement('mat-slide-toggle[data-test-toggle="enable-thinking"] button[role="switch"]', 10000, runSettingsPanel);
        if (thinkingModeSwitch.getAttribute('aria-checked') === 'true') {
            thinkingModeSwitch.click();
            await waitForCondition(() => thinkingModeSwitch.getAttribute('aria-checked') === 'false', 5000, "Thinking mode disable");
        }
        return true;
    } catch (error) { return false; }
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