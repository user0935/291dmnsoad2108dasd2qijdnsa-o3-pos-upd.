class RedditBehavior {
  static id = "reddit";

  /**
   * Initializes the behavior's state.
   * This is called once when the behavior is first loaded.
   */
  static init() {
    return {
      state: { discoveredPosts: 0, commentsExpanded: 0 },
      opts: {}
    };
  }

  /**
   * Determines if this behavior should run on the current page.
   * @returns {boolean} - True if the page is a Reddit page.
   */
  static isMatch() {
    const supportedHostnames = [
      "www.reddit.com",
      "reddit.com",
      "old.reddit.com"
    ];
    return supportedHostnames.includes(window.location.hostname);
  }

  /**
   * The main method that Browsertrix calls to execute the behavior.
   * This is an async generator function.
   * @param {object} context - The Browsertrix context object.
   */
  async *run(context) {
    // Initialize context-dependent properties here
    this.context = context;
    this.utils = context.utils;
    this.page = context.page;

    console.log("Running RedditBehavior for URL:", this.page.url());

    if (this.page.url().includes("/comments/")) {
      await this.handlePostPage();
    } else {
      await this.handleSubredditPage();
    }
    console.log("RedditBehavior finished.");
  }

  /**
   * Handles logic for Reddit post pages (e.g., expanding comment threads).
   */
  async handlePostPage() {
    const MAX_EXPANSIONS = 25;
    console.log("Running post page behavior: expanding comments.");

    for (let i = 0; i < MAX_EXPANSIONS; i++) {
      await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      await this.utils.wait(1500);

      const loadMoreButton = await this.findLoadMoreButton();

      if (loadMoreButton) {
        console.log(`Found a 'load more' button. Clicking it. (Expansion ${i + 1}/${MAX_EXPANSIONS})`);
        try {
          await loadMoreButton.click();
          await this.utils.wait(2500); // Wait for new comments to load
        } catch (e) {
          console.error("Could not click the 'load more' button. It might be obscured or gone.", e);
          break; // Exit loop if click fails
        }
      } else {
        console.log("No more 'load more' buttons found. Concluding post page behavior.");
        break; // Exit loop if no button is found
      }
    }
  }

  /**
   * Handles logic for subreddit pages (e.g., scrolling to discover more posts).
   */
  async handleSubredditPage() {
    const url = new URL(this.page.url());
    const pathParts = url.pathname.split('/').filter(p => p);

    // Ensure we are on a subreddit page (e.g., /r/some-subreddit)
    if (pathParts.length < 2 || pathParts[0] !== 'r') {
      console.log("Not on a standard subreddit page. Exiting behavior.");
      return;
    }
    const currentSubreddit = pathParts[1];
    console.log(`Running subreddit page behavior for: r/${currentSubreddit}`);

    const discoveredPostUrls = new Set();
    const MAX_SCROLLS_WITHOUT_NEW_POSTS = 3;
    let scrollsWithoutNewPosts = 0;

    while (scrollsWithoutNewPosts < MAX_SCROLLS_WITHOUT_NEW_POSTS) {
      const initialUrlCount = discoveredPostUrls.size;

      // Find all post titles and add their URLs to the set
      const postLinks = await this.page.$$('a[slot="title"]');
      for (const link of postLinks) {
        try {
          const href = await link.evaluate(node => node.href);
          const linkUrl = new URL(href);
          // Ensure the link is a comment link within the current subreddit
          if (linkUrl.pathname.startsWith(`/r/${currentSubreddit}/comments/`)) {
            discoveredPostUrls.add(href);
          }
        } catch (e) {
          // Ignore invalid URLs or other errors
          continue;
        }
      }

      // Check if new posts were discovered after this scroll
      if (discoveredPostUrls.size > initialUrlCount) {
        console.log(`Discovered ${discoveredPostUrls.size - initialUrlCount} new posts in r/${currentSubreddit}. Total: ${discoveredPostUrls.size}`);
        scrollsWithoutNewPosts = 0; // Reset counter
      } else {
        scrollsWithoutNewPosts++;
        console.log(`No new posts found on this scroll. Attempt ${scrollsWithoutNewPosts}/${MAX_SCROLLS_WITHOUT_NEW_POSTS}.`);
      }

      // Scroll down and wait for content to load
      await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      await this.utils.wait(6000);
    }

    console.log(`Finished scrolling r/${currentSubreddit}. Discovered a total of ${discoveredPostUrls.size} post URLs.`);
  }

  /**
   * Finds a visible "load more comments" or "continue thread" button.
   * @returns {Promise<ElementHandle|null>}
   */
  async findLoadMoreButton() {
    const commentContainer = await this.page.$('shreddit-comment-tree');
    if (!commentContainer) return null;

    const buttons = await commentContainer.$$('button');
    const loadMoreTexts = [
      'view more comments',
      'continue this thread',
      'load more comments'
    ];

    for (const button of buttons) {
      try {
        const textContent = await button.evaluate(node => node.textContent.trim().toLowerCase());
        if (loadMoreTexts.some(text => textContent.includes(text))) {
          // Ensure the button is visible before returning it
          if (await button.isVisible()) {
            return button;
          }
        }
      } catch (e) {
        // Ignore buttons that might have become detached from the DOM
        continue;
      }
    }

    return null; // No suitable button found
  }
}
