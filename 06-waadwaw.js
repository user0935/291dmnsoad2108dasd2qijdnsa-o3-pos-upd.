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
  }

  /**
   * Handles the logic for a single Reddit post page.
   * It expands comments and loads more replies.
   */
  async handlePostPage() {
    console.log("Handling a post page.");
    let loadMoreClicked = 0;
    const MAX_LOAD_MORE = 20; // Limit the number of "load more" clicks

    while (loadMoreClicked < MAX_LOAD_MORE) {
      await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      await this.utils.wait(3000); // Wait for content to potentially load

      const loadMoreButton = await this.findLoadMoreButton();
      if (loadMoreButton) {
        try {
          await loadMoreButton.click();
          console.log("Clicked 'load more' or 'continue thread' button.");
          loadMoreClicked++;
          this.context.state.commentsExpanded++;
          await this.utils.wait(5000); // Wait for new comments to load
        } catch (error) {
          console.error("Could not click 'load more' button:", error);
          break; // Exit if button is no longer clickable
        }
      } else {
        console.log("No more 'load more' buttons found.");
        break; // No more buttons to click
      }
    }
    console.log(`Finished handling post page. Clicked 'load more' ${loadMoreClicked} times.`);
  }

  /**
   * Handles the logic for a subreddit or home page.
   * It scrolls the page to discover post URLs.
   */
  async handleSubredditPage() {
    const MAX_SCROLLS_WITHOUT_NEW_POSTS = 5;
    let scrollsWithoutNewPosts = 0;
    const discoveredPostUrls = new Set();
    const currentSubreddit = this.page.url().split('/r/')[1]?.split('/')[0] || 'frontpage';

    console.log(`Starting to scroll r/${currentSubreddit} to discover posts.`);

    while (scrollsWithoutNewPosts < MAX_SCROLLS_WITHOUT_NEW_POSTS) {
      const postLinks = await this.page.$$('shreddit-post');
      let newPostsFoundInScroll = false;

      for (const postLink of postLinks) {
        try {
          // Evaluate the post data from the element
          const post = await postLink.evaluate(node => node.post);
          
          // FIX: Add a check to ensure post and post.url are not undefined
          if (post && post.url) {
            const postUrl = new URL(post.url, this.page.url()).href;
            if (!discoveredPostUrls.has(postUrl)) {
              discoveredPostUrls.add(postUrl);
              this.context.outlinks.add(postUrl);
              newPostsFoundInScroll = true;
              this.context.state.discoveredPosts++;
              console.log('Discovered post:', postUrl);
            }
          }
        } catch (error) {
          // Log errors but continue the loop
          console.error('Error processing a post link:', error);
        }
      }

      if (newPostsFoundInScroll) {
        scrollsWithoutNewPosts = 0; // Reset counter if new posts were found
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
        // Ignore errors from buttons that might have been removed from the DOM
        console.warn('Could not evaluate a button, it might have been removed.');
      }
    }

    return null;
  }
}
