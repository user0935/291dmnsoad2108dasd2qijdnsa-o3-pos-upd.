/**
 * RedditArchiveBehavior (Browsertrix v1.18.0 compatible) - Final single-file behavior
 *
 * - Infinite-scroll post discovery (MutationObserver + periodic scan)
 * - In-page normalization & dedupe (keeps Node memory smaller)
 * - Handles delayed rendering
 * - Safe comment expansion: clicks only non-navigating controls; enqueues anchors
 * - Compatibility shims for Browsertrix v1.18.0 runtimes (context.utils, context.outlinks, ctx.log, etc)
 */
class RedditArchiveBehavior {
  static id = "reddit-archive-behavior";

  static init() {
    return {
      state: {
        discoveredPosts: 0,
        commentsExpanded: 0
      },
      opts: {}
    };
  }

  static isMatch() {
    const host = window.location.hostname;
    return ["www.reddit.com", "reddit.com", "old.reddit.com"].includes(host);
  }

  async *run(context) {
    // ---------- Basic context shims & compatibility ----------
    this.context = context || {};
    // page handle (Playwright-like) if provided by the runner
    this.page = this.context.page || this.context.pageHandle || null;

    // utils shim: try context.utils, then a small shim using page.evaluate or setTimeout
    this.utils = this.context.utils || (this.context.Lib && this.context.Lib.utils) || {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      // scroll(page, opts) -> attempt page.evaluate scroll, else do nothing
      scroll: async (page, opts) => {
        try {
          if (page && typeof page.evaluate === "function") {
            await page.evaluate(() => {
              try {
                window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
              } catch (e) {
                window.scrollTo(0, document.body.scrollHeight);
              }
            });
          } else {
            // fallback busy-wait to reduce tight loops
            await new Promise((r) => setTimeout(r, 200));
          }
        } catch (e) {
          // swallow
        }
      }
    };

    // async addOutlink shim that tries multiple known APIs, or falls back to in-page buffer
    this.addOutlink = async (url) => {
      if (!url) return false;
      try {
        if (this.context.outlinks && typeof this.context.outlinks.add === "function") {
          this.context.outlinks.add(url);
          return true;
        }
        if (this.context.Lib && typeof this.context.Lib.addLink === "function") {
          this.context.Lib.addLink(url);
          return true;
        }
        if (typeof this.context.addOutlink === "function") {
          this.context.addOutlink(url);
          return true;
        }
        // Last resort: push into the in-page buffer (if we installed it)
        if (this.page && typeof this.page.evaluate === "function") {
          try {
            await this.page.evaluate((u) => {
              if (window.__redditArchive && typeof window.__redditArchive.pushIfNew === "function") {
                window.__redditArchive.pushIfNew(u);
              } else {
                // ensure buffer exists and push; this fallback duplicates minimal behavior
                window.__redditArchive = window.__redditArchive || { buffer: [], pushIfNew(raw) { try { const n = raw; if (!this.buffer.includes(n)) this.buffer.push(n); } catch(e){} } };
                window.__redditArchive.pushIfNew(u);
              }
            }, url);
            return true;
          } catch (e) {
            // swallow
          }
        }
      } catch (e) {
        // swallow
      }
      return false;
    };

    // Prefer crawler logging if present
    this.log = (msg, level = "info") => {
      try {
        if (this.context && typeof this.context.log === "function") return this.context.log(msg, level);
      } catch (e) {}
      try {
        // best effort to console.log for local debugging
        console.log(`[RedditArchiveBehavior] ${msg}`);
      } catch (e) {}
    };
    // ---------------------------------------------------------

    // ---------- CONFIG (tweak these to taste) ----------
    const cfg = {
      USE_BROWSERTRIX_AUTOSCROLL: false, // true = rely on Browsertrix autoscroll (script will not scroll)
      NEVER_STOP: false,                 // true = never stop until Browsertrix leaves page
      MAX_IDLE_CYCLES: 12,               // cycles (polls) with no new posts before stopping (ignored if NEVER_STOP)
      SCROLL_INTERVAL_MS: 5000,          // wait after scroll (or when polling) to allow loads (increase for very large subs)
      INITIAL_PAGE_LOAD_WAIT_MS: 5000,   // wait after page load to allow delayed elements to appear
      PERIODIC_SCAN_MS: 7000,            // periodic in-page full-scan fallback
      MAX_BATCH_SIZE: 400,               // max outlinks added per batch
      CLICK_LOAD_MORE_COMMENTS: true,    // enable clicking "load more" on post pages
      MAX_COMMENT_LOAD_CLICKS: 30,       // max times to click load-more per post
      WAIT_AFTER_COMMENT_CLICK_MS: 2500, // wait after clicking load-more for comments to render
      LOG_ENQUEUED_ANCHORS: false        // set true to log whenever an anchor href is enqueued
    };
    this.cfg = cfg;
    // ----------------------------------------------------

    this.log(`Starting on: ${this.page ? (this.page.url ? this.page.url() : (this.page._url || "unknown page handle")) : "no page handle available"}`);

    // allow the page to finish loading & delayed render
    try {
      if (this.page && typeof this.page.waitForLoadState === "function") {
        await this.page.waitForLoadState("load");
      }
    } catch (e) {
      // non-fatal
    }
    await this.utils.wait(cfg.INITIAL_PAGE_LOAD_WAIT_MS);

    // If this is a post page, expand comments first (optional)
    try {
      const currentUrl = (this.page && typeof this.page.url === "function") ? this.page.url() : (this.page && this.page._url) ? this.page._url : (typeof window !== "undefined" ? window.location.href : "");
      if (currentUrl && currentUrl.includes("/comments/") && cfg.CLICK_LOAD_MORE_COMMENTS) {
        await this._expandCommentsOnPostPage();
      }
    } catch (e) {
      // swallow
    }

    // install page-side buffer & observer
    await this._installPageBufferAndObserver(cfg.PERIODIC_SCAN_MS);

    // Node-side driver loop: pull buffer, add to outlinks, scroll (optional), repeat
    let idleCycles = 0;
    let totalDiscovered = 0;
    const addedLocal = new Set();

    const pullAndAddBatch = async () => {
      try {
        // pull buffered urls from page
        const newUrls = await (this.page && typeof this.page.evaluate === "function"
          ? this.page.evaluate(() => {
              try {
                const arr = (window.__redditArchive && window.__redditArchive.buffer) ? window.__redditArchive.buffer.splice(0) : [];
                return arr;
              } catch (e) {
                return [];
              }
            })
          : Promise.resolve([]));

        if (!Array.isArray(newUrls) || newUrls.length === 0) return 0;

        const batch = newUrls.slice(0, cfg.MAX_BATCH_SIZE);
        let added = 0;
        for (const url of batch) {
          if (!url || addedLocal.has(url)) continue;
          try {
            const ok = await this.addOutlink(url);
            if (ok) {
              addedLocal.add(url);
              totalDiscovered++;
              this.context.state.discoveredPosts = (this.context.state.discoveredPosts || 0) + 1;
              added++;
            }
          } catch (e) {
            this.log(`Failed to add outlink ${url}: ${e}`, "warn");
          }
        }
        return added;
      } catch (e) {
        this.log(`Error in pullAndAddBatch: ${e}`, "error");
        return 0;
      }
    };

    // driver loop
    while (cfg.NEVER_STOP || idleCycles < cfg.MAX_IDLE_CYCLES) {
      const addedNow = await pullAndAddBatch();
      if (addedNow > 0) {
        idleCycles = 0;
        this.log(`Added ${addedNow} outlinks (total discovered: ${totalDiscovered}).`);
      } else {
        idleCycles++;
        this.log(`No new posts this cycle. idleCycles=${idleCycles}/${cfg.MAX_IDLE_CYCLES}`);
      }

      // scroll only if script controls scrolling
      if (!cfg.USE_BROWSERTRIX_AUTOSCROLL) {
        try {
          await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
        } catch (e) {
          try {
            if (this.page && typeof this.page.evaluate === "function") {
              await this.page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
            }
          } catch (_) {}
        }
      }
      // wait for page to fetch & render
      await this.utils.wait(cfg.SCROLL_INTERVAL_MS);

      // pull again
      const addedAfterWait = await pullAndAddBatch();
      if (addedAfterWait > 0) {
        idleCycles = 0;
        this.log(`Added ${addedAfterWait} outlinks after wait (total discovered: ${totalDiscovered}).`);
      }
    }

    // final flush
    let finalAdded = 0;
    while (true) {
      const added = await pullAndAddBatch();
      if (added === 0) break;
      finalAdded += added;
      await this.utils.wait(250);
    }

    this.log(`Finished. total discovered: ${totalDiscovered} (final flush added ${finalAdded}).`);
  }

