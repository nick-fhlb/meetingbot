import fs from "fs";
import puppeteer, { Page, Frame } from "puppeteer";
import { launch, getStream, wss } from "puppeteer-stream";
import { BotConfig, EventCode, WaitingRoomTimeoutError } from "../../src/types";
import { Bot } from "../../src/bot";
import path from "path";



// Constant Selectors
const muteButton = 'button[aria-label="Mute"]';
const stopVideoButton = 'button[aria-label="Stop Video"]';
const joinButton = 'button.zm-btn.preview-join-button';
const leaveButton = 'button[aria-label="Leave"]';
const acceptCookiesButton = '#onetrust-accept-btn-handler';
const acceptTermsButton = '#wc_agree1';
import { Browser } from "puppeteer";
import { Transform } from "stream";

export class ZoomBot extends Bot {
  recordingPath: string;
  contentType: string;
  url: string;
  browser!: Browser;
  page!: Page;
  file!: fs.WriteStream;
  stream!: Transform;

  constructor(
    botSettings: BotConfig,
    onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.recordingPath = path.resolve(__dirname, "recording.mp4");
    this.contentType = "video/mp4";
    this.url = `https://app.zoom.us/wc/${this.settings.meetingInfo.meetingId}/join?fromPWA=1&pwd=${this.settings.meetingInfo.meetingPassword}`;
  }


  async screenshot(fName: string = "screenshot.png") {
    try {
      if (!this.page) throw new Error("Page not initialized");
      if (!this.browser) throw new Error("Browser not initialized");

      const screenshot = await this.page.screenshot({
        type: "png",
        encoding: "binary",
      });

      // Save the screenshot to a file
      const screenshotPath = path.resolve(`/tmp/${fName}`);
      fs.writeFileSync(screenshotPath, screenshot);
      console.log(`Screenshot saved to ${screenshotPath}`);
    } catch (e) {
      console.log('Error taking screenshot:', e);
    }
  }

  async checkKicked(): Promise<boolean> {

    //TODO: Implement this
    return false;
  }

  /** Launch browser
   * 
   */
  async launchBrowser() {

    // Launch a browser and open the meeting
    this.browser = await launch({
      executablePath: puppeteer.executablePath(),
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--use-fake-device-for-media-stream",
        // "--use-fake-ui-for-media-stream"
      ],
    }) as unknown as Browser; // It looks like theres a type issue with puppeteer.

    console.log("Browser launched");

    // Create a URL object from the url
    const urlObj = new URL(this.url);

    // Get the default browser context
    const context = this.browser.defaultBrowserContext();

    // Clear permission overrides and set our own to camera and microphone
    // This is to avoid the allow microphone and camera prompts
    context.clearPermissionOverrides();
    context.overridePermissions(urlObj.origin, ["camera", "microphone"]);
    console.log('Turned off camera & mic permissions')

