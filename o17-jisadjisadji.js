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
    const defaultOpts = {
      scrollWaitTimeout: 5000,
      maxScrolls: 200,
      maxEmptyScrolls: 3,
      maxCommentExpansionLoops: 20,
      clickWaitTimeout: 500,
    };

    return {
      state: {
        postsFound: 0,
        commentsExpanded: 0,
      },
      opts: { ...defaultOpts, ...(options || {}) },
    };
  }

  constructor(page, extra, opts, state) {
    this.page = page;
    this.extra = extra;
    this.opts = opts;
    this.state = state;
    this.discoveredUrls = new Set();
  }

  async* run(ctx) {
    const url = this.page.url();

    try {
      await this.page.waitForSelector('#main-content', { timeout: 20000 });
      await this.page.waitForTimeout(this.opts.scrollWaitTimeout);

      await this._closeModals();

      if (url.includes('/comments/')) {
        yield* this._handlePostPage(ctx);
      } else {
        yield* this._handleListingPage(ctx);
      }
    } catch (error) {
      console.error(
        `[Reddit Behavior] A critical error occurred on ${url}:`,
        error
      );
      yield `Error: ${error.message}`;
    }
  }

  async _discoverAndQueueUrls(ctx) {
    const postSelector = 'a[id^="post-title-"]';
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
        this.state.postsFound += newUrlsFound;
    }
    return newUrlsFound;
  }

  async* _handleListingPage(ctx) {
    yield 'Starting continuous scroll on listing page.';
    let emptyScrolls = 0;

    const initialUrlsFound = await this._discoverAndQueueUrls(ctx);
    if (initialUrlsFound > 0) {
      yield `Discovered ${initialUrlsFound} initial post(s).`;
    }

    for (let i = 0; i < this.opts.maxScrolls; i++) {
      await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await this.page.waitForTimeout(this.opts.scrollWaitTimeout);

      const newUrlsFound = await this._discoverAndQueueUrls(ctx);

      if (newUrlsFound > 0) {
        yield `Discovered ${newUrlsFound} new post(s) on scroll ${i + 1}.`;
        emptyScrolls = 0;
      } else {
        yield `Scroll ${i + 1} did not yield new posts.`;
        emptyScrolls++;
      }

      if (emptyScrolls >= this.opts.maxEmptyScrolls) {
        yield 'Reached end of listing page or no new content is loading.';
        break;
      }
    }
  }

  async* _handlePostPage(ctx) {
    yield 'On a post page, expanding all comments.';
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this.page.waitForTimeout(this.opts.scrollWaitTimeout);
    yield* this._expandCommentThreads();
  }

  async* _expandCommentThreads() {
    for (let i = 0; i < this.opts.maxCommentExpansionLoops; i++) {
      const commentSelectors = [
        'button[data-testid="load-more-comments"]',
        'button[data-testid="continue-thread"]',
      ];

      let clickedCount = 0;
      for (const selector of commentSelectors) {
        const elements = await this.page.$$(selector);
        for (const element of elements) {
          try {
            await element.evaluate(el => el.scrollIntoView({ block: 'center' }));
            await element.click();
            clickedCount++;
            await this.page.waitForTimeout(this.opts.clickWaitTimeout);
          } catch (e) {
            // Ignore errors if element disappears before click.
          }
        }
      }

      if (clickedCount > 0) {
        this.state.commentsExpanded += clickedCount;
        yield `Expanded ${clickedCount} comment thread(s) in loop ${i + 1}.`;
        await this.page.waitForTimeout(this.opts.scrollWaitTimeout);
      } else {
        yield 'No more comment threads to expand.';
        break;
      }
    }
  }

  async _closeModals() {
    const closeButtonSelectors = [
      'button[aria-label="Close"]',
      'div[role="dialog"] button.close',
      'shreddit-async-loader > button',
    ];

    for (const selector of closeButtonSelectors) {
      const elements = await this.page.$$(selector);
      for (const element of elements) {
        try {
          await element.click({ delay: 50 });
          await this.page.waitForTimeout(this.opts.clickWaitTimeout);
        } catch (e) {
          // Ignore errors.
        }
      }
    }
  }
}
