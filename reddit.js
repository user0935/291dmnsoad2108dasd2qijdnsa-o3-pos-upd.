/**
 * Browsertrix behavior for navigating and interacting with modern Reddit pages.
 *
 * This behavior is designed to work with the current Reddit layout, which heavily
 * uses custom HTML elements like <shreddit-post> and <shreddit-comment-tree>.
 *
 * The script can handle two main page types:
 * 1. Subreddit pages (e.g., /r/IAmA): It scrolls to load new posts, intelligently
 * filtering to ensure only posts from the CURRENT subreddit are discovered.
 * 2. Post/Comment pages: It scrolls down and clicks buttons to load more comments,
 * expanding the comment threads for capture.
 */
class RedditBehavior {
  /**
   * A unique identifier for the behavior.
   */
  static id = "reddit";

  /**
   * An array of objects defining which hostnames this behavior should run on.
   */
  static matching = [
    {
      "hostname": "www.reddit.com",
    },
    {
      "hostname": "reddit.com",
    },
    {
      "hostname": "old.reddit.com", // Included for completeness
    }
  ];

  /**
   * The constructor is called by the behavior runner.
   * @param {object} context - The context object provided by the runner,
   * containing access to the page and utility functions.
   */
  constructor(context) {
    this.context = context;
    this.utils = context.utils;
    this.page = context.page;
  }

  /**
   * The main entry point for the behavior's execution.
   * It determines the page type and calls the appropriate handler.
   */
  async _run() {
    // Check if the URL indicates a comments page.
    if (this.page.url().includes("/comments/")) {
      await this.handlePostPage();
    } else {
      await this.handleSubredditPage();
    }
  }

  /**
   * Handles the behavior for a Reddit post page.
   * It scrolls down and repeatedly clicks on any "View more comments" or
   * "Continue this thread" buttons to fully expand the comment tree.
   */
  async handlePostPage() {
    const MAX_EXPANSIONS = 25; // A safeguard to prevent potential infinite loops.
    console.log("Running post page behavior: expanding comments.");

    for (let i = 0; i < MAX_EXPANSIONS; i++) {
      // Scroll down to find buttons that might have loaded off-screen.
      await this.utils.scroll(window, { "behavior": "smooth", "direction": "down" });
      await this.utils.wait(1500); // Wait for content to potentially load after scroll.

      const loadMoreButton = await this.findLoadMoreButton();

      if (loadMoreButton) {
        console.log("Found a 'load more' button. Clicking it.");
        try {
          await loadMoreButton.click();
          // Wait for the new comments to be rendered into the DOM.
          await this.utils.wait(2500);
        } catch (e) {
          console.error("Could not click the 'load more' button. It might be obscured or gone.", e);
          // If a click fails, we should stop trying.
          break;
        }
      } else {
        // If no more buttons are found, our work here is done.
        console.log("No more 'load more' buttons found. Concluding post page behavior.");
        break;
      }
    }
  }

  /**
   * Handles the behavior for a subreddit page (the post listing).
   * This function now actively finds new posts loaded via infinite scroll and
   * filters them to ensure they belong to the current subreddit.
   */
  async handleSubredditPage() {
    // Determine the current subreddit from the URL.
    const url = new URL(this.page.url());
    const pathParts = url.pathname.split('/').filter(p => p); // -> ['r', 'IAmA']
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

      // Find all post links currently on the page.
      const postLinks = await this.page.$$('a[slot="title"]');

      for (const link of postLinks) {
        try {
          const href = await link.evaluate(node => node.href);
          // CRITICAL: Filter links to only include posts from the current subreddit.
          // This prevents crawling other subreddits, user pages, or external links.
          const linkUrl = new URL(href);
          if (linkUrl.pathname.startsWith(`/r/${currentSubreddit}/comments/`)) {
            discoveredPostUrls.add(href);
          }
        } catch (e) {
          // The element may have been removed from the DOM, safe to ignore.
          continue;
        }
      }

      // Check if we discovered any new posts in this pass.
      if (discoveredPostUrls.size > initialUrlCount) {
        console.log(`Discovered ${discoveredPostUrls.size - initialUrlCount} new posts in r/${currentSubreddit}. Total: ${discoveredPostUrls.size}`);
        scrollsWithoutNewPosts = 0; // Reset the counter
      } else {
        scrollsWithoutNewPosts++;
        console.log(`No new posts found on this scroll. Attempt ${scrollsWithoutNewPosts}/${MAX_SCROLLS_WITHOUT_NEW_POSTS}.`);
      }

      // Scroll down to load more content.
      await this.utils.scroll(window, { "behavior": "smooth", "direction": "down" });
      await this.utils.wait(6000); // Increased wait time for large subreddits.
    }

    console.log(`Finished scrolling r/${currentSubreddit}. Discovered a total of ${discoveredPostUrls.size} post URLs.`);
  }


  /**
   * Finds the next available "load more" type button within a comment tree.
   * This function is more robust because it checks for several common text variations
   * used by Reddit to expand comment threads.
   * @returns {Promise<ElementHandle|null>} A Playwright ElementHandle for the button, or null if none is found.
   */
  async findLoadMoreButton() {
    // Reddit's new layout places comments inside this custom element.
    const commentContainer = await this.page.$('shreddit-comment-tree');
    if (!commentContainer) return null;

    // We look for all buttons within the comment container.
    const buttons = await commentContainer.$$('button');
    const loadMoreTexts = [
      'view more comments',
      'continue this thread',
      'load more comments'
    ];

    for (const button of buttons) {
      try {
        const textContent = await button.evaluate(node => node.textContent.trim().toLowerCase());
        // Check if the button's text includes any of our target phrases.
        if (loadMoreTexts.some(text => textContent.includes(text))) {
          // Ensure the button is actually visible on the page before we try to click it.
          if (await button.isVisible()) {
             return button;
          }
        }
      } catch (e) {
        // This can happen if the element is removed from the DOM while we're iterating.
        // We can safely ignore it and continue to the next button.
        continue;
      }
    }

    // Return null if no suitable, visible button was found.
    return null;
  }
}
