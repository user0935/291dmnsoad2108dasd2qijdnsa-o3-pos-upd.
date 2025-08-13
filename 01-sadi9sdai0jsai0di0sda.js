/**
 * RedditInfiniteScrollBrowsertrix
 * - Compatible with Browsertrix v1.18.0 (Playwright-style context.page + context.utils)
 * - MutationObserver in page + fallback anchor scanning
 * - Normalizes and dedupes URLs inside the page to keep Node memory small
 *
 * Config (edit top-level consts as needed):
 *  - NEVER_STOP: if true, script will not stop by idle-count; Browsertrix controls page lifecycle
 *  - MAX_IDLE_CYCLES: number of scroll cycles without new posts before stopping (ignored if NEVER_STOP)
 *  - SCROLL_INTERVAL_MS: how long to wait after each scroll
 *  - BATCH_ADD_MS: how often (ms) to pull buffered URLs from the page and push to context.outlinks
 *  - MAX_BATCH_SIZE: maximum outlinks added per batch (prevents spikes)
 */
class RedditInfiniteScrollBrowsertrix {
  static id = "reddit-infinite-scroll-browsertrix";

  static init() {
    return {
      state: { discoveredPosts: 0 },
      opts: {}
    };
  }

  static isMatch() {
    const supported = ["www.reddit.com", "reddit.com", "old.reddit.com"];
    return supported.includes(window.location.hostname);
  }

