export class RedditBehavior {
  static id = 'reddit';

  SCROLL_DURATION = 30000;
  MAX_COMMENT_EXPANSION_LOOPS = 20;
  WAIT_TIMEOUT = 2500;

  constructor(page, extra) {
    this.page = page;
    this.extra = extra;
  }

  async* run(ctx) {
    const url = this.page.url();
    console.log(`[Reddit Behavior] Starting on URL: ${url}`);

    try {
      await this.page.waitForSelector('#main-content', { timeout: 20000 });
      console.log('[Reddit Behavior] Main content container loaded.');
      await this.page.waitForTimeout(this.WAIT_TIMEOUT);

      await this.#closeModals();

      if (url.includes('/comments/')) {
        yield* this.#handlePostPage(ctx);
      } else {
        yield* this.#handleListingPage(ctx);
      }

      console.log('[Reddit Behavior] Behavior finished successfully.');
    } catch (error) {
      console.error(
        '[Reddit Behavior] A critical error occurred during execution:',
        error
      );
    }
  }

  async* #handleListingPage(ctx) {
    console.log(
      '[Reddit Behavior] Listing page detected. Scrolling to load more posts...'
    );
    const startTime = Date.now();
    while (Date.now() - startTime < this.SCROLL_DURATION) {
      const postCount = await this.page.evaluate(
        () => document.querySelectorAll('shreddit-post').length
      );
      console.log(`[Reddit Behavior] Found ${postCount} posts... scrolling down.`);
      yield `Scrolled, now see ${postCount} posts.`;
      await ctx.autoScroll();
      await this.page.waitForTimeout(this.WAIT_TIMEOUT);
    }
  }

  async* #handlePostPage(ctx) {
    console.log(
      '[Reddit Behavior] Post page detected. Expanding comments...'
    );
    await ctx.autoScroll();
    yield* this.#expandComments();
  }

  async* #expandComments() {
    const maxConsecutiveFailures = 3;
    let consecutiveFailures = 0;

    for (let i = 0; i < this.MAX_COMMENT_EXPANSION_LOOPS; i++) {
      const clickedCount = await this.page.evaluate(() => {
        const buttons = document.querySelectorAll(
          'button[aria-label="more replies"], shreddit-comment-tree-branch > button'
        );
        let clicked = 0;
        for (const button of buttons) {
          if (button.offsetParent !== null) {
            button.click();
            clicked++;
          }
        }
        return clicked;
      });

      if (clickedCount > 0) {
        console.log(
          `[Reddit Behavior] Clicked ${clickedCount} comment expansion button(s).`
        );
        yield `Expanded ${clickedCount} comment thread(s).`;
        consecutiveFailures = 0;
        await this.page.waitForTimeout(this.WAIT_TIMEOUT);
      } else {
        consecutiveFailures++;
        console.log(
          `[Reddit Behavior] No expandable comment elements found. Failure count: ${consecutiveFailures}`
        );
        if (consecutiveFailures >= maxConsecutiveFailures) {
          console.log(
            '[Reddit Behavior] Ending comment expansion after multiple failed attempts.'
          );
          break;
        }
        await this.page.waitForTimeout(1000);
      }
    }
    console.log('[Reddit Behavior] Finished comment expansion attempts.');
  }

  async #closeModals() {
    console.log('[Reddit Behavior] Checking for modals...');
    const closeButtonSelector = 'button[aria-label="Close"]';
    try {
      const closeButton = await this.page.$(closeButtonSelector);
      if (closeButton) {
        console.log('[Reddit Behavior] Modal found, attempting to close.');
        await closeButton.click();
        await this.page.waitForTimeout(500);
      } else {
        console.log('[Reddit Behavior] No modals found.');
      }
    } catch (e) {
      console.log('[Reddit Behavior] Could not close modal, it may have already disappeared.');
    }
  }
}
