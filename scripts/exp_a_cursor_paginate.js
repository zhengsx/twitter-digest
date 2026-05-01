// Experiment A: cursor-based pagination via page-context fetch.
// Strategy:
//  1) navigate to list URL (lets SPA set CSRF/cookies/Bearer in network state).
//  2) capture first graphql response to get queryId/variables/features/cursor.
//  3) issue subsequent page fetches via Runtime.evaluate so requests originate
//     from the *real* page context (referer, csrf, bearer, cookies all
//     auto-attached by the browser — no manual header forgery).
//  4) random 8-15s delay between pages, hard cap at 4 pages total.
//
// Output: tmp/exp_a_results.json + console summary.
import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';

const HOST = '127.0.0.1', PORT = 18800;
const LIST_URL = 'https://x.com/i/lists/2019940021005058347';
const MAX_PAGES = 4;

function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createFresh() {
  const r = await fetch(`http://${HOST}:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const t = await r.json();
  return { wsUrl: t.webSocketDebuggerUrl, targetId: t.id };
}
async function closeTarget(id) { try { await fetch(`http://${HOST}:${PORT}/json/close/${id}`); } catch {} }

const { wsUrl, targetId } = await createFresh();
const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
await new Promise((r,j)=>{ ws.once('open', r); ws.once('error', j); });

let mid = 0; const pending = new Map();
const captured = []; const reqMeta = new Map();
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const url = m.params.request?.url || '';
    if (url.includes('ListLatestTweetsTimeline')) reqMeta.set(m.params.requestId, m.params.request);
  }
  if (m.method === 'Network.responseReceived') {
    const url = m.params.response?.url || '';
    if (url.includes('ListLatestTweetsTimeline')) {
      captured.push({
        requestId: m.params.requestId,
        url,
        status: m.params.response.status,
        responseHeaders: m.params.response.headers,
        ts: Date.now(),
      });
    }
  }
});
function call(method, params = {}, t = 20000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout '+method)); } }, t);
  });
}

await call('Network.enable');
await call('Page.enable');
await call('Runtime.enable');

console.log('[exp_a] navigate...');
const t0 = Date.now();
await call('Page.navigate', { url: LIST_URL });
await sleep(9000);

if (captured.length === 0) {
  console.error('[exp_a] no graphql captured on first page'); ws.close(); await closeTarget(targetId); process.exit(1);
}

// Extract page-1 metadata
const first = captured[0];
const u = new URL(first.url);
const queryId = first.url.match(/graphql\/([^/]+)\/ListLatestTweetsTimeline/)[1];
const variables = JSON.parse(u.searchParams.get('variables'));
const features = JSON.parse(u.searchParams.get('features'));

// pull body to extract cursor
async function pullCursor(requestId) {
  const body = await call('Network.getResponseBody', { requestId }, 12000);
  const json = JSON.parse(body.body);
  let cursor = null;
  let tweetCount = 0;
  const ins = json?.data?.list?.tweets_timeline?.timeline?.instructions || [];
  for (const i of ins) {
    for (const e of (i.entries || [])) {
      if (e?.content?.cursorType === 'Bottom') cursor = e.content.value;
      if (e?.content?.itemContent?.tweet_results?.result) tweetCount++;
    }
  }
  return { cursor, tweetCount, json, bodyLen: body.body.length };
}

const page1 = await pullCursor(first.requestId);
console.log(`[exp_a] page 1: tweets=${page1.tweetCount}, body=${(page1.bodyLen/1024).toFixed(0)}K, cursor=${page1.cursor ? 'OK' : 'NULL'}, status=${first.status}`);

// Inspect rate-limit headers on page1
const rlHeaders = {};
for (const k of Object.keys(first.responseHeaders || {})) {
  if (k.toLowerCase().includes('rate')) rlHeaders[k] = first.responseHeaders[k];
}
console.log('[exp_a] page1 rate-limit headers:', JSON.stringify(rlHeaders));

