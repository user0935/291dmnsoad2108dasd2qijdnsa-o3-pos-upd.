class RedditBehavior {
  static id = "reddit";

  static init() {
    return {
      state: { discoveredPosts: 0, commentsExpanded: 0 },
      opts: {}
    };
  }

  static isMatch() {
    const supportedHostnames = ["www.reddit.com", "reddit.com", "old.reddit.com"];
    return supportedHostnames.includes(window.location.hostname);
  }

  /**
   * The main method that Browsertrix calls to execute the behavior.
   * Handles context properly to avoid undefined errors.
   */
  async *run(context) {
    if (!context || !context.page || !context.utils) {
      console.error("Context, page, or utils is undefined.");
      return;
    }

    this.context = context;
    this.page = context.page;
    this.utils = context.utils;

    try {
      await this.page.waitForLoadState('load');
      console.log("Running RedditBehavior for URL:", this.page.url());

      if (this.page.url().includes("/comments/")) {
        await this.handlePostPage();
      } else {
        await this.handleSubredditPage();
      }
    } catch (error) {
      console.error("Error during behavior execution:", error);
    }
  }

  async handlePostPage() {
    console.log("Handling a post page.");
    let loadMoreClicked = 0;
    const MAX_LOAD_MORE = 20;

    while (loadMoreClicked < MAX_LOAD_MORE) {
      await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      await this.utils.wait(3000);

      const loadMoreButton = await this.findLoadMoreButton();
      if (loadMoreButton) {
        try {
          await loadMoreButton.click();
          console.log("Clicked 'load more' or 'continue thread' button.");
          loadMoreClicked++;
          this.context.state.commentsExpanded++;
          await this.utils.wait(5000);
        } catch (error) {
          console.error("Could not click 'load more' button:", error);
          break;
        }
      } else {
        console.log("No more 'load more' buttons found.");
        break;
      }
    }
    console.log(`Finished handling post page. Clicked 'load more' ${loadMoreClicked} times.`);
  }

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
          const post = await postLink.evaluate(node => node.post);
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
          console.error('Error processing a post link:', error);
        }
      }

      if (newPostsFoundInScroll) {
        scrollsWithoutNewPosts = 0;
      } else {
        scrollsWithoutNewPosts++;
        console.log(`No new posts found on this scroll. Attempt ${scrollsWithoutNewPosts}/${MAX_SCROLLS_WITHOUT_NEW_POSTS}.`);
      }

      await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      await this.utils.wait(6000);
    }

    console.log(`Finished scrolling r/${currentSubreddit}. Discovered a total of ${discoveredPostUrls.size} post URLs.`);
  }

  async findLoadMoreButton() {
    const commentContainer = await this.page.$('shreddit-comment-tree');
    if (!commentContainer) return null;

    const buttons = await commentContainer.$$('button');
    const loadMoreTexts = ['view more comments', 'continue this thread', 'load more comments'];

    for (const button of buttons) {
      try {
        const textContent = await button.evaluate(node => node.textContent.trim().toLowerCase());
        if (loadMoreTexts.some(text => textContent.includes(text))) {
          if (await button.isVisible()) {
            return button;
          }
        }
      } catch (e) {
        console.warn('Could not evaluate a button, it might have been removed.');
      }
    }

    return null;
  }
}
