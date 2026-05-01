// GraphQL cursor-paginated list-feed scraper (proposed 2026-05-01).
//
// Background:
//   - Old DOM scrape (pre-2026-04-25) returned 150-180 tweets. Died when
//     X.com tightened the IntersectionObserver virtualization (only ~5
//     articles render at once in automation contexts).
//   - 2026-04-27 graphql-capture replaced DOM scrape: navigate the SPA, sniff
//     the single ListLatestTweetsTimeline response → ~80 tweets. Sufficient
//     but halved the daily input.
//   - This rewrite ADDS cursor-based pagination: after the SPA's first
//     graphql response, replay the same endpoint via page-context fetch using
//     the Bottom cursor. This is the same call the SPA makes when the user
//     scrolls — only the trigger is different.
//
// Safety profile (see outputs/twitter-scraper-fix-report.md for full eval):
//   - All requests originate from the real authenticated browser context
//     (real Chrome TLS, cookies, UA, sec-ch-ua, accept-encoding).
//   - 4 graphql calls/day uses ~1% of the 500/15min rate-limit budget.
//   - x-csrf-token is read from the ct0 cookie (same way SPA does).
//   - Bearer token is captured from the SPA's first request and reused.
//   - Random 8-15s delay between pages.
//
// Rollback: copy src/list-feed-scraper.js.bak-2026-05-01 → list-feed-scraper.js
//
// Backward-compatible signature: scrapeListFeed(overrideCdpPort) returns
//   Array<{author, text, datetime, tweetUrl, images}>
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { config } from './config.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }

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
    this.listeners = new Map();
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
      const entries = ins.entries || (ins.entry ? [ins.entry] : []);
      for (const e of entries) {
        const cursorVal = e?.content?.value;
        const cursorType = e?.content?.cursorType;
        if (cursorType === 'Bottom' && cursorVal) {
          nextCursor = cursorVal;
          continue;
        }
        const r = e?.content?.itemContent?.tweet_results?.result;
        if (!r) continue;
        const tweetObj = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
        const legacy = tweetObj?.legacy;
        if (!legacy) continue;

        const userR = tweetObj?.core?.user_results?.result || r?.core?.user_results?.result;
        const screenName =
          userR?.core?.screen_name ||
          userR?.legacy?.screen_name ||
          '';

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

        const images = [];
        const media = legacy.extended_entities?.media || legacy.entities?.media || [];
        for (const m of media) {
          let url = m.media_url_https || m.media_url || '';
          if (url) {
            url = url.includes('?') ? url : `${url}?name=large`;
            images.push(url);
          }
        }

        const id = legacy.id_str || tweetObj?.rest_id || '';
        const created = legacy.created_at || '';
        let datetime = '';
        if (created) {
          const d = new Date(created);
          if (!isNaN(d.getTime())) datetime = d.toISOString();
        }
        const author = screenName ? `@${screenName}` : '';
        const tweetUrl = screenName && id ? `https://x.com/${screenName}/status/${id}` : '';

        out.push({ author, text: text.substring(0, 800), datetime, tweetUrl, images, _id: id });
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

  // Pagination knobs (can be overridden by env)
  // Dynamic strategy: paginate until oldest tweet is older than cutoff,
  // OR maxPagesHardLimit reached (safety net). Default cutoff = 24h + 2h buffer.
  const maxPagesHardLimit = Number(process.env.LIST_FEED_PAGES_HARD_LIMIT) || cfg.maxPagesHardLimit || 12;
  const cutoffHours = Number(process.env.LIST_FEED_CUTOFF_HOURS) || cfg.cutoffHours || 26;
  const cutoffMs = Date.now() - cutoffHours * 3600 * 1000;
  // Legacy LIST_FEED_PAGES still honored as override (e.g. for one-off backfills)
  const fixedPages = Number(process.env.LIST_FEED_PAGES) || 0;
  const pageWaitMs = Number(process.env.LIST_FEED_PAGE_WAIT_MS) || cfg.pageWaitMs || 9000;
  const delayMin = Number(process.env.LIST_FEED_PAGE_DELAY_MIN_MS) || 8000;
  const delayMax = Number(process.env.LIST_FEED_PAGE_DELAY_MAX_MS) || 15000;

  console.log(`[list-feed] CDP target: ${host}:${port}`);
  console.log(`[list-feed] URL: ${cfg.url}`);
  if (fixedPages) {
    console.log(`[list-feed] Mode: fixed ${fixedPages} pages (LIST_FEED_PAGES override), ${delayMin}-${delayMax}ms between`);
  } else {
    console.log(`[list-feed] Mode: dynamic cursor-paginate (cutoff=${cutoffHours}h, hardLimit=${maxPagesHardLimit} pages, ${delayMin}-${delayMax}ms between)`);
  }

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

    // Capture the SPA's first ListLatestTweetsTimeline request — we need its
    // headers (Bearer, x-csrf-token, etc) and URL params (queryId, features).
    const captured = [];
    const reqMeta = new Map();
    cdp.on('Network.requestWillBeSent', params => {
      const url = params?.request?.url || '';
      if (url.includes('ListLatestTweetsTimeline')) {
        reqMeta.set(params.requestId, params.request);
      }
    });
    cdp.on('Network.responseReceived', params => {
      const url = params?.response?.url || '';
      if (url.includes('ListLatestTweetsTimeline')) {
        captured.push({
          requestId: params.requestId,
          url,
          status: params.response.status,
          requestHeaders: reqMeta.get(params.requestId)?.headers || {},
        });
      }
    });

    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    try {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator, 'webdriver', {get: () => undefined});`
      });
    } catch {}

    console.log(`[list-feed] Navigating to list (page 1)...`);
    await cdp.send('Page.navigate', { url: cfg.url }, 15000);
    await sleep(pageWaitMs);

    if (captured.length === 0) {
      console.warn('[list-feed] 0 ListLatestTweetsTimeline responses captured — cookie expired or list URL wrong?');
      return [];
    }

    const first = captured[0];
    const queryIdMatch = first.url.match(/graphql\/([^/]+)\/ListLatestTweetsTimeline/);
    const queryId = queryIdMatch ? queryIdMatch[1] : null;
    const u = new URL(first.url);
    const variables = JSON.parse(u.searchParams.get('variables'));
    const features = JSON.parse(u.searchParams.get('features'));
    const bearerHeader = first.requestHeaders['authorization'] || '';

    if (!queryId || !bearerHeader) {
      console.warn(`[list-feed] missing queryId or bearer (queryId=${queryId}, bearer=${bearerHeader.length}b)`);
      return [];
    }

    // Parse first page
    const allTweets = new Map();
    function ingest(json, label) {
      const { tweets, nextCursor } = parseTimelineResponse(json);
      let added = 0;
      for (const t of tweets) {
        const key = t.tweetUrl || t._id || `${t.author}|${t.datetime}|${t.text.substring(0, 50)}`;
        if (!allTweets.has(key)) {
          allTweets.set(key, t);
          added++;
        }
      }
      console.log(`[list-feed]   ${label}: parsed=${tweets.length}, new=${added}, total=${allTweets.size}, nextCursor=${nextCursor ? 'OK' : 'NULL'}`);
      return nextCursor;
    }

    // Track oldest tweet datetime seen so far → used to decide when we've
    // covered the cutoff window.
    let oldestSeenMs = Infinity;
    function updateOldest(json) {
      try {
        const { tweets } = parseTimelineResponse(json);
        for (const t of tweets) {
          if (t.datetime) {
            const ts = Date.parse(t.datetime);
            if (!Number.isNaN(ts) && ts < oldestSeenMs) oldestSeenMs = ts;
          }
        }
      } catch {}
    }

    let cursor = null;
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: first.requestId }, 12000);
      const json = JSON.parse(body.body);
      cursor = ingest(json, 'page 1');
      updateOldest(json);
    } catch (e) {
      console.warn(`[list-feed] failed to parse page 1: ${e.message}`);
    }

    // Decide stop condition for each iteration:
    // - If LIST_FEED_PAGES set → stop at fixedPages
    // - Otherwise → stop when oldest seen <= cutoff OR hardLimit reached
    const limit = fixedPages || maxPagesHardLimit;
    // Cursor-paginate via page-context fetch
    for (let p = 2; p <= limit; p++) {
      if (!cursor) {
        console.log(`[list-feed] no cursor for page ${p}, stopping early`);
        break;
      }
      // Dynamic stop: have we covered the cutoff window already?
      if (!fixedPages && oldestSeenMs <= cutoffMs) {
        const oldestStr = new Date(oldestSeenMs).toISOString();
        const cutoffStr = new Date(cutoffMs).toISOString();
        console.log(`[list-feed] covered cutoff (oldest=${oldestStr} <= cutoff=${cutoffStr}), stopping at page ${p - 1}`);
        break;
      }
      const delay = rand(delayMin, delayMax);
      console.log(`[list-feed] sleeping ${(delay / 1000).toFixed(1)}s before page ${p}/${limit}...`);
      await sleep(delay);

      const vars = { ...variables, cursor };
      const url = `https://x.com/i/api/graphql/${queryId}/ListLatestTweetsTimeline` +
        `?variables=${encodeURIComponent(JSON.stringify(vars))}` +
        `&features=${encodeURIComponent(JSON.stringify(features))}`;

      // Run fetch *inside* the page so the browser auto-attaches all real
      // cookies, TLS fingerprint, sec-ch-ua-*, accept-encoding, etc. We
      // explicitly set the X-required headers (csrf, bearer, auth-type).
      const expr = `
        (async () => {
          try {
            const ct0Match = document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/);
            const ct0 = ct0Match ? ct0Match[1] : '';
            const headers = {
              'accept': '*/*',
              'accept-language': 'zh-cn',
              'authorization': ${JSON.stringify(bearerHeader)},
              'content-type': 'application/json',
              'x-csrf-token': ct0,
              'x-twitter-active-user': 'yes',
              'x-twitter-auth-type': 'OAuth2Session',
              'x-twitter-client-language': 'zh-cn',
            };
            const r = await fetch(${JSON.stringify(url)}, {
              method: 'GET',
              credentials: 'include',
              headers,
            });
            const text = await r.text();
            return { status: r.status, bodyLen: text.length, body: text };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;
      let res;
      try {
        const ev = await cdp.send('Runtime.evaluate', {
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
        }, 25000);
        res = ev.result?.value;
      } catch (e) {
        console.warn(`[list-feed] page ${p} CDP eval error: ${e.message}`);
        break;
      }
      if (!res || res.error) {
        console.warn(`[list-feed] page ${p} fetch error: ${res?.error || 'no result'}`);
        break;
      }
      if (res.status !== 200) {
        console.warn(`[list-feed] page ${p} HTTP ${res.status}, body sample: ${(res.body || '').slice(0, 300)}`);
        break;
      }

      let json;
      try {
        json = JSON.parse(res.body);
      } catch (e) {
        console.warn(`[list-feed] page ${p} JSON parse: ${e.message}`);
        break;
      }
      const next = ingest(json, `page ${p}`);
      updateOldest(json);
      if (next === cursor) {
        console.log('[list-feed] cursor unchanged → end of feed');
        break;
      }
      cursor = next;
    }
    if (!fixedPages && oldestSeenMs > cutoffMs) {
      console.warn(`[list-feed] WARN: hit hardLimit (${maxPagesHardLimit} pages) before reaching cutoff (${cutoffHours}h). Tail may be missing.`);
    }

    const out = Array.from(allTweets.values()).map(t => {
      // strip internal _id
      const { _id, ...rest } = t;
      return rest;
    });
    console.log(`[list-feed] Extracted tweets: ${out.length}`);
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
