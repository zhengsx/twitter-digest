import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';

const tabs = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const target = tabs.find(t => t.url && t.url.includes('x.com'));
const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10000 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let mid = 0; const pending = new Map();
const captured = [];
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    return;
  }
  if (m.method === 'Network.responseReceived' && (m.params.response?.url || '').includes('ListLatestTweetsTimeline')) {
    captured.push({ requestId: m.params.requestId });
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
await call('Page.enable');
await call('Page.navigate', { url: 'https://x.com/i/lists/2019940021005058347' });
await new Promise(r => setTimeout(r, 7000));

const c = captured[0];
const body = await call('Network.getResponseBody', { requestId: c.requestId });
const data = JSON.parse(body.body);
const entries = data.data.list.tweets_timeline.timeline.instructions.flatMap(i => i.entries || []);
const tweetEntry = entries.find(e => e?.content?.itemContent?.tweet_results?.result);
fs.writeFileSync('/tmp/one_tweet_entry.json', JSON.stringify(tweetEntry, null, 2));
console.log('Saved one entry to /tmp/one_tweet_entry.json');

// find user
const r = tweetEntry.content.itemContent.tweet_results.result;
console.log('Result type:', r.__typename);
console.log('Has core?', !!r.core);
if (r.core) console.log('core keys:', Object.keys(r.core));
console.log('Has user_results in core?', !!r.core?.user_results);
console.log('Has user object?', !!r.user);
const userR = r.core?.user_results?.result || r.user_results?.result || r.user;
console.log('User type:', userR?.__typename);
if (userR) {
  console.log('User keys:', Object.keys(userR));
  if (userR.legacy) console.log('legacy.screen_name:', userR.legacy.screen_name);
  if (userR.core) console.log('core:', JSON.stringify(userR.core).substring(0, 200));
}
ws.close();
