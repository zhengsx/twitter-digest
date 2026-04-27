import WebSocket from 'ws';
import fetch from 'node-fetch';

const tabs = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const target = tabs.find(t => t.url && t.url.includes('x.com'));
console.log('Tab:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10000 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let mid = 0; const pending = new Map();
const timelineResponses = [];
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    return;
  }
  // capture network events
  if (m.method === 'Network.responseReceived') {
    const url = m.params.response?.url || '';
    if (url.includes('TimelineList') || url.includes('TimelineLatest') || url.includes('graphql')) {
      timelineResponses.push({ requestId: m.params.requestId, url: url.substring(0, 150), status: m.params.response.status });
    }
  }
});
function call(method, params = {}, t=20000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout '+method)); } }, t);
  });
}
await call('Network.enable');
await call('Runtime.enable');
await call('Page.enable');

// Reload list
await call('Page.navigate', { url: 'https://x.com/i/lists/2019940021005058347' });
await new Promise(r => setTimeout(r, 6000));

// scroll
for (let i = 0; i < 8; i++) {
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 2500)' });
  await new Promise(r => setTimeout(r, 3000));
}

console.log(`\n${timelineResponses.length} graphql/timeline responses captured`);
for (const t of timelineResponses) {
  console.log(`  ${t.status} | ${t.url}`);
}

// Get response bodies for the most relevant ones
console.log('\n--- Sampling response bodies ---');
const listResponses = timelineResponses.filter(t => t.url.includes('ListLatest') || t.url.includes('TimelineList'));
const sample = listResponses.slice(0, 3);
for (const t of sample) {
  try {
    const body = await call('Network.getResponseBody', { requestId: t.requestId }, 8000);
    const txt = body.body || '';
    // count "tweet_results" entries roughly
    const tweetMatches = (txt.match(/"tweet_results"/g) || []).length;
    const errors = (txt.match(/"errors"/g) || []).length;
    const code = (txt.match(/"code":\s*\d+/g) || []).slice(0,3);
    console.log(`URL: ${t.url}`);
    console.log(`  body length: ${txt.length}, tweet_results: ${tweetMatches}, errors_blocks: ${errors}, codes: ${code.join('|')}`);
    console.log(`  preview: ${txt.substring(0, 400)}`);
    console.log('');
  } catch (e) {
    console.log(`Failed to fetch body for ${t.requestId}: ${e.message}`);
  }
}
ws.close();
