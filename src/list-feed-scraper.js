// GraphQL-based list-feed scraper (rewritten 2026-04-27)
//
// Why: as of 2026-04-25, X.com's list timeline DOM stops virtualizing more than
// ~5 articles when scrolled by automation, even though the underlying graphql
// `ListLatestTweetsTimeline` API returns ~90 tweets per page. The old DOM scrape
// approach silently degraded from ~150 tweets to 4-5 tweets per run.
//
// Fix: navigate the page (so cookies/CSRF/headers are correctly set by the SPA),
// capture the graphql JSON response via CDP Network domain, parse tweet objects
// directly. No reliance on DOM rendering or scroll virtualization.
//
// Backward-compatible signature: scrapeListFeed(overrideCdpPort) returns
//   Array<{author, text, datetime, tweetUrl, images}>
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
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // method -> array of fn
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const fns = this.listeners.get(msg.method);
        if (fns) for (const fn of fns) { try { fn(msg.params); } catch {} }
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`CDP timeout: ${method} (${timeoutMs}ms)`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function createFreshPageTarget({ host, port }) {
  const url = `http://${host}:${port}/json/new?about:blank`;
  let res;
  try {
    res = await withTimeout(fetch(url, { method: 'PUT' }), 5000, `PUT ${url}`);
    if (!res.ok) throw new Error(`PUT /json/new HTTP ${res.status}`);
  } catch {
    res = await withTimeout(fetch(url), 5000, `GET ${url}`);
    if (!res.ok) throw new Error(`GET /json/new HTTP ${res.status}`);
  }
  const target = await res.json();
  if (!target?.webSocketDebuggerUrl || !target?.id) {
    throw new Error(`/json/new returned invalid target: ${JSON.stringify(target).slice(0, 200)}`);
  }
  return { wsUrl: target.webSocketDebuggerUrl, targetId: target.id };
}

async function closePageTarget({ host, port, targetId }) {
  if (!targetId) return;
  try {
    await withTimeout(fetch(`http://${host}:${port}/json/close/${targetId}`), 5000, 'close target');
  } catch (e) {
    console.warn(`[list-feed] Failed to close target ${targetId}: ${e.message}`);
  }
}

// --- Parse one timeline graphql response into normalized tweet objects ----
function parseTimelineResponse(json) {
  const out = [];
  let nextCursor = null;
  try {
    const instructions = json?.data?.list?.tweets_timeline?.timeline?.instructions || [];
    for (const ins of instructions) {
      const entries = ins.entries || ins.entry ? (ins.entries || [ins.entry]) : [];
      for (const e of entries) {
        // cursor entries
        const cursorVal = e?.content?.value;
        const cursorType = e?.content?.cursorType;
        if (cursorType === 'Bottom' && cursorVal) {
          nextCursor = cursorVal;
          continue;
        }
        const r = e?.content?.itemContent?.tweet_results?.result;
        if (!r) continue;
        // unwrap TweetWithVisibilityResults
        const tweetObj = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
        const legacy = tweetObj?.legacy;
        if (!legacy) continue;

        const userR =
          tweetObj?.core?.user_results?.result ||
          r?.core?.user_results?.result;
        // X moved screen_name from legacy to core (2026)
        const screenName =
          userR?.core?.screen_name ||
          userR?.legacy?.screen_name ||
          '';

        // Resolve full_text (may be truncated for retweets)
        let text = legacy.full_text || '';
        const rt = legacy.retweeted_status_result?.result;
        if (rt) {
          const rtTweet = rt.__typename === 'TweetWithVisibilityResults' ? rt.tweet : rt;
          const rtFull = rtTweet?.legacy?.full_text;
          const rtUser =
            rtTweet?.core?.user_results?.result?.core?.screen_name ||
            rtTweet?.core?.user_results?.result?.legacy?.screen_name ||
            '';
          if (rtFull) text = `RT @${rtUser}: ${rtFull}`;
        }

        // images (from extended_entities.media or entities.media)
        const images = [];
        const media =
          legacy.extended_entities?.media ||
          legacy.entities?.media ||
          [];
        for (const m of media) {
          let url = m.media_url_https || m.media_url || '';
          if (url) {
            // Use large variant
            url = url.includes('?') ? url : `${url}?name=large`;
            images.push(url);
          }
        }

        const id = legacy.id_str || tweetObj?.rest_id || '';
        const created = legacy.created_at || ''; // "Sun Apr 27 05:32:35 +0000 2026"
        // ISO datetime
        let datetime = '';
        if (created) {
          const d = new Date(created);
          if (!isNaN(d.getTime())) datetime = d.toISOString();
        }
        const author = screenName ? `@${screenName}` : '';
        const tweetUrl = screenName && id ? `https://x.com/${screenName}/status/${id}` : '';

        out.push({ author, text: text.substring(0, 800), datetime, tweetUrl, images });
      }
    }
  } catch (e) {
    console.warn(`[list-feed] parseTimelineResponse error: ${e.message}`);
  }
  return { tweets: out, nextCursor };
}