  // ----------------- helper: install page buffer & observer -----------------
  async _installPageBufferAndObserver(PERIODIC_SCAN_MS) {
    try {
      await (this.page && typeof this.page.evaluate === "function"
        ? this.page.evaluate((PERIODIC_SCAN_MS) => {
            if (window.__redditArchive && window.__redditArchive._installed) return;

            window.__redditArchive = {
              _installed: true,
              discovered: Object.create(null), // map of normalized URL -> true
              buffer: [],
              normalize(raw) {
                try {
                  const u = new URL(raw, location.href);
                  u.hash = "";
                  ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref"].forEach(k => u.searchParams.delete(k));
                  return u.href;
                } catch (e) {
                  return null;
                }
              },
              pushIfNew(raw) {
                const n = this.normalize(raw);
                if (!n) return false;
                if (this.discovered[n]) return false;
                this.discovered[n] = true;
                this.buffer.push(n);
                return true;
              }
            };

            const tryPushFromNode = (node) => {
              try {
                if (!node) return;
                if (node.tagName && node.tagName.toLowerCase() === "shreddit-post") {
                  const p = node.post;
                  if (p && p.url) window.__redditArchive.pushIfNew(p.url);
                  return;
                }
                if (node.nodeType === Node.ELEMENT_NODE) {
                  if (node.matches && node.matches('a[href*="/comments/"], a[data-click-id="comments"], a[data-click-id="body"]')) {
                    try {
                      if (node.href) window.__redditArchive.pushIfNew(node.href);
                    } catch (e) {}
                  }
                  const found = node.querySelectorAll && node.querySelectorAll('a[href*="/comments/"], a[data-click-id="comments"], a[data-click-id="body"], .morecomments');
                  if (found && found.length) {
                    for (const a of found) {
                      if (a.href) window.__redditArchive.pushIfNew(a.href);
                    }
                  }
                }
              } catch (e) {
                // swallow
              }
            };

            // initial scan
            try {
              const initial = document.querySelectorAll && document.querySelectorAll("shreddit-post, a[href*='/comments/'], a[data-click-id='comments'], a[data-click-id='body'], .morecomments");
              if (initial && initial.length) {
                initial.forEach(n => tryPushFromNode(n));
              }
            } catch (e) {}

            // MutationObserver
            const observer = new MutationObserver((mutations) => {
              for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                  for (const node of m.addedNodes) {
                    tryPushFromNode(node);
                  }
                } else if (m.target) {
                  tryPushFromNode(m.target);
                }
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // Periodic fallback scan
            setInterval(() => {
              try {
                const list = document.querySelectorAll && document.querySelectorAll("shreddit-post, a[href*='/comments/'], a[data-click-id='comments'], a[data-click-id='body'], .morecomments");
                if (list && list.length) {
                  list.forEach(n => tryPushFromNode(n));
                }
              } catch (e) {}
            }, PERIODIC_SCAN_MS);
          }, PERIODIC_SCAN_MS)
        : Promise.resolve());
    } catch (e) {
      this.log(`Failed to install in-page archive observer: ${e}`, "error");
    }
  }

  // ----------------- helper: expand comments on post pages -----------------
  async _expandCommentsOnPostPage() {
    try {
      this.log(`Expanding comments on post page.`);
      let clicked = 0;
      let attempts = 0;
      const maxClicks = (this.cfg && this.cfg.MAX_COMMENT_LOAD_CLICKS) ? this.cfg.MAX_COMMENT_LOAD_CLICKS : 30;
      const waitAfterClick = (this.cfg && this.cfg.WAIT_AFTER_COMMENT_CLICK_MS) ? this.cfg.WAIT_AFTER_COMMENT_CLICK_MS : 2500;

      // Safe clicker & enqueuer: clicks only non-navigating controls, enqueues anchors instead
      const clickOneLoadMore = async () => {
        return await (this.page && typeof this.page.evaluate === "function"
          ? this.page.evaluate(() => {
              try {
                const textCandidates = [
                  "view more comments",
                  "continue this thread",
                  "load more comments",
                  "more comments",
                  "more replies",
                  "show more replies"
                ];

                const selector = [
                  'button',
                  'a',
                  '[role="button"]',
                  '[onclick]',
                  '.morecomments',
                  '[data-click-id="comments"]',
                  '[data-click-id="more_comments"]'
                ].join(',');

                const elems = Array.from(document.querySelectorAll(selector));

                const isVisible = (el) => {
                  try {
                    const style = window.getComputedStyle(el);
                    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
                    return true;
                  } catch (e) {
                    return false;
                  }
                };

                const anchorIsNavigable = (a) => {
                  try {
                    const href = a.getAttribute && a.getAttribute('href');
                    if (!href) return false;
                    const fragile = href.startsWith('#') || href.startsWith('javascript:') || href === '';
                    if (fragile) return false;
                    try {
                      const u = new URL(href, location.href);
                      if (u.origin !== location.origin) return true;
                      if (u.pathname.includes('/comments/')) return true;
                      return true;
                    } catch (e) {
                      return false;
                    }
                  } catch (e) {
                    return true;
                  }
                };

                for (const el of elems) {
                  try {
                    if (!isVisible(el)) continue;

                    const tag = el.tagName && el.tagName.toLowerCase();

                    if (tag === 'a') {
                      if (anchorIsNavigable(el)) {
                        const href = el.href || el.getAttribute('href');
                        if (href && window.__redditArchive && typeof window.__redditArchive.pushIfNew === 'function') {
                          window.__redditArchive.pushIfNew(href);
                        }
                        continue;
                      }
                    }

                    const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
                    for (const phrase of textCandidates) {
                      if (txt.includes(phrase)) {
                        if (tag === 'a' && anchorIsNavigable(el)) {
                          const href = el.href || el.getAttribute('href');
                          if (href && window.__redditArchive && typeof window.__redditArchive.pushIfNew === 'function') {
                            window.__redditArchive.pushIfNew(href);
                          }
                          return { clicked: false, enqueued: true, reason: 'anchor-enqueued', text: txt, href: href };
                        }
                        try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
                        try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
                        return { clicked: true, method: 'text-match', text: txt, tag: tag };
                      }
                    }

                    if (el.classList && el.classList.contains && el.classList.contains('morecomments')) {
                      if (tag === 'a' && anchorIsNavigable(el)) {
                        const href = el.href || el.getAttribute('href');
                        if (href && window.__redditArchive && typeof window.__redditArchive.pushIfNew === 'function') {
                          window.__redditArchive.pushIfNew(href);
                        }
                        return { clicked: false, enqueued: true, reason: 'morecomments-anchor-enqueued', href };
                      } else {
                        try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
                        try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
                        return { clicked: true, method: 'morecomments-class', tag: tag };
                      }
                    }

                    const dci = el.getAttribute && (el.getAttribute('data-click-id') || '');
                    if (dci && (dci.includes('comments') || dci.includes('more'))) {
                      if (tag === 'a' && anchorIsNavigable(el)) {
                        const href = el.href || el.getAttribute('href');
                        if (href && window.__redditArchive && typeof window.__redditArchive.pushIfNew === 'function') {
                          window.__redditArchive.pushIfNew(href);
                        }
                        return { clicked: false, enqueued: true, reason: 'data-click-id-anchor-enqueued', attr: dci, href };
                      } else {
                        try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
                        try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
                        return { clicked: true, method: 'data-click-id', attr: dci, tag: tag };
                      }
                    }

                  } catch (e) {
                    // ignore element errors
                  }
                }
                return { clicked: false };
              } catch (e) {
                return { clicked: false, error: String(e) };
              }
            })
          : Promise.resolve({ clicked: false }));
      };

      // loop to click/enqueue until no more or until limit reached
      while (clicked < maxClicks && attempts < (maxClicks * 2 + 10)) {
        const res = await clickOneLoadMore();
        attempts++;
        if (res && res.clicked) {
          clicked++;
          this.context.state.commentsExpanded = (this.context.state.commentsExpanded || 0) + 1;
          this.log(`Clicked comment expansion (${clicked}) result: ${res.text || res.tag || res.method}`);
          await this.utils.wait(waitAfterClick);
          try {
            await this.utils.scroll(this.page, { behavior: "smooth", direction: "down" });
          } catch (_) {}
        } else {
          if (res && res.enqueued && this.cfg.LOG_ENQUEUED_ANCHORS) {
            this.log(`Enqueued anchor during comment expansion: ${res.href || res.reason}`);
          }
          if (attempts > 3 && clicked === 0) {
            // wait and retry once if nothing immediately found (handles slow render)
            await this.utils.wait(waitAfterClick);
          } else {
            break;
          }
        }
      }

      this.log(`Comment expansion finished. total clicks: ${clicked}, attempts: ${attempts}.`);
    } catch (e) {
      this.log(`Error expanding comments on post page: ${e}`, "error");
    }
  }
}
