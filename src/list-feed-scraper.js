import WebSocket from 'ws';
import fetch from 'node-fetch';
import { config } from './config.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.eventWaiters = new Map(); // method -> Set<{predicate, resolve, reject, timer}>

    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
        return;
      }

      if (msg.method) {
        const waiters = this.eventWaiters.get(msg.method);
        if (!waiters || waiters.size === 0) return;
        for (const w of [...waiters]) {
          try {
            if (w.predicate && !w.predicate(msg.params)) continue;
          } catch (e) {
            waiters.delete(w);
            if (w.timer) clearTimeout(w.timer);
            w.reject(e);
            continue;
          }
          waiters.delete(w);
          if (w.timer) clearTimeout(w.timer);
          w.resolve(msg.params);
        }
      }
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`CDP call timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload), err => {
        if (!err) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  waitForEvent(method, { predicate = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || new Set();
      const w = { predicate, resolve, reject, timer: null };
      if (timeoutMs && timeoutMs > 0) {
        w.timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`CDP event timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }
      waiters.add(w);
      this.eventWaiters.set(method, waiters);
    });
  }
}

async function getPageTargetWsUrl({ host, port }) {
  const url = `http://${host}:${port}/json/list`;
  const res = await withTimeout(fetch(url), 5000, `GET ${url}`);
  if (!res.ok) {
    throw new Error(`Failed to query CDP targets: HTTP ${res.status} ${res.statusText}`);
  }
  const targets = await res.json();
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('No CDP targets returned from /json/list');
  }

  // Prefer an existing page target with a mostly blank URL (so we don't hijack another workflow).
  const pageTargets = targets.filter(t => t && t.type === 'page' && t.webSocketDebuggerUrl);
  if (pageTargets.length === 0) {
    throw new Error('No CDP page targets with webSocketDebuggerUrl found');
  }

  const preferred =
    pageTargets.find(t => !t.url || t.url === 'about:blank' || t.url.startsWith('chrome://')) ||
    pageTargets[0];

  return preferred.webSocketDebuggerUrl;
}

const EXTRACT_TWEETS_JS = `
(() => {
  window.__allTweets = window.__allTweets || {};

  function extractTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const art of articles) {
      try {
        const timeEl = art.querySelector('time');
        if (!timeEl) continue;
        const datetime = timeEl.getAttribute('datetime') || '';
        const textEl = art.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText : '';

        // Extract @handle
        const userLinks = art.querySelectorAll('a[href^="/"]');
        let author = '';
        for (const link of userLinks) {
          const spans = link.querySelectorAll('span');
          for (const span of spans) {
            const s = (span.textContent || '').trim();
            if (s.startsWith('@')) {
              author = s;
              break;
            }
          }
          if (author) break;
        }

        // Extract tweet URL
        const timeLink = timeEl.closest('a');
        let tweetUrl = '';
        if (timeLink) {
          const href = timeLink.getAttribute('href') || '';
          if (href.startsWith('http')) tweetUrl = href;
          else if (href.startsWith('/')) tweetUrl = 'https://x.com' + href;
        }

        const key = tweetUrl || (datetime + '|' + text.substring(0, 50));
        if (!window.__allTweets[key]) {
          window.__allTweets[key] = {
            author,
            text: (text || '').substring(0, 800),
            datetime,
            tweetUrl
          };
        }
      } catch (e) {}
    }
  }

  extractTweets();
  return true;
})()
`;

const GET_TWEETS_JS = `
(() => {
  const obj = window.__allTweets || {};
  return Object.values(obj);
})()
`;

/**
 * CDP-based X List feed scraper.
 * Returns: Array<{author, text, datetime, tweetUrl}>
 */
export async function scrapeListFeed() {
  const cfg = config.listFeed;
  if (!cfg || !cfg.url) {
    throw new Error('Missing config.listFeed.url (set LIST_FEED_URL)');
  }

  const host = cfg.cdpHost || '127.0.0.1';
  const port = Number(cfg.cdpPort || 18800);

  console.log(`[list-feed] CDP target: ${host}:${port}`);
  console.log(`[list-feed] URL: ${cfg.url}`);

  let ws;
  try {
    const wsUrl = await getPageTargetWsUrl({ host, port });
    console.log(`[list-feed] Using CDP WS: ${wsUrl}`);

    ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
      15000,
      'CDP websocket open'
    );

    const cdp = new CdpClient(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Navigate.
    await cdp.send('Page.navigate', { url: cfg.url }, 15000);

    // Prefer waiting for the load event, but also keep a fixed delay for stability on cron.
    try {
      await cdp.waitForEvent('Page.loadEventFired', { timeoutMs: Math.max(10000, cfg.pageLoadTimeoutMs || 30000) });
    } catch (e) {
      console.warn(`[list-feed] loadEventFired wait failed (continuing): ${e.message}`);
    }
    await sleep(cfg.pageLoadDelay);

    // Extract + scroll loop.
    const scrollCount = cfg.scrollCount;
    const scrollDelay = cfg.scrollDelay;
    const scrollAmount = cfg.scrollAmount;

    console.log(`[list-feed] Scrolling: count=${scrollCount} amount=${scrollAmount}px delay=${scrollDelay}ms`);

    for (let i = 0; i < scrollCount; i++) {
      await cdp.send(
        'Runtime.evaluate',
        { expression: EXTRACT_TWEETS_JS, returnByValue: true, awaitPromise: true },
        15000
      );
      await cdp.send(
        'Runtime.evaluate',
        { expression: `window.scrollBy(0, ${scrollAmount}); true;`, returnByValue: true },
        15000
      );
      await sleep(scrollDelay);
    }

    // Final extract + read results.
    await cdp.send('Runtime.evaluate', { expression: EXTRACT_TWEETS_JS, returnByValue: true, awaitPromise: true }, 15000);
    const res = await cdp.send('Runtime.evaluate', { expression: GET_TWEETS_JS, returnByValue: true, awaitPromise: true }, 20000);
    const tweets = (res && res.result && Array.isArray(res.result.value)) ? res.result.value : [];

    const out = [];
    const seen = new Set();
    for (const t of tweets) {
      if (!t || typeof t !== 'object') continue;
      const author = (t.author || '').trim();
      const text = (t.text || '').trim();
      const datetime = (t.datetime || '').trim();
      let tweetUrl = (t.tweetUrl || '').trim();
      if (tweetUrl && tweetUrl.startsWith('/')) tweetUrl = `https://x.com${tweetUrl}`;
      const key = tweetUrl || `${author}|${datetime}|${text.slice(0, 50)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ author, text, datetime, tweetUrl });
    }

    console.log(`[list-feed] Extracted tweets: ${out.length}`);
    return out;
  } catch (err) {
    console.error('[list-feed] Scrape failed:', err);
    throw err;
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'done');
    }
  }
}

