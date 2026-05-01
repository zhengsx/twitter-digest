// Step 2: Probe first-page graphql response and extract cursor structure.
// Saves full response to tmp/cursor_probe_response.json
import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';

const HOST = '127.0.0.1';
const PORT = 18800;
const LIST_URL = 'https://x.com/i/lists/2019940021005058347';

async function createFresh() {
  const r = await fetch(`http://${HOST}:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const t = await r.json();
  return { wsUrl: t.webSocketDebuggerUrl, targetId: t.id };
}

async function closeTarget(id) {
  try { await fetch(`http://${HOST}:${PORT}/json/close/${id}`); } catch {}
}

const { wsUrl, targetId } = await createFresh();
const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
await new Promise((r,j) => { ws.once('open', r); ws.once('error', j); });

let mid = 0; const pending = new Map();
const captured = [];
const reqMeta = new Map(); // requestId -> { url, request }

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const url = m.params.request?.url || '';
    if (url.includes('ListLatestTweetsTimeline')) {
      reqMeta.set(m.params.requestId, { url, request: m.params.request });
    }
  }
  if (m.method === 'Network.responseReceived') {
    const url = m.params.response?.url || '';
    if (url.includes('ListLatestTweetsTimeline')) {
      captured.push({
        requestId: m.params.requestId,
        url,
        status: m.params.response.status,
        headers: m.params.response.headers,
        requestHeaders: reqMeta.get(m.params.requestId)?.request?.headers || {},
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

console.log('[probe] navigate to list...');
await call('Page.navigate', { url: LIST_URL });
await new Promise(r => setTimeout(r, 9000));

console.log(`[probe] captured ${captured.length} ListLatestTweetsTimeline response(s)`);
if (captured.length === 0) {
  console.error('[probe] No graphql captured. Cookie expired? Check page.');
  await closeTarget(targetId);
  ws.close();
  process.exit(1);
}

const first = captured[0];
console.log(`[probe] first response: status=${first.status}, url=${first.url.slice(0, 120)}...`);

// fetch body
const body = await call('Network.getResponseBody', { requestId: first.requestId }, 10000);
const json = JSON.parse(body.body);
fs.writeFileSync('tmp/cursor_probe_response.json', JSON.stringify(json, null, 2));
console.log('[probe] saved full response → tmp/cursor_probe_response.json');

// Walk timeline
const instructions = json?.data?.list?.tweets_timeline?.timeline?.instructions || [];
console.log(`[probe] instructions count: ${instructions.length}`);

let tweetCount = 0;
let bottomCursor = null;
let topCursor = null;
const sampleEntries = [];

for (const ins of instructions) {
  const entries = ins.entries || (ins.entry ? [ins.entry] : []);
  for (const e of entries) {
    const r = e?.content?.itemContent?.tweet_results?.result;
    if (r) tweetCount++;
    const cType = e?.content?.cursorType;
    if (cType === 'Bottom') bottomCursor = e.content.value;
    if (cType === 'Top') topCursor = e.content.value;
    if (sampleEntries.length < 3) {
      sampleEntries.push({
        entryId: e.entryId,
        sortIndex: e.sortIndex,
        contentType: e?.content?.entryType || e?.content?.itemType,
        cursorType: cType || null,
      });
    }
  }
}

console.log(`[probe] tweets in first page: ${tweetCount}`);
console.log(`[probe] bottomCursor: ${bottomCursor ? bottomCursor.slice(0, 60) + '...' : 'NULL'}`);
console.log(`[probe] topCursor: ${topCursor ? topCursor.slice(0, 60) + '...' : 'NULL'}`);
console.log('[probe] sample entries:', JSON.stringify(sampleEntries, null, 2));

// Extract URL params for replay
const u = new URL(first.url);
const variables = u.searchParams.get('variables');
const features = u.searchParams.get('features');
const fieldToggles = u.searchParams.get('fieldToggles');
const queryIdMatch = first.url.match(/graphql\/([^/]+)\/ListLatestTweetsTimeline/);
const queryId = queryIdMatch ? queryIdMatch[1] : null;

console.log(`[probe] queryId: ${queryId}`);
console.log(`[probe] variables (first 200 chars):`, variables ? variables.slice(0, 200) : null);
console.log(`[probe] features (first 200 chars):`, features ? features.slice(0, 200) : null);

// Save request metadata
fs.writeFileSync('tmp/cursor_probe_meta.json', JSON.stringify({
  queryId,
  url: first.url,
  variables: variables ? JSON.parse(variables) : null,
  features: features ? JSON.parse(features) : null,
  fieldToggles: fieldToggles ? JSON.parse(fieldToggles) : null,
  status: first.status,
  responseHeaders: first.headers,
  requestHeaders: first.requestHeaders,
  bottomCursor,
  topCursor,
  tweetCount,
}, null, 2));
console.log('[probe] meta → tmp/cursor_probe_meta.json');

await closeTarget(targetId);
ws.close();
console.log('[probe] done');
