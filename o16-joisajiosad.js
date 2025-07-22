class RedditBehavior {
  static id = 'reddit';

  /**
   * @desc Determines if this behavior should be run on the given URL.
   * @param {string} url - The URL of the page to check.
   * @returns {boolean} - True if the URL is a Reddit page, false otherwise.
   */
  static isMatch(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.endsWith('reddit.com');
    } catch (e) {
      return false;
    }
  }

  /**
   * @desc Initializes the behavior's state and options.
   * @param {object} options - The options for the behavior.
   * @returns {object} - The initial state and options.
   */
  static init(options) {
    return {
      state: {},
      opts: {}
    };
  }

  SCROLL_DURATION = 30000;
  MAX_COMMENT_EXPANSION_LOOPS = 20;
  WAIT_TIMEOUT = 2500;

  constructor(page, extra) {
    this.page = page;
    this.extra = extra;
    this.discoveredUrls = new Set();
  }

  async* run(ctx) {
    const url = this.page.url();

    try {
      await this.page.waitForSelector('#main-content', { timeout: 20000 });
      await this.page.waitForTimeout(this.WAIT_TIMEOUT);

      await this._closeModals();

      if (url.includes('/comments/')) {
        yield* this._handlePostPage(ctx);
      } else {
        yield* this._handleListingPage(ctx);
      }
    } catch (error) {
      console.error(
        '[Reddit Behavior] A critical error occurred during execution:',
        error
      );
    }
  }

  async* _discoverAndQueueUrls(ctx) {
    const postSelector = 'a[href*="/comments/"]';
    const postLinks = await this.page.$$eval(postSelector, (anchors) =>
      anchors.map((a) => a.href)
    );

    let newUrlsFound = 0;
    for (const url of postLinks) {
      if (!this.discoveredUrls.has(url)) {
        this.discoveredUrls.add(url);
        ctx.addUrl(url);
        newUrlsFound++;
      }
    }

    if (newUrlsFound > 0) {
      yield `Discovered and queued ${newUrlsFound} new post URL(s).`;
    }
  }

  async* _handleListingPage(ctx) {
    yield 'On a listing page, scrolling to discover posts.';
    await this.page.evaluate(async (duration) => {
      const scrollHeight = document.body.scrollHeight;
      const scrollStep = scrollHeight / (duration / 100);
      let currentScroll = 0;
      const scrollInterval = setInterval(() => {
        if (currentScroll < scrollHeight) {
          window.scrollBy(0, scrollStep);
          currentScroll += scrollStep;
        } else {
          clearInterval(scrollInterval);
        }
      }, 100);
    }, this.SCROLL_DURATION);

    await this.page.waitForTimeout(this.WAIT_TIMEOUT);
    yield* this._discoverAndQueueUrls(ctx);
  }

  async* _handlePostPage(ctx) {
    yield 'On a post page, scrolling and expanding comments.';
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this.page.waitForTimeout(this.WAIT_TIMEOUT);
    yield* this._expandCommentThreads();
  }

  async* _expandCommentThreads() {
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;

    for (let i = 0; i < this.MAX_COMMENT_EXPANSION_LOOPS; i++) {
      const commentSelectors = [
        'button:has-text(/^view more comments$/i)',
        'button:has-text(/^view entire discussion/i)',
        'div[tabindex="0"]:has-text(/^continue this thread$/i)',
        'span:has-text(/^load more comments$/i)',
      ];

      let clickedCount = 0;
      for (const selector of commentSelectors) {
        const elements = await this.page.$$(selector);
        for (const element of elements) {
          try {
            await element.click();
            clickedCount++;
            await this.page.waitForTimeout(500);
          } catch (e) {}
        }
      }

      if (clickedCount > 0) {
        yield `Expanded ${clickedCount} comment thread(s).`;
        consecutiveFailures = 0;
        await this.page.waitForTimeout(this.WAIT_TIMEOUT);
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          break;
        }
        await this.page.waitForTimeout(1000);
      }
    }
  }

  async _closeModals() {
    const closeButtonSelectors = [
      'button[aria-label="Close"]',
      'button:has-text("Continue")',
    ];

    for (const selector of closeButtonSelectors) {
      const elements = await this.page.$$(selector);
      for (const element of elements) {
        try {
          await element.click();
          await this.page.waitForTimeout(500);
        } catch (e) {}
      }
    }
  }
}