// === Pagination via page-context fetch ===
async function fetchPage(cursor, pageNum) {
  const vars = { ...variables, cursor };
  const url = `https://x.com/i/api/graphql/${queryId}/ListLatestTweetsTimeline` +
    `?variables=${encodeURIComponent(JSON.stringify(vars))}` +
    `&features=${encodeURIComponent(JSON.stringify(features))}`;

  // run fetch inside the page (uses real browser cookies, csrf, bearer, etc)
  const expr = `
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': '*/*',
            'content-type': 'application/json',
          },
        });
        const headers = {};
        r.headers.forEach((v,k)=>{ headers[k] = v; });
        const text = await r.text();
        return { status: r.status, headers, bodyLen: text.length, body: text };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `;
  const ev = await call('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  }, 20000);
  return ev.result?.value;
}

const pages = [
  { pageNum: 1, status: first.status, tweetCount: page1.tweetCount, bodyLen: page1.bodyLen, headers: first.responseHeaders, cursor: page1.cursor, fromBrowserNav: true },
];

const allTweets = new Map();
function ingestJson(json, pageLabel) {
  const ins = json?.data?.list?.tweets_timeline?.timeline?.instructions || [];
  let added = 0;
  let nextCursor = null;
  for (const i of ins) {
    for (const e of (i.entries || [])) {
      if (e?.content?.cursorType === 'Bottom') nextCursor = e.content.value;
      const r = e?.content?.itemContent?.tweet_results?.result;
      if (!r) continue;
      const tw = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
      const id = tw?.legacy?.id_str || tw?.rest_id;
      if (id && !allTweets.has(id)) { allTweets.set(id, true); added++; }
    }
  }
  return { added, nextCursor };
}
ingestJson(page1.json, 'p1');

let cursor = page1.cursor;
for (let p = 2; p <= MAX_PAGES; p++) {
  if (!cursor) { console.log(`[exp_a] no cursor for page ${p}, stopping`); break; }
  const delay = rand(8000, 15000);
  console.log(`[exp_a] sleeping ${(delay/1000).toFixed(1)}s before page ${p}...`);
  await sleep(delay);

  const tStart = Date.now();
  const res = await fetchPage(cursor, p);
  const elapsed = Date.now() - tStart;
  if (res?.error) { console.error(`[exp_a] page ${p} error: ${res.error}`); break; }

  const rlH = {};
  for (const k of Object.keys(res.headers || {})) {
    if (k.toLowerCase().includes('rate') || k.toLowerCase().includes('retry')) rlH[k] = res.headers[k];
  }
  console.log(`[exp_a] page ${p}: status=${res.status}, body=${(res.bodyLen/1024).toFixed(0)}K, elapsed=${elapsed}ms, ratelimit=${JSON.stringify(rlH)}`);

  if (res.status !== 200) {
    console.warn(`[exp_a] non-200 status ${res.status}, body sample: ${res.body.slice(0, 400)}`);
    pages.push({ pageNum: p, status: res.status, bodyLen: res.bodyLen, headers: res.headers, body: res.body.slice(0, 1000) });
    break;
  }

  let json;
  try { json = JSON.parse(res.body); } catch (e) { console.error(`[exp_a] page ${p} JSON parse: ${e.message}`); break; }
  const { added, nextCursor } = ingestJson(json, `p${p}`);
  console.log(`[exp_a]   parsed: added=${added}, total_unique=${allTweets.size}, nextCursor=${nextCursor ? 'OK' : 'NULL'}`);
  pages.push({ pageNum: p, status: res.status, bodyLen: res.bodyLen, added, totalUnique: allTweets.size, headers: rlH, cursorPresent: !!nextCursor });

  if (nextCursor === cursor) { console.log('[exp_a] cursor unchanged → end of feed'); break; }
  cursor = nextCursor;
}

const totalElapsed = Date.now() - t0;
console.log(`\n[exp_a] === SUMMARY ===`);
console.log(`[exp_a] total unique tweets: ${allTweets.size}`);
console.log(`[exp_a] total pages fetched: ${pages.length}`);
console.log(`[exp_a] total elapsed: ${(totalElapsed/1000).toFixed(1)}s`);
console.log(`[exp_a] graphql calls captured at network layer: ${captured.length}`);

fs.writeFileSync('tmp/exp_a_results.json', JSON.stringify({
  totalUnique: allTweets.size,
  pages,
  totalElapsedMs: totalElapsed,
  capturedNetworkResponses: captured.length,
  timestamp: new Date().toISOString(),
}, null, 2));
console.log('[exp_a] saved → tmp/exp_a_results.json');

await closeTarget(targetId);
ws.close();
console.log('[exp_a] done');