    // Opens a new page in the browser
    this.page = await this.browser.newPage();
  }


  /**
   * Opens a browser and navigatges, joins the meeting.
   * @returns {Promise<void>}
   */
  async joinMeeting() {

    // Launch
    await this.launchBrowser();

    // Create a URL object from the url
    const page = this.page;
    const urlObj = new URL(this.url);

    // Navigates to the url
    console.log("Atempting to open link");
    await page.goto(urlObj.href);
    console.log("Page opened");

    // Waits for the page's iframe to load
    console.log('Wating for iFrame to load')
    const iframe = await page.waitForSelector(".pwa-webclient__iframe");
    const frame = await iframe?.contentFrame();
    console.log("Opened iFrame");

    if (frame) {
      console.warn('into frame');
      // Wait for things to load (can be removed later in place of a check for a button to be clickable)
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.warn('promise 1');
      // Waits for mute button to be clickable and clicks it
      await new Promise((resolve) => setTimeout(resolve, 700)); // TODO: remove this line later
      console.warn('promise 2');

      // Checking if Cookies modal popped up
      try {
        await frame.waitForSelector(acceptCookiesButton, {
          timeout: 700,
        });
        frame.click(acceptCookiesButton);
        console.log('Cookies Accepted');
      } catch (error) {
        console.warn('Cookies modal not found');
      }

      // Checking if TOS modal popped up
      try {
        await frame.waitForSelector(acceptTermsButton, {
          timeout: 700,
        });
        frame.click(acceptTermsButton);
        console.log('TOS Accepted');
      } catch (error) {
        console.warn('TOS modal not found');
      }

      const buttonIds = await frame.$$eval('button', buttons =>
          buttons.map(b => ({
            text: b.innerText.trim(),        // what the user sees (handles nested <span>s)
            id:   b.id || '(no id)'          // fallback label if the id is empty
          }))
      );

      console.log('Buttons found in Zoom iframe:', buttonIds);

      await frame.waitForSelector(muteButton);
      console.warn('mute selector');
      await frame.click(muteButton);
      console.log("Muted");

      // Waits for the stop video button to be clickable and clicks it
      await new Promise((resolve) => setTimeout(resolve, 700)); // TODO: remove this line later
      await frame.waitForSelector(stopVideoButton);
      await frame.click(stopVideoButton);
      console.log("Stopped video");

      // Waits for the input field and types the name from the config
      await frame.waitForSelector("#input-for-name");
      await frame.type("#input-for-name", this.settings?.botDisplayName ?? "Meeting Bot");
      console.log("Typed name");

      // Clicks the join button
      await frame.waitForSelector(joinButton);
      await frame.click(joinButton);
      console.log("Joined the meeting");

      // wait for the leave button to appear (meaning we've joined the meeting)
      await new Promise((resolve) => setTimeout(resolve, 1400)); // Needed to wait for the aria-label to be properly attached
      try {
        await frame.waitForSelector(leaveButton, {
          timeout: this.settings.automaticLeave.waitingRoomTimeout,
        });
      } catch (error) {
        // Distinct error from regular timeout
        throw new WaitingRoomTimeoutError();
      }

      // Wait for the leave button to appear and be properly labeled before proceeding
      console.log("Leave button found and labeled, ready to start recording");
    } else {
      console.error('frame is not created!');
      console.error(frame);
      console.error(iframe);
    }
  }

  /**
   * Start Recording the meeting.
   */
  async startRecording() {
    // Check if the page is initialized
    if (!this.page) throw new Error("Page not initialized");

    // Create the Stream
    this.stream = await getStream(this.page as any, { audio: true, video: true });

    // Create and Write the recording to a file, pipe the stream to a fileWriteStream
    this.file = fs.createWriteStream(this.recordingPath);
    this.stream.pipe(this.file);

  }

  /**
   * Stop Recording the meeting.
   */
  async stopRecording() {

    // End the recording and close the file
    if (this.stream)
      this.stream.destroy();

  }


  async run() {

    // Navigate and join the meeting.
    await this.joinMeeting();

    // Ensure browser exists
    if (!this.browser)
      throw new Error("Browser not initialized");

    if (!this.page)
      throw new Error("Page is not initialized");

    // Start the recording -- again, type issue from importing.
    const stream = await this.startRecording();

    console.log("Recording...");

    // Get the Frame containing the meeting
    const iframe = await this.page.waitForSelector(".pwa-webclient__iframe");
    const frame = await iframe?.contentFrame();

    // Constantly check if the meeting has ended every second
    const checkMeetingEnd = () => new Promise<void>((resolve, reject) => {
      const poll = async () => {
        try {
          // Wait for the "Ok" button to appear which indicates the meeting is over
          const okButton = await frame?.waitForSelector(
              "button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue",
              { timeout: 1000 },
          );

          if (okButton) {
            console.log("Meeting ended");

            // Click the button to leave the meeting
            await okButton.click();

            // Stop Recording
            this.stopRecording();

            // End Life -- Close file, browser, and websocket server
            this.endLife();

            resolve();
            return;
          }

          // Schedule next iteration
          setTimeout(poll, 1000);
        } catch (err) {
          // If it was a timeout
          // @ts-ignore
          if (err?.name === "TimeoutError") {
            // The button wasn’t there in the last second. Running next iteration
            setTimeout(poll, 1000);
          } else {
            // If it was some other error we throw it
            reject(err);
          }
        }
      };

      poll();
    });

    // Constantly check if Meeting is still running, every minute
    const checkIfMeetingRunning = () => new Promise<void>((resolve, reject) => {
      const poll = async () => {
        try {
          // Checking if Leave buttons is present which indicates the meeting is still running
          const leaveButtonEl = await frame?.waitForSelector(
              leaveButton,
              { timeout: 700 },
          );

          if (leaveButtonEl) {
            console.warn('Meeting in progress');
            setTimeout(poll, 60000);
          } else {
            // Leave button not found within timeout window
            console.error("Meeting ended unexpectedly");

            this.stopRecording();
            this.endLife();

            resolve();
          }
        } catch (err) {
          // Only treat a timeout as “meeting ended”; rethrow anything else.
          // @ts-ignore
          if (err?.name === "TimeoutError") {
            console.error("Meeting ended unexpectedly");

            this.stopRecording();
            this.endLife();

            resolve();
          } else {
            reject(err);
          }
        }
      };

      poll();
    });

    // Start both meeting end checks in parallel and return once either of them finishes
    await Promise.race([
      checkMeetingEnd(),
      checkIfMeetingRunning()
    ]);
  }

  // Get the path to the recording file
  getRecordingPath(): string {
    return this.recordingPath;
  }

  // Get the content type of the recording file
  getContentType(): string {
    return this.contentType;
  }

  /**
   * Clean Resources, close the browser.
   * Ensure the filestream is closed as well.
   */
  async endLife() {

    // Ensure Recording is stopped in unideal situations
    this.stopRecording();

    // Close File if it exists
    if (this.file) {
      this.file.close();
      this.file = null as any;
    }

    // Close Browser
    if (this.browser) {
      await this.browser.close();

      // Close the websocket server
      (await wss).close();
    }
  }
}
