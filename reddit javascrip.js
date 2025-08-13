class RedditBehavior {
  static id = "reddit";

  static init() {
    return {
      state: { discoveredPosts: 0, commentsExpanded: 0 },
      opts: {}
    };
  }

  static isMatch() {
    const supportedHostnames = [
      "www.reddit.com",
      "reddit.com",
      "old.reddit.com"
    ];
    return supportedHostnames.includes(window.location.hostname);
  }

  async run(context) {
    this.context = context;
    this.utils = context.utils;
    this.page = context.page;

    if (this.page.url().includes("/comments/")) {
      await this.handlePostPage();
    } else {
      await this.handleSubredditPage();
    }
  }

  async handlePostPage() {
    const MAX_EXPANSIONS = 25;
    console.log("Running post page behavior: expanding comments.");

    for (let i = 0; i < MAX_EXPANSIONS; i++) {
      await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      await this.utils.wait(1500);

      const loadMoreButton = await this.findLoadMoreButton();

      if (loadMoreButton) {
        console.log("Found a 'load more' button. Clicking it.");
        try {
          await loadMoreButton.click();
          await this.utils.wait(2500);
        } catch (e) {
          console.error("Could not click the 'load more' button. It might be obscured or gone.", e);
          break;
        }
      } else {
        console.log("No more 'load more' buttons found. Concluding post page behavior.");
        break;
      }
    }
  }

  async handleSubredditPage() {
    const url = new URL(this.page.url());
    const pathParts = url.pathname.split('/').filter(p => p);
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

      const postLinks = await this.page.$$('a[slot="title"]');

      for (const link of postLinks) {
        try {
          const href = await link.evaluate(node => node.href);
          const linkUrl = new URL(href);
          if (linkUrl.pathname.startsWith(`/r/${currentSubreddit}/comments/`)) {
            discoveredPostUrls.add(href);
          }
        } catch (e) {
          continue;
        }
      }

      if (discoveredPostUrls.size > initialUrlCount) {
        console.log(`Discovered ${discoveredPostUrls.size - initialUrlCount} new posts in r/${currentSubreddit}. Total: ${discoveredPostUrls.size}`);
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
    const loadMoreTexts = [
      'view more comments',
      'continue this thread',
      'load more comments'
    ];

    for (const button of buttons) {
      try {
        const textContent = await button.evaluate(node => node.textContent.trim().toLowerCase());
        if (loadMoreTexts.some(text => textContent.includes(text))) {
          if (await button.isVisible()) {
            return button;
          }
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  }
}