  async *run(context) {
    if (!context || !context.page || !context.utils) {
      console.error("Missing context/page/utils in RedditInfiniteScrollBrowsertrix.");
      return;
    }
    this.context = context;
    this.page = context.page;
    this.utils = context.utils;

    // ---------- Config ----------
    const NEVER_STOP = false;           // set true if you want Browsertrix to control when to leave the page
    const MAX_IDLE_CYCLES = 8;         // how many scroll cycles with zero new posts before stopping
    const SCROLL_INTERVAL_MS = 4000;   // wait after scroll to allow new posts to load
    const BATCH_ADD_MS = 3000;         // how frequently we pull buffered URLs from the page
    const MAX_BATCH_SIZE = 500;        // max URLs added per batch
    // ----------------------------

    console.log("RedditInfiniteScrollBrowsertrix starting on:", this.page.url());

    // Inject the page-side observer and buffer (runs in browser context)
    await this.page.evaluate(() => {
      if (window.__redditArchive && window.__redditArchive._installed) return;

      window.__redditArchive = {
        _installed: true,
        discovered: Object.create(null), // keys are normalized full URLs -> true (keeps memory inside page)
        buffer: [],                       // new URLs waiting to be pulled by the driver loop
        normalize(url) {
          try {
            const u = new URL(url, location.href);
            // Normalize: strip utm or reddit query noise but keep permalink and comment hash if present
            // Keep pathname + query only if it contains '/comments/' (so we keep post permalinks)
            // Otherwise keep full href for safety.
            // Minimal normalization to avoid accidental collisions.
            if (u.pathname.includes("/comments/")) {
              u.hash = ""; // drop fragment
              // remove common tracking params
              ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref"].forEach(k => u.searchParams.delete(k));
              return u.href;
            }
            // for other reddit links (profiles, subreddit links) return full href without fragments
            u.hash = "";
            ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref"].forEach(k => u.searchParams.delete(k));
            return u.href;
          } catch (e) {
            return null;
          }
        },
        pushIfNew(rawUrl) {
          const normalized = this.normalize(rawUrl);
          if (!normalized) return false;
          if (this.discovered[normalized]) return false;
          this.discovered[normalized] = true;
          this.buffer.push(normalized);
          return true;
        }
      };

      // initial scan to capture any already-loaded posts (covers page load / restore)
      const tryPushFromNode = (node) => {
        try {
          // new reddit custom element
          if (node.tagName && node.tagName.toLowerCase() === "shreddit-post") {
            const p = node.post;
            if (p && p.url) window.__redditArchive.pushIfNew(p.url);
            return;
          }

          // generic anchor fallback (works for new & old reddit)
          if (node.nodeType === Node.ELEMENT_NODE) {
            // find comment/permalink anchors under the node
            const anchors = node.querySelectorAll && node.querySelectorAll('a[href*="/comments/"], a[data-click-id="comments"], a[data-click-id="body"]');
            if (anchors && anchors.length) {
              anchors.forEach(a => {
                if (a.href) window.__redditArchive.pushIfNew(a.href);
              });
            }
          }
        } catch (e) {
          // swallow - best-effort extraction
        }
      };

      // initial pass
      try {
        document.querySelectorAll && document.querySelectorAll("shreddit-post, a[href*='/comments/'], a[data-click-id='comments'], a[data-click-id='body']").forEach(n => tryPushFromNode(n));
      } catch (e) {}

      // MutationObserver to capture added nodes (cheap)
      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            tryPushFromNode(node);
          }
          // Also check if new subtree added that contains multiple posts
          if (m.addedNodes.length === 0 && m.target) {
            tryPushFromNode(m.target);
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // Periodic scan fallback for edge cases (some dynamic frameworks replace large nodes)
      setInterval(() => {
        try {
          document.querySelectorAll && document.querySelectorAll("shreddit-post, a[href*='/comments/'], a[data-click-id='comments'], a[data-click-id='body']").forEach(n => tryPushFromNode(n));
        } catch (e) {}
      }, 7000);
    });

    // Node-side loop: periodically pull buffered URLs and add them to Browsertrix outlinks
    let idleCycles = 0;
    let totalDiscovered = 0;
    const addedLocal = new Set(); // small local set to avoid repeated add() in this run

    const pullAndAddBatch = async () => {
      try {
        const newUrls = await this.page.evaluate(() => {
          try {
            const buf = window.__redditArchive && window.__redditArchive.buffer ? window.__redditArchive.buffer.splice(0) : [];
            return buf;
          } catch (e) {
            return [];
          }
        });

        if (!newUrls || newUrls.length === 0) return 0;

        // limit per batch
        const slice = newUrls.slice(0, MAX_BATCH_SIZE);
        let addedCount = 0;
        for (const url of slice) {
          if (!url) continue;
          if (addedLocal.has(url)) continue;
          try {
            // add to Browsertrix outlinks queue
            this.context.outlinks.add(url);
            addedLocal.add(url);
            totalDiscovered++;
            this.context.state.discoveredPosts = (this.context.state.discoveredPosts || 0) + 1;
            addedCount++;
          } catch (e) {
            console.warn("Failed to add outlink:", e);
          }
        }
        return addedCount;
      } catch (e) {
        console.error("Error pulling buffered urls:", e);
        return 0;
      }
    };

    // driver loop: scroll -> wait -> pull -> repeat
    while (NEVER_STOP || idleCycles < MAX_IDLE_CYCLES) {
      // 1) pull any buffered urls now
      const addedNow = await pullAndAddBatch();
      if (addedNow > 0) {
        idleCycles = 0;
        console.log(`Added ${addedNow} new outlinks (total discovered: ${totalDiscovered}).`);
      } else {
        idleCycles++;
        console.log(`No new posts found this cycle. idleCycles=${idleCycles}/${MAX_IDLE_CYCLES}`);
      }

      // 2) scroll to trigger loading of more posts
      try {
        await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
      } catch (e) {
        // sometimes utils.scroll may fail in older Browsertrix; fallback to evaluate scroll
        try {
          await this.page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
        } catch (e2) {}
      }

      // 3) wait (long enough for reddit to fetch & render)
      await this.utils.wait(SCROLL_INTERVAL_MS);

      // 4) also pull after wait in case new posts arrived
      const addedAfterWait = await pullAndAddBatch();
      if (addedAfterWait > 0) {
        idleCycles = 0;
        console.log(`Added ${addedAfterWait} new outlinks after wait (total discovered: ${totalDiscovered}).`);
      }

      // if NEVER_STOP is false the while condition will eventually stop when idleCycles >= MAX_IDLE_CYCLES
    }

    // final flush before exit
    let finalAdded = 0;
    while (true) {
      const added = await pullAndAddBatch();
      if (added === 0) break;
      finalAdded += added;
      // small pause to avoid thrashing
      await this.utils.wait(500);
    }

    console.log(`RedditInfiniteScrollBrowsertrix finished. total discovered: ${totalDiscovered} (final flush added ${finalAdded}).`);
  }
}
