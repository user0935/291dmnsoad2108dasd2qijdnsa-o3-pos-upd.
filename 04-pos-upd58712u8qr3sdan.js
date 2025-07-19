class RedditScrollerBehavior {
  static WAIT_SHORT = 1500;
  static WAIT_MEDIUM = 3000;
  static WAIT_LONG = 5000;

  static MAX_SCROLLS = 250;
  static MAX_COMMENT_EXPANDS = 100;

  static match(url) {
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname.startsWith('old.reddit.com')) {
        return false;
      }
      return urlObj.hostname.includes('reddit.com') && urlObj.pathname.startsWith('/r/');
    } catch (e) {
      console.error('[Reddit Behavior] Invalid URL provided to match function:', url, e);
      return false;
    }
  }

  async run(ctx) {
    console.log(`[Reddit Behavior] Starting on URL: ${ctx.url}`);

    try {
      await ctx.waitForElement('shreddit-app', 20000);
      await this.#wait(RedditScrollerBehavior.WAIT_MEDIUM);

      await this.#closeModals();

      const url = new URL(ctx.url);
      const pathname = url.pathname;

      const isCommentPage = /^\/r\/[^/]+\/comments\//.test(pathname);
      const isWikiPage = /^\/r\/[^/]+\/wiki\//.test(pathname);

      if (isCommentPage) {
        await this.#expandComments(ctx);
      } else if (isWikiPage) {
        await this.#handleWikiPage(ctx);
      } else {
        await this.#handleListingPage(ctx);
      }

      console.log('[Reddit Behavior] Behavior finished successfully.');
    } catch (error) {
      console.error('[Reddit Behavior] An error occurred during execution:', error);
    }
  }

  async #wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async #closeModals() {
    console.log('[Reddit Behavior] Checking for modals to close.');
    const closeButton = document.querySelector('button > i.icon-close');
    if (closeButton) {
      try {
        console.log('[Reddit Behavior] Found and clicked a modal close button.');
        closeButton.click();
        await this.#wait(RedditScrollerBehavior.WAIT_SHORT);
      } catch (e) {
        console.warn('[Reddit Behavior] Could not click modal close button.', e);
      }
    }
  }

  async #clickAllVisible(selector, textRegex) {
    let clickedCount = 0;
    const elements = Array.from(document.querySelectorAll(selector));

    for (const el of elements) {
      const isVisible = el.offsetParent !== null;
      if (isVisible && textRegex.test(el.innerText)) {
        try {
          console.log(`[Reddit Behavior] Found element to click: "${el.innerText.trim()}"`);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await this.#wait(500);
          el.click();
          clickedCount++;
          await this.#wait(RedditScrollerBehavior.WAIT_MEDIUM);
        } catch (e) {
          console.warn(`[Reddit Behavior] Failed to click element with text matching ${textRegex}.`, e);
        }
      }
    }
    return clickedCount;
  }

  async #expandComments(ctx) {
    console.log('[Reddit Behavior] Comment page detected. Expanding all comments.');

    const loadMoreRegex = /(view|load) more comments/i;
    const moreRepliesRegex = /\d+ more repl(y|ies)/i;

    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;

    for (let i = 0; i < RedditScrollerBehavior.MAX_COMMENT_EXPANDS; i++) {
      console.log(`[Reddit Behavior] Comment expansion attempt #${i + 1}`);
      let clickedSomething = false;

      let clickedCount = await this.#clickAllVisible('button', loadMoreRegex);
      if (clickedCount > 0) {
        console.log(`[Reddit Behavior] Expanded ${clickedCount} main comment thread(s).`);
        clickedSomething = true;
      }

      clickedCount = await this.#clickAllVisible('button', moreRepliesRegex);
      if (clickedCount > 0) {
        console.log(`[Reddit Behavior] Expanded ${clickedCount} nested comment repl(y|ies).`);
        clickedSomething = true;
      }

      if (clickedSomething) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        console.log(`[Reddit Behavior] No expandable comment elements found. Failure count: ${consecutiveFailures}`);
        if (consecutiveFailures >= maxConsecutiveFailures) {
          console.log('[Reddit Behavior] Ending comment expansion loop after multiple failed attempts.');
          break;
        }
      }
      await this.#wait(RedditScrollerBehavior.WAIT_SHORT);
    }

    console.log('[Reddit Behavior] Comment expansion complete. Performing final scroll to capture all content.');
    await ctx.scroll({ timeout: 60000, direction: 'down' });
  }

  async #handleListingPage(ctx) {
    console.log('[Reddit Behavior] Listing page detected. Starting scroll to load posts.');
    const foundPosts = new Set();
    let consecutiveScrollsWithNoNewPosts = 0;
    const maxConsecutiveFailures = 5;

    for (let i = 0; i < RedditScrollerBehavior.MAX_SCROLLS; i++) {
      const initialPostCount = foundPosts.size;

      document.querySelectorAll('shreddit-post').forEach(post => {
        if (post.permalink) {
          foundPosts.add(post.permalink);
        }
      });

      const newPostCount = foundPosts.size;
      console.log(`[Reddit Behavior] Scroll ${i + 1}/${RedditScrollerBehavior.MAX_SCROLLS}. Found ${newPostCount} unique posts so far.`);

      if (i > 0 && newPostCount === initialPostCount) {
        consecutiveScrollsWithNoNewPosts++;
        console.log(`[Reddit Behavior] No new posts found on this scroll. Consecutive empty scrolls: ${consecutiveScrollsWithNoNewPosts}`);
        if (consecutiveScrollsWithNoNewPosts >= maxConsecutiveFailures) {
          console.log('[Reddit Behavior] Reached max consecutive empty scrolls. Assuming end of content.');
          break;
        }
      } else {
        consecutiveScrollsWithNoNewPosts = 0;
      }

      await ctx.scroll({ direction: 'down' });
      await this.#wait(RedditScrollerBehavior.WAIT_LONG);
    }

    console.log(`[Reddit Behavior] Finished scrolling on listing page. Exposed a total of ${foundPosts.size} posts for the crawler.`);
  }

  async #handleWikiPage(ctx) {
    console.log('[Reddit Behavior] Wiki page detected. Performing a full scroll.');
    await ctx.scroll({ timeout: 60000, direction: 'down' });
    console.log('[Reddit Behavior] Wiki page scroll complete.');
  }
}
