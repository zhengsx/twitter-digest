import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';

const tabs = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const target = tabs.find(t => t.url && t.url.includes('x.com'));
console.log('Tab:', target.url);

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
  if (m.method === 'Network.responseReceived') {
    const url = m.params.response?.url || '';
    if (url.includes('ListLatestTweetsTimeline')) {
      captured.push({ requestId: m.params.requestId, url });
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

// Scroll 多次诱发 ListLatestTweetsTimeline 多次请求（X 用 cursor 分页）
console.log('Triggering more list requests via scroll...');
for (let i = 0; i < 10; i++) {
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
}

console.log(`Captured ${captured.length} ListLatestTweetsTimeline responses`);

const allTweets = new Map();
for (const c of captured) {
  try {
    const body = await call('Network.getResponseBody', { requestId: c.requestId }, 8000);
    const txt = body.body || '';
    const data = JSON.parse(txt);
    const entries = data?.data?.list?.tweets_timeline?.timeline?.instructions?.flatMap(i => i.entries || []) || [];
    let n = 0;
    for (const e of entries) {
      const tweet = e?.content?.itemContent?.tweet_results?.result?.legacy
                || e?.content?.itemContent?.tweet_results?.result?.tweet?.legacy;
      const user = e?.content?.itemContent?.tweet_results?.result?.core?.user_results?.result?.legacy 
                || e?.content?.itemContent?.tweet_results?.result?.tweet?.core?.user_results?.result?.legacy;
      if (tweet) {
        const id = tweet.id_str || e.entryId;
        if (!allTweets.has(id)) {
          allTweets.set(id, {
            id_str: id,
            full_text: tweet.full_text,
            created_at: tweet.created_at,
            screen_name: user?.screen_name,
            name: user?.name,
            favorite_count: tweet.favorite_count,
            retweet_count: tweet.retweet_count
          });
          n++;
        }
      }
    }
    console.log(`  ${c.url.substring(0,120)}... → ${n} new tweets`);
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }
}

console.log(`\nTotal unique tweets from API: ${allTweets.size}`);
const arr = Array.from(allTweets.values()).sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
console.log('\nFirst 5:');
for (const t of arr.slice(0,5)) {
  console.log(`  @${t.screen_name} | ${t.created_at} | ${(t.full_text||'').substring(0,80)}`);
}
console.log('\nLast 3:');
for (const t of arr.slice(-3)) {
  console.log(`  @${t.screen_name} | ${t.created_at} | ${(t.full_text||'').substring(0,80)}`);
}

fs.writeFileSync('/tmp/list_api_tweets.json', JSON.stringify(arr, null, 2));
console.log('\nSaved to /tmp/list_api_tweets.json');
ws.close();
