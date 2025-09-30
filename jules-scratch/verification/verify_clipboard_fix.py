from playwright.sync_api import sync_playwright, expect
import pathlib
import time

# Define the path to the root of the extension directory.
extension_path = str(pathlib.Path(__file__).parent.parent.parent.resolve())
screenshot_path = "jules-scratch/verification/verification.png"

def run_verification():
    """
    Launches a browser with the extension, navigates to YouTube,
    triggers the copy action, and verifies the success message.
    """
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            "",  # Temporary user data directory
            headless=True,
            args=[
                f"--disable-extensions-except={extension_path}",
                f"--load-extension={extension_path}",
            ],
        )

        try:
            # Increased timeout and added logging for debugging
            start_time = time.time()
            service_worker = None
            timeout = 20  # Increased timeout to 20 seconds

            print("Searching for extension service worker...")
            while time.time() - start_time < timeout:
                workers = context.service_workers
                if workers:
                    print(f"DEBUG: Found {len(workers)} service workers. URLs: {[sw.url for sw in workers]}")

                service_worker = next((sw for sw in workers if 'background.js' in sw.url), None)
                if service_worker:
                    print(f"Successfully found service worker: {service_worker.url}")
                    break
                time.sleep(0.5)

            if not service_worker:
                print("Error: Could not find the service worker after the timeout period.")
                raise RuntimeError("Extension service worker not found.")

            extension_id = service_worker.url.split('/')[2]

            # Create a new page for the test
            page = context.new_page()

            # 1. Navigate to a YouTube video.
            youtube_video_url = "https://www.youtube.com/watch?v=jNQXAC9IVRw" # "Me at the zoo"
            page.goto(youtube_video_url, wait_until="domcontentloaded")

            # 2. Open the extension popup.
            popup_url = f"chrome-extension://{extension_id}/popup.html"
            page.goto(popup_url)

            # 3. Find elements.
            copy_button = page.locator("#copyTranscriptBtn")
            status_message = page.locator("#statusMessage")

            # 4. Assert initial state.
            expect(copy_button).to_be_enabled(timeout=10000)
            expect(status_message).to_have_text("Ready to go!")

            # 5. Act: Click the button.
            copy_button.click()

            # 6. Assert final state.
            expect(status_message).to_have_text("Transcript copied!", timeout=25000)

            # 7. Take screenshot.
            page.screenshot(path=screenshot_path)
            print(f"Screenshot successfully saved to {screenshot_path}")

        finally:
            context.close()

if __name__ == "__main__":
    run_verification()