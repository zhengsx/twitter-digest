// Experiment A v2: replay graphql via page-context fetch with explicit
// X-required headers. The trick: read csrf token from cookie ct0,
// re-attach Bearer + auth-type + active-user + client-language headers
// that X's own SPA sets.
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
        requestId: m.params.requestId, url,
        status: m.params.response.status,
        responseHeaders: m.params.response.headers,
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

console.log('[exp_a2] navigate...');
const t0 = Date.now();
await call('Page.navigate', { url: LIST_URL });
await sleep(9000);

if (captured.length === 0) { console.error('no graphql'); ws.close(); await closeTarget(targetId); process.exit(1); }

const first = captured[0];
const queryId = first.url.match(/graphql\/([^/]+)\/ListLatestTweetsTimeline/)[1];
const u = new URL(first.url);
const variables = JSON.parse(u.searchParams.get('variables'));
const features = JSON.parse(u.searchParams.get('features'));

// Capture exact request headers from network observation (this is what the SPA used)
const realHeaders = reqMeta.get(first.requestId)?.headers || {};
console.log('[exp_a2] real SPA headers (count):', Object.keys(realHeaders).length);
const interestingHeaders = {};
for (const [k, v] of Object.entries(realHeaders)) {
  const lk = k.toLowerCase();
  if (['authorization','x-csrf-token','x-twitter-auth-type','x-twitter-active-user','x-twitter-client-language','x-client-transaction-id','x-client-uuid','content-type','accept','accept-language'].includes(lk)) {
    interestingHeaders[lk] = v;
  }
}
console.log('[exp_a2] selected headers:', Object.keys(interestingHeaders));

const body = await call('Network.getResponseBody', { requestId: first.requestId }, 12000);
const json = JSON.parse(body.body);
const allTweets = new Map();
function ingest(j) {
  let cursor = null, added = 0;
  const ins = j?.data?.list?.tweets_timeline?.timeline?.instructions || [];
  for (const i of ins) {
    for (const e of (i.entries || [])) {
      if (e?.content?.cursorType === 'Bottom') cursor = e.content.value;
      const r = e?.content?.itemContent?.tweet_results?.result;
      if (!r) continue;
      const tw = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
      const id = tw?.legacy?.id_str || tw?.rest_id;
      if (id && !allTweets.has(id)) { allTweets.set(id, true); added++; }
    }
  }
  return { cursor, added };
}
const p1Result = ingest(json);
console.log(`[exp_a2] page 1 (browser-nav): tweets_added=${p1Result.added}, total=${allTweets.size}, cursor=${p1Result.cursor ? 'OK' : 'NULL'}`);

// Build exact-match fetch with all the SPA headers
async function fetchPage(cursor, pageNum) {
  const vars = { ...variables, cursor };
  const url = `https://x.com/i/api/graphql/${queryId}/ListLatestTweetsTimeline` +
    `?variables=${encodeURIComponent(JSON.stringify(vars))}` +
    `&features=${encodeURIComponent(JSON.stringify(features))}`;

  const expr = `
    (async () => {
      try {
        // read ct0 csrf from cookies (SPA uses this)
        const ct0Match = document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/);
        const ct0 = ct0Match ? ct0Match[1] : '';

        const headers = {
          'accept': '*/*',
          'accept-language': 'zh-cn',
          'authorization': ${JSON.stringify(interestingHeaders['authorization'] || '')},
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
        const respHeaders = {};
        r.headers.forEach((v,k)=>{ respHeaders[k] = v; });
        const text = await r.text();
        return { status: r.status, headers: respHeaders, bodyLen: text.length, body: text };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    })()
  `;
  const ev = await call('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  }, 25000);
  return ev.result?.value;
}

const pages = [{ pageNum: 1, status: 200, added: p1Result.added, totalUnique: allTweets.size, fromBrowserNav: true }];
let cursor = p1Result.cursor;

for (let p = 2; p <= MAX_PAGES; p++) {
  if (!cursor) { console.log(`[exp_a2] no cursor for page ${p}, stop`); break; }
  const delay = rand(8000, 15000);
  console.log(`[exp_a2] sleeping ${(delay/1000).toFixed(1)}s...`);
  await sleep(delay);

  const tStart = Date.now();
  const res = await fetchPage(cursor, p);
  const elapsed = Date.now() - tStart;
  if (res?.error) { console.error(`[exp_a2] page ${p} JS error: ${res.error}`); break; }

  const rlH = {};
  for (const k of Object.keys(res.headers || {})) {
    if (k.toLowerCase().includes('rate') || k.toLowerCase().includes('retry')) rlH[k] = res.headers[k];
  }
  console.log(`[exp_a2] page ${p}: status=${res.status}, body=${(res.bodyLen/1024).toFixed(0)}K, elapsed=${elapsed}ms, ratelimit=${JSON.stringify(rlH)}`);

  if (res.status !== 200) {
    console.warn(`[exp_a2] non-200 status ${res.status}, body: ${res.body.slice(0, 500)}`);
    pages.push({ pageNum: p, status: res.status, bodyLen: res.bodyLen, body: res.body.slice(0, 500), headers: rlH });
    break;
  }

  let j;
  try { j = JSON.parse(res.body); } catch(e) { console.error('parse', e.message); break; }
  const ig = ingest(j);
  console.log(`[exp_a2]   added=${ig.added}, total=${allTweets.size}, nextCursor=${ig.cursor ? 'OK' : 'NULL'}`);
  pages.push({ pageNum: p, status: res.status, bodyLen: res.bodyLen, added: ig.added, totalUnique: allTweets.size, headers: rlH });
  if (ig.cursor === cursor) { console.log('cursor unchanged → end'); break; }
  cursor = ig.cursor;
}

const total = Date.now() - t0;
console.log(`\n[exp_a2] SUMMARY: tweets=${allTweets.size}, pages=${pages.length}, elapsed=${(total/1000).toFixed(1)}s`);
fs.writeFileSync('tmp/exp_a2_results.json', JSON.stringify({
  totalUnique: allTweets.size, pages, elapsedMs: total,
  capturedNetworkResponses: captured.length,
  timestamp: new Date().toISOString(),
}, null, 2));

await closeTarget(targetId);
ws.close();
console.log('[exp_a2] done');
