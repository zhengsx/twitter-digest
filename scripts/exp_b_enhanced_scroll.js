// Experiment B: enhanced scroll - longer delays, mouse-wheel events, 
// real-looking scroll patterns. See if X triggers more graphql calls.
import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';

const HOST = '127.0.0.1', PORT = 18800;
const LIST_URL = 'https://x.com/i/lists/2019940021005058347';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }

async function createFresh() {
  const r = await fetch(`http://${HOST}:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const t = await r.json(); return { wsUrl: t.webSocketDebuggerUrl, targetId: t.id };
}
async function closeTarget(id) { try { await fetch(`http://${HOST}:${PORT}/json/close/${id}`); } catch {} }

console.log('[exp_b] creating fresh target...');
const { wsUrl, targetId } = await createFresh();
console.log('[exp_b] target', targetId, 'wsUrl', wsUrl.slice(0,80));
const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
await new Promise((r,j)=>{ ws.once('open', () => { console.log('[exp_b] ws open'); r(); }); ws.once('error', e => { console.log('[exp_b] ws err', e.message); j(e); }); });

let mid = 0; const pending = new Map();
const captured = [];
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    return;
  }
  if (m.method === 'Network.responseReceived') {
    const url = m.params.response?.url || '';
    if (url.includes('ListLatestTweetsTimeline') || url.includes('Timeline')) {
      captured.push({ requestId: m.params.requestId, url, status: m.params.response.status, ts: Date.now() });
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

const t0 = Date.now();
console.log('[exp_b] navigate...');
await call('Page.navigate', { url: LIST_URL });
await sleep(8000);
console.log(`[exp_b] after navigate, captured: ${captured.length}`);

// Scroll strategies — try many variants
async function scrollStep(amount, mouseWheel) {
  if (mouseWheel) {
    // Use Input.dispatchMouseEvent for wheel
    await call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600, y: 400,
      deltaX: 0, deltaY: amount,
    }).catch(() => {});
  } else {
    await call('Runtime.evaluate', {
      expression: `
        (() => {
          window.scrollBy({top: ${amount}, behavior: 'auto'});
          window.dispatchEvent(new Event('scroll', {bubbles: true}));
        })()
      `
    }).catch(() => {});
  }
}

const scrolls = 12;
let lastCaptured = captured.length;
console.log(`[exp_b] starting ${scrolls} enhanced scrolls...`);
for (let i = 0; i < scrolls; i++) {
  // Alternate between mouse wheel and scrollBy
  const useMouse = i % 2 === 0;
  await scrollStep(rand(800, 1500), useMouse);
  await sleep(rand(500, 1500));
  // Bigger scroll
  await scrollStep(rand(2000, 3500), !useMouse);
  await sleep(rand(2500, 5000));

  if (captured.length > lastCaptured) {
    console.log(`[exp_b]   step ${i+1}: graphql calls now ${captured.length} (+${captured.length - lastCaptured})`);
    lastCaptured = captured.length;
  }

  if ((i + 1) % 5 === 0) {
    const ev = await call('Runtime.evaluate', {
      expression: '({y: window.scrollY, h: document.documentElement.scrollHeight, art: document.querySelectorAll(\'article[data-testid="tweet"]\').length})',
      returnByValue: true,
    }, 10000);
    console.log(`[exp_b]   step ${i+1}: scroll=${JSON.stringify(ev.result?.value)}, captured=${captured.length}`);
  }
}

console.log(`\n[exp_b] total Timeline-ish responses captured: ${captured.length}`);
const allTweets = new Map();
let pageNum = 0;
for (const c of captured) {
  pageNum++;
  if (!c.url.includes('ListLatestTweetsTimeline')) {
    console.log(`[exp_b] skip non-list: ${c.url.slice(0, 100)}`);
    continue;
  }
  try {
    const body = await call('Network.getResponseBody', { requestId: c.requestId }, 10000);
    const j = JSON.parse(body.body);
    const ins = j?.data?.list?.tweets_timeline?.timeline?.instructions || [];
    let added = 0;
    for (const i of ins) {
      for (const e of (i.entries || [])) {
        const r = e?.content?.itemContent?.tweet_results?.result;
        if (!r) continue;
        const tw = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
        const id = tw?.legacy?.id_str || tw?.rest_id;
        if (id && !allTweets.has(id)) { allTweets.set(id, true); added++; }
      }
    }
    console.log(`[exp_b]   page ${pageNum}: body=${(body.body.length/1024).toFixed(0)}K, added=${added}, total=${allTweets.size}`);
  } catch (e) {
    console.log(`[exp_b]   page ${pageNum}: err ${e.message}`);
  }
}

const total = Date.now() - t0;
console.log(`\n[exp_b] SUMMARY: tweets=${allTweets.size}, graphql_calls=${captured.length}, elapsed=${(total/1000).toFixed(1)}s`);

fs.writeFileSync('tmp/exp_b_results.json', JSON.stringify({
  totalUnique: allTweets.size,
  graphqlCalls: captured.length,
  capturedUrls: captured.map(c => ({ url: c.url.slice(0, 200), status: c.status })),
  elapsedMs: total,
  timestamp: new Date().toISOString(),
}, null, 2));

await closeTarget(targetId);
ws.close();
console.log('[exp_b] done');
