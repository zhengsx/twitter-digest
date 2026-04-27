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
await call('Page.enable');

// First reload - capture initial
console.log('Reload 1...');
await call('Page.navigate', { url: 'https://x.com/i/lists/2019940021005058347' });
await new Promise(r => setTimeout(r, 8000));

// Try to keep scrolling AND give time for React to pick up
for (let i = 0; i < 30; i++) {
  // Use both scrollTo and PageDown trick
  await call('Runtime.evaluate', { expression: `
    window.scrollTo({top: window.scrollY + 800, behavior: 'auto'});
    // Also dispatch a scroll event
    window.dispatchEvent(new Event('scroll', {bubbles: true}));
  ` }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
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
      const r = e?.content?.itemContent?.tweet_results?.result;
      const tweet = r?.legacy || r?.tweet?.legacy;
      const user = r?.core?.user_results?.result?.legacy || r?.tweet?.core?.user_results?.result?.legacy;
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
            retweet_count: tweet.retweet_count,
            url: `https://x.com/${user?.screen_name}/status/${id}`
          });
          n++;
        }
      }
    }
    console.log(`  body=${(txt.length/1024).toFixed(0)}K, entries=${entries.length}, new=${n}`);
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }
}

console.log(`\nTotal unique tweets: ${allTweets.size}`);
const arr = Array.from(allTweets.values()).sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
console.log('First 5:');
for (const t of arr.slice(0,5)) {
  console.log(`  @${t.screen_name} | ${t.created_at} | ${(t.full_text||'').substring(0,80)}`);
}
fs.writeFileSync('/tmp/list_api_tweets.json', JSON.stringify(arr, null, 2));
console.log('\nSaved to /tmp/list_api_tweets.json');
ws.close();
