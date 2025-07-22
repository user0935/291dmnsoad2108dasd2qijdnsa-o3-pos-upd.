class RedditBehavior {
  static id = 'reddit';

  static isMatch(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.endsWith('reddit.com');
    } catch (e) {
      return false;
    }
  }

  static init(options) {
    return {
      state: {},
      opts: {}
    };
  }

  // Configuration constants
  SCROLL_DURATION = 300000; // Increased scroll duration for more content (5 minutes)
  MAX_COMMENT_EXPANSION_LOOPS = 20;
  WAIT_TIMEOUT = 3000; // Increased wait time for content to load

  constructor(page, extra) {
    this.page = page;
    this.extra = extra;
    this.discoveredUrls = new Set();
  }

  async* run(ctx) {
    const url = this.page.url();

    try {
      // Wait for the main content area to be present before proceeding
      await this.page.waitForSelector('#main-content', { timeout: 20000 });
      await this.page.waitForTimeout(this.WAIT_TIMEOUT);

      // Attempt to close any initial modals (e.g., "open in app")
      await this._closeModals();

      // Branch logic based on whether it's a post page or a listing page
      if (url.includes('/comments/')) {
        yield* this._handlePostPage(ctx);
      } else {
        yield* this._handleListingPage(ctx);
      }
    } catch (error)
      console.error(
        `[Reddit Behavior] A critical error occurred on ${url}:`,
        error
      );
    }
  }

  async* _discoverAndQueueUrls(ctx) {
    const postSelector = 'a[data-testid="post-title"]';
    // Use page.evaluate to get hrefs, which can be more reliable
    const postLinks = await this.page.evaluate((selector) => {
        return Array.from(document.querySelectorAll(selector), a => a.href);
    }, postSelector);


    let newUrlsFound = 0;
    for (const url of postLinks) {
      // Ensure we have a valid, absolute URL
      const absoluteUrl = new URL(url, this.page.url()).href;
      if (!this.discoveredUrls.has(absoluteUrl)) {
        this.discoveredUrls.add(absoluteUrl);
        ctx.addUrl(absoluteUrl); // Feed URL to Browsertrix
        newUrlsFound++;
      }
    }

    if (newUrlsFound > 0) {
      yield `Discovered and queued ${newUrlsFound} new post URL(s).`;
    }
  }

  async* _handleListingPage(ctx) {
    yield 'On a listing page, starting continuous scroll and discovery.';
    const startTime = Date.now();
    let lastScrollHeight = 0;
    let stableScrollCount = 0;
    const stableScrollThreshold = 3; // Stop if scroll height doesn't change

    // Loop for the specified duration
    while (Date.now() - startTime < this.SCROLL_DURATION) {
      // Discover and queue URLs in the current view
      yield* this._discoverAndQueueUrls(ctx);

      // Scroll to the bottom to trigger loading more content
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      // Wait for new content to load
      await this.page.waitForTimeout(this.WAIT_TIMEOUT);

      // Check if we've reached the end of the scrollable content
      const newScrollHeight = await this.page.evaluate(() => document.body.scrollHeight);
      if (newScrollHeight === lastScrollHeight) {
        stableScrollCount++;
        if (stableScrollCount >= stableScrollThreshold) {
          yield 'Scroll height has stabilized, ending scroll early.';
          break; // Exit loop if page height is stable
        }
      } else {
        stableScrollCount = 0; // Reset counter if new content loaded
      }
      lastScrollHeight = newScrollHeight;
    }

    yield `Finished scrolling and discovery loop.`;
    // Perform a final discovery pass to catch any remaining links
    yield* this._discoverAndQueueUrls(ctx);
  }

  async* _handlePostPage(ctx) {
    yield 'On a post page, scrolling and expanding comments.';
    // Scroll to the bottom to load initial comments
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this.page.waitForTimeout(this.WAIT_TIMEOUT);
    yield* this._expandCommentThreads();
  }

  async* _expandCommentThreads() {
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;

    for (let i = 0; i < this.MAX_COMMENT_EXPANSION_LOOPS; i++) {
      // Selectors for various "load more" buttons on Reddit
      const commentSelectors = [
        'button:text-matches("view more comments", "i")',
        'button:text-matches("view entire discussion", "i")',
        'div[tabindex="0"]:text-matches("continue this thread", "i")',
        'span:text-matches("load more comments", "i")',
      ];

      let clickedCount = 0;
      for (const selector of commentSelectors) {
        // Use locator API which is better for interacting with elements
        const elements = this.page.locator(selector);
        for (const element of await elements.all()) {
          try {
            if (await element.isVisible()) {
                await element.click();
                clickedCount++;
                // Short wait after a click to allow content to load
                await this.page.waitForTimeout(500);
            }
          } catch (e) {
            // Ignore errors if element disappears before click
          }
        }
      }

      if (clickedCount > 0) {
        yield `Expanded ${clickedCount} comment thread(s).`;
        consecutiveFailures = 0; // Reset on success
        await this.page.waitForTimeout(this.WAIT_TIMEOUT);
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          yield 'No more comment expansion buttons found.';
          break; // Exit if nothing to click for several cycles
        }
        await this.page.waitForTimeout(1000);
      }
    }
  }

  async _closeModals() {
    const closeButtonSelectors = [
      'button[aria-label="Close"]', // Standard close button
      'button:has-text("Continue")', // "Continue" in "See Reddit in..." modal
      '[aria-label="Back to Top"]', // Sometimes this covers other elements
    ];

    for (const selector of closeButtonSelectors) {
        const elements = this.page.locator(selector);
        for (const element of await elements.all()) {
            try {
                if (await element.isVisible()) {
                    await element.click({timeout: 1000});
                    await this.page.waitForTimeout(500);
                }
            } catch (e) {
                // Ignore errors if modal is not present or disappears
            }
        }
    }
  }
}
