import fs from "fs";
import puppeteer, {Browser, Page} from "puppeteer";
import {launch, getStream, wss} from "puppeteer-stream";
import {BotConfig, EventCode, SpeakerTimeframe, WaitingRoomTimeoutError} from "../../src/types";
import {Bot} from "../../src/bot";
import path from "path";
import {Transform} from "stream";

const leaveButtonSelector = 'button#hangup-button';
const rejoinButtonSelector = '[data-tid="calling-retry-rejoinbutton"]';
const continueButtonSelector = '[data-focus-target="gum-continue"]';
const joinWebButtonSelector = '[data-tid="joinOnWeb"]';
// TODO: pass this in meeting info
const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;


export class TeamsBot extends Bot {
  recordingPath: string;
  contentType: string;
  url: string;
  participants: string[];
  participantsIntervalId: NodeJS.Timeout;
  activityIntervalId: NodeJS.Timeout;
  browser!: Browser;
  page!: Page;
  file!: fs.WriteStream;
  stream!: Transform;
  private timeAloneStarted: number = Infinity;
  private lastActivity: number | null = null;
  private ended: boolean = false;

  constructor(
      botSettings: BotConfig,
      onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.recordingPath = "./recording.mp4";
    this.contentType = "video/mp4";
    this.url = `https://teams.live.com/meet/${this.settings.meetingInfo.meetingId}?p=${this.settings.meetingInfo.meetingPassword}`;
    this.participants = [];
    this.participantsIntervalId = setInterval(() => {
    }, 0);
    this.activityIntervalId = setInterval(() => {
    }, 0);
  }

  getRecordingPath(): string {
    return this.recordingPath;
  }

  getSpeakerTimeframes(): SpeakerTimeframe[] {
    // TODO: Implement this
    return []
  }

  getContentType(): string {
    return this.contentType;
  }