// ---- Main entry ----
export async function scrapeListFeed(overrideCdpPort) {
  const cfg = config.listFeed;
  if (!cfg || !cfg.url) throw new Error('Missing config.listFeed.url (set LIST_FEED_URL)');

  const host = cfg.cdpHost || '127.0.0.1';
  const port = overrideCdpPort != null ? Number(overrideCdpPort) : Number(cfg.cdpPort || 18800);

  console.log(`[list-feed] CDP target: ${host}:${port}`);
  console.log(`[list-feed] URL: ${cfg.url}`);
  console.log('[list-feed] Mode: graphql-capture (DOM-independent)');

  // How many graphql pages to capture. Default 4 (~4*90 = 360 tweets), enough
  // for a daily digest with 24h filtering. Configurable via LIST_FEED_PAGES.
  const maxPages = Number(process.env.LIST_FEED_PAGES) || cfg.maxPages || 4;
  const pageWaitMs = Number(process.env.LIST_FEED_PAGE_WAIT_MS) || cfg.pageWaitMs || 8000;

  let ws, freshTargetId = null;
  try {
    let wsUrl;
    try {
      const fresh = await createFreshPageTarget({ host, port });
      wsUrl = fresh.wsUrl;
      freshTargetId = fresh.targetId;
      console.log(`[list-feed] Created fresh CDP target: ${freshTargetId}`);
    } catch (e) {
      throw new Error(`Failed to create fresh CDP target: ${e.message}`);
    }

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

    // Capture timeline responses
    const timelineRequests = []; // {requestId, url}
    cdp.on('Network.responseReceived', params => {
      const url = params?.response?.url || '';
      if (url.includes('ListLatestTweetsTimeline')) {
        timelineRequests.push({ requestId: params.requestId, url });
      }
    });
    cdp.on('Network.loadingFailed', params => {
      // ignore for now; we'll just see fewer responses
    });

    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Patch navigator.webdriver before any page load (cheap "stealth" — does not
    // affect today's behaviour but may help if X tightens detection later).
    try {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator, 'webdriver', {get: () => undefined});`
      });
    } catch {}

    // Initial navigation
    console.log(`[list-feed] Navigating to list (page 1)...`);
    await cdp.send('Page.navigate', { url: cfg.url }, 15000);
    try {
      // wait for load event but don't fail if it never fires
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('loadEventFired timeout')), 30000);
        const wrap = () => { clearTimeout(t); res(); };
        cdp.on('Page.loadEventFired', wrap);
      });
    } catch (e) {
      console.warn(`[list-feed] loadEventFired wait: ${e.message} (continuing)`);
    }
    await sleep(pageWaitMs);

    // Trigger more graphql pages by scrolling. Even if DOM doesn't render
    // the new tweets, the scroll handler will issue paginated graphql requests
    // for IntersectionObserver targets in the timeline.
    for (let page = 1; page < maxPages; page++) {
      console.log(`[list-feed] Triggering page ${page + 1}/${maxPages} via scroll...`);
      // Programmatic scrolls + dispatch scroll events
      for (let s = 0; s < 6; s++) {
        await cdp.send('Runtime.evaluate', {
          expression: `
            window.scrollTo({top: window.scrollY + 1500, behavior: 'auto'});
            window.dispatchEvent(new Event('scroll', {bubbles: true}));
          `
        }).catch(() => {});
        await sleep(800);
      }
      await sleep(pageWaitMs);
    }

    console.log(`[list-feed] Captured ${timelineRequests.length} ListLatestTweetsTimeline response(s)`);

    // Pull bodies and parse
    const allTweets = new Map();
    let pageNum = 0;
    for (const req of timelineRequests) {
      pageNum++;
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: req.requestId }, 10000);
        const txt = body.body || '';
        const json = JSON.parse(txt);
        const { tweets } = parseTimelineResponse(json);
        let added = 0;
        for (const t of tweets) {
          const key = t.tweetUrl || `${t.author}|${t.datetime}|${t.text.substring(0, 50)}`;
          if (!allTweets.has(key)) {
            allTweets.set(key, t);
            added++;
          }
        }
        console.log(`[list-feed]   page ${pageNum}: body=${(txt.length / 1024).toFixed(0)}K, parsed=${tweets.length}, new=${added}`);
      } catch (e) {
        console.warn(`[list-feed]   page ${pageNum}: ${e.message}`);
      }
    }

    const out = Array.from(allTweets.values());
    console.log(`[list-feed] Extracted tweets: ${out.length}`);

    // If we got 0 tweets but had requests, something is wrong (parsing or empty list)
    if (out.length === 0 && timelineRequests.length > 0) {
      console.warn('[list-feed] 0 tweets parsed despite captured responses; structure may have changed');
    }
    // If 0 captured responses at all, page may be redirected to login or X is blocking
    if (timelineRequests.length === 0) {
      console.warn('[list-feed] 0 ListLatestTweetsTimeline responses captured — cookie expired or list URL wrong?');
    }

    return out;
  } catch (err) {
    console.error('[list-feed] Scrape failed:', err);
    throw err;
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, 'done'); } catch {}
    }
    if (freshTargetId) {
      await closePageTarget({ host, port, targetId: freshTargetId });
    }
  }
}