  async screenshot(fName: string = 'screenshot.png') {
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
      console.log('Error taking screenshot:');
    }
  }


  async launchBrowser() {
    let executablePath = puppeteer.executablePath(),
        headless = "new";
    if (process.env.NODE_ENV == "development") {
      executablePath = '/opt/homebrew/bin/chromium';
      headless = false;
    }
    // Launch the browser and open a new blank page
    this.browser = await launch({
      executablePath,
      headless,
      // args: ["--use-fake-ui-for-media-stream"],
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",

        // K8s/Docker stability (especially with small /dev/shm):
        "--disable-dev-shm-usage",

        // Make Teams happy about media devices (even if pod has none):
        "--use-fake-device-for-media-stream",
        // "--use-fake-ui-for-media-stream",
        "--use-file-for-fake-video-capture=/dev/null",
        "--use-file-for-fake-audio-capture=/dev/null",

        // Prevent Chrome from deprioritizing the meeting tab:
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",

        // Helps in some container audio-stack setups:
        // "--disable-features=AudioServiceOutOfProcess",
      ],
      protocolTimeout: 0,
    }) as unknown as Browser;

    // Parse the URL
    console.log("Parsing URL:", this.url);
    const urlObj = new URL(this.url);

    // Override camera and microphone permissions
    const context = this.browser.defaultBrowserContext();
    context.clearPermissionOverrides();
    context.overridePermissions(urlObj.origin, ["camera", "microphone"]);

    // Open a new page
    this.page = await this.browser.newPage();
    console.log('Opened Page');
  }


  async joinMeeting() {

    await this.launchBrowser();

    // Navigate the page to a URL
    const urlObj = new URL(this.url);
    console.log("Navigating to URL:", urlObj.href);
    await this.page.goto(urlObj.href);

    await this.joinProcedure();

    // Check if we're in a waiting room by checking if the join button exists and is disabled
    // const joinButton = await this.page.$('[data-tid="prejoin-join-button"]');
    // const isWaitingRoom =
    //   joinButton &&
    //   (await joinButton.evaluate((button) => button.hasAttribute("disabled")));
    const isWaitingRoom = true;

    let timeout = 30000; // if not in the waiting room, wait 30 seconds to join the meeting
    if (isWaitingRoom) {
      console.log(
          `Joined waiting room, will wait for ${this.settings.automaticLeave.waitingRoomTimeout > 60 * 1000
              ? `${this.settings.automaticLeave.waitingRoomTimeout / 60 / 1000
              } minute(s)`
              : `${this.settings.automaticLeave.waitingRoomTimeout / 1000
              } second(s)`
          }`
      );

      // if in the waiting room, wait for the waiting room timeout
      timeout = this.settings.automaticLeave.waitingRoomTimeout; // in milliseconds
    }

    // wait for the leave button to appear (meaning we've joined the meeting)
    try {
      await this.page.waitForSelector(leaveButtonSelector, {
        timeout: timeout,
      });
    } catch (error) {
      this.canceled = true;
      // Distinct error from regular timeout
      throw new WaitingRoomTimeoutError();
    }

    // Log Done
    console.log("Successfully joined meeting");
  }


  // Ensure we're not kicked from the meeting
  async checkKicked() {
    // TOOD: Implement this
    return false;
  }

  /**
   * Starts the recording of the call using ffmpeg.
   *
   * This function initializes an ffmpeg process to capture the screen and audio of the meeting.
   * It ensures that only one recording process is active at a time and logs the status of the recording.
   *
   * @returns {void}
   */
  async startRecording() {

    if (!this.page) throw new Error("Page not initialized");

    // Get the stream
    this.stream = await getStream(
        this.page as any, //puppeteer type issue
        {audio: true, video: true},
    );


    // Create a file
    this.file = fs.createWriteStream(this.getRecordingPath());
    this.stream.pipe(this.file);

    // Pipe the stream to a file
    console.log("Recording...");
  }

  async stopRecording() {
    // Stop recording
    if (this.stream) {
      console.log("Stopping recording...");
      this.stream.destroy();
    }
  }


  async run() {

    // Start Join
    await this.joinMeeting();

    //Create a File to record to
    this.file = fs.createWriteStream(this.getRecordingPath());

    // Click the people button
    console.log("Opening the participants list");
    await this.page.locator('[aria-label="People"]').click();

    // Wait for the attendees tree to appear
    console.log("Waiting for the attendees tree to appear");
    const tree = await this.page.waitForSelector('[role="tree"]');
    console.log("Attendees tree found");

    const updateParticipants = async () => {
      try {
        const currentParticipants = await this.page.evaluate(() => {
          const participantsList = document.querySelector('[role="tree"]');
          if (!participantsList) {
            console.log("No participants list found");
            return [];
          }

          const currentElements = Array.from(
              participantsList.querySelectorAll(
                  '[data-tid^="attendeesInMeeting-"]'
              )
          );

          return currentElements
              .map((el) => {
                const nameSpan = el.querySelector("span[title]");
                return (
                    nameSpan?.getAttribute("title") ||
                    nameSpan?.textContent?.trim() ||
                    ""
                );
              })
              .filter((name) => name);
        });

        this.participants = currentParticipants;
        if (this.participants.length > 1) {
          this.timeAloneStarted = Infinity;
        } else if (this.timeAloneStarted === Infinity) {
          this.timeAloneStarted = Date.now();
        }

        this.aloneCheck();
      } catch (error) {
        console.log("Error getting participants:", error);
      }
    };

    const checkActivity = async () => {
      try {
        const isActive = await this.page.evaluate(() => {
          return !!document.querySelector(`div.vdi-frame-occlusion`);
        });
        if (isActive) {
          console.log('Activity Detected!')
          this.lastActivity = Date.now();
          return;
        }
        console.log(`NO ACTIVITY. Waiting for activity timeout time to have allocated (${(Date.now() - this.lastActivity) / 1000} / ${this.settings.automaticLeave.inactivityTimeout / 1000}s) ...`);
        // Check if there has been no activity, case for when only bots stay in the meeting
        if (
            this.participants.length > 1 &&
            this.lastActivity &&
            Date.now() - this.lastActivity > this.settings.automaticLeave.inactivityTimeout
        ) {
          console.log(`No activity detected during ${this.settings.automaticLeave.inactivityTimeout / 1000}s, leaving`);
         await this.leave();
          return;
        }


      } catch (error) {
        console.log("Error checking Activity", error);
      }
    };

    // Get initial participants list
    await updateParticipants();

    // Then check for participants every heartbeatInterval milliseconds
    this.participantsIntervalId = setInterval(
        updateParticipants,
        this.settings.heartbeatInterval
    );

    // Then check for activity every 500 milliseconds
    this.activityIntervalId = setInterval(
        checkActivity,
        500
    );

    // Setting last activity time stamp to leave if nobody started talking
    this.lastActivity = Date.now();

    await this.startRecording();

    await this.checkForMeetingEnded();
    console.log("Meeting ended");

    this.endLife();
  }

  /**
   * Clean Resources, close the browser.
   * Ensure the filestream is closed as well.
   */
  async endLife() {

    if (this.ended) {
      // Avoiding double call
      return;
    }
    this.ended = true;
    // Trying to leave the meeting
    try {
      await this.page.locator(leaveButtonSelector).click();
    } catch (error) {
      // Doing nothing
    }
    // Close File if it exists
    if (this.file) {
      this.file.close();
      this.file = null as any;
    }

    // Clear any intervals or timeouts to prevent open handles
    if (this.participantsIntervalId) {
      clearInterval(this.participantsIntervalId);
    }

    if (this.activityIntervalId) {
      clearInterval(this.activityIntervalId);
    }

    // Ensure Recording is done
    console.log('Stopping Recording ...')
    await this.stopRecording();
    console.log('Done.')

    // Close my browser
    if (this.browser) {
      await this.browser.close();
      console.log("Closed Browser.");
    }
  }

  async aloneCheck() {
    const leaveMs = this.settings?.automaticLeave?.everyoneLeftTimeout ?? 30000; // Default to 30 seconds if not set
    const msDiff = Date.now() - this.timeAloneStarted;
    if (this.timeAloneStarted !== Infinity) {
      console.log(`Only me left in the meeting. Waiting for timeout time to have allocated (${msDiff / 1000} / ${leaveMs / 1000}s) ...`);
    }


    if (msDiff > leaveMs) {
      console.log('Only one participant remaining for more than alocated time, leaving the meeting.');
      await this.leave()
    }
  }

  async checkForMeetingEnded() {
    const check = async (resolve: () => void): Promise<void> => {
      try {
        await this.page.waitForSelector(
            leaveButtonSelector,
            {timeout: 2000},
        );
        await check(resolve);
      } catch (e) {
        resolve();
      }
    };

    return new Promise<void>((resolve) => {
      void check(resolve);
    });
  }

  async checkForRejoining() {
    try {
      await this.page.waitForSelector(
          rejoinButtonSelector,
          {timeout: 2000},
      );
      await this.page.locator(rejoinButtonSelector).click();
      // Wait to form to appear again
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await this.joinProcedure();
    } catch (e) {
      this.checkForRejoining();
    }
  }

  async joinProcedure() {
    const displayName = this.settings.botDisplayName ?? "Meeting Bot";
    const displayNameSelector = '[data-tid="prejoin-display-name-input"]';
    const muteButtonSelector = '[data-tid="toggle-mute"]';

    // Fill in the display name (Teams can re-render the input; `.fill()` can intermittently stop early)
    await this.page.waitForSelector(displayNameSelector, {timeout: 15000});
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const input = await this.page.$(displayNameSelector);
        if (!input) {
          throw new Error("Display name input not found");
        }

        // Focus + clear reliably
        await input.click({clickCount: 3});
        const selectAllModifier = process.platform === "darwin" ? "Meta" : "Control";
        await this.page.keyboard.down(selectAllModifier);
        await this.page.keyboard.press("A");
        await this.page.keyboard.up(selectAllModifier);
        await this.page.keyboard.press("Backspace");

        // Type more slowly to avoid Teams dropping keystrokes
        await input.type(displayName, {delay: 35});

        // Verify value (Teams sometimes only keeps the first 1-3 chars)
        const actual = await this.page.$eval(displayNameSelector, (el) => {
          const inputEl = el as HTMLInputElement;
          return typeof inputEl.value === "string" ? inputEl.value : "";
        });
        if (actual === displayName) {
          console.log("Entered Display Name");
          break;
        }

        // Fallback: set via native value setter + dispatch events (better for controlled inputs)
        await this.page.evaluate(
            ({ selector, value }: { selector: string; value: string }) => {
              const el = document.querySelector(selector) as HTMLInputElement | null;
              if (!el) return;
              el.focus();
              const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype,
                  "value",
              )?.set;
              setter?.call(el, value);
              el.dispatchEvent(new Event("input", {bubbles: true}));
              el.dispatchEvent(new Event("change", {bubbles: true}));
            },
            { selector: displayNameSelector, value: displayName },
        );

        const actualAfterFallback = await this.page.$eval(displayNameSelector, (el) => {
          const inputEl = el as HTMLInputElement;
          return typeof inputEl.value === "string" ? inputEl.value : "";
        });
        if (actualAfterFallback === displayName) {
          console.log("Entered Display Name");
          break;
        }
      } catch (e) {
        // retry
      }

      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      } else {
        console.log("Display name fill did not fully stick; continuing anyway.");
      }
    }

    try {
      // Mute microphone before joining
      await this.page.waitForSelector(muteButtonSelector, {timeout: 500});
      await this.page.locator(muteButtonSelector).click();
      console.log('Muted Microphone');
    } catch (e) {
      console.log('Mute button not found');
    }


    // Join the meeting
    await this.page.locator(`[data-tid="prejoin-join-button"]`).click();
    console.log('Found & Clicked the Join Button');

    this.checkForRejoining();
  }

  async leave(){
    try {
      await this.page.locator(leaveButtonSelector).click();
    } catch (error) {
      await this.endLife();
    }
  }
}
