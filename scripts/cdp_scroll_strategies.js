import WebSocket from 'ws';
import fetch from 'node-fetch';

const tabs = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const target = tabs.find(t => t.url && t.url.includes('i/lists/'));
console.log('Tab:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10000 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let mid = 0;
const pending = new Map();
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message));
    else p.res(m.result);
  }
});
function call(method, params = {}, t=15000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout '+method)); } }, t);
  });
}
await call('Runtime.enable');
await call('Page.enable');
await call('Page.bringToFront');

// Scroll to top first, accumulate seen tweet IDs
await call('Runtime.evaluate', { expression: 'window.scrollTo(0, 0); window.__seenTweets = new Set();' });
await new Promise(r => setTimeout(r, 2000));

const accumulate = `
(() => {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const a of articles) {
    const time = (a.querySelector('time')||{}).getAttribute?.('datetime') || '';
    const text = (a.querySelector('[data-testid="tweetText"]')||{}).innerText?.substring(0,80) || '';
    const key = time+'|'+text;
    window.__seenTweets.add(key);
  }
  return window.__seenTweets.size;
})()
`;

console.log('--- Strategy 1: Slow scroll (500px/2s) ---');
await call('Runtime.evaluate', { expression: 'window.scrollTo(0, 0); window.__seenTweets = new Set();' });
await new Promise(r => setTimeout(r, 1500));
let lastH = 0;
for (let i = 0; i < 30; i++) {
  await call('Runtime.evaluate', { expression: accumulate, returnByValue: true });
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 500)' });
  await new Promise(r => setTimeout(r, 2000));
  if ((i+1) % 5 === 0) {
    const r = await call('Runtime.evaluate', { 
      expression: '({seen: window.__seenTweets.size, y: window.scrollY, h: document.documentElement.scrollHeight, art: document.querySelectorAll(\'article[data-testid="tweet"]\').length})',
      returnByValue: true 
    });
    console.log(`  Step ${i+1}: ${JSON.stringify(r.result.value)}`);
    if (r.result.value.h === lastH && r.result.value.y >= r.result.value.h - 1500) break;
    lastH = r.result.value.h;
  }
}
const final1 = await call('Runtime.evaluate', { expression: 'window.__seenTweets.size', returnByValue: true });
console.log('Strategy 1 total tweets:', final1.result.value);

console.log('\n--- Strategy 2: scroll to bottom and wait ---');
await call('Runtime.evaluate', { expression: 'window.scrollTo(0, 0); window.__seenTweets = new Set();' });
await new Promise(r => setTimeout(r, 1500));
for (let i = 0; i < 20; i++) {
  await call('Runtime.evaluate', { expression: accumulate, returnByValue: true });
  await call('Runtime.evaluate', { expression: 'window.scrollTo(0, document.documentElement.scrollHeight)' });
  await new Promise(r => setTimeout(r, 4000));
  if ((i+1) % 4 === 0) {
    const r = await call('Runtime.evaluate', { 
      expression: '({seen: window.__seenTweets.size, y: window.scrollY, h: document.documentElement.scrollHeight, art: document.querySelectorAll(\'article[data-testid="tweet"]\').length})',
      returnByValue: true 
    });
    console.log(`  Step ${i+1}: ${JSON.stringify(r.result.value)}`);
  }
}
const final2 = await call('Runtime.evaluate', { expression: 'window.__seenTweets.size', returnByValue: true });
console.log('Strategy 2 total tweets:', final2.result.value);

console.log('\n--- Strategy 3: Press End key ---');
await call('Runtime.evaluate', { expression: 'window.scrollTo(0, 0); window.__seenTweets = new Set();' });
await new Promise(r => setTimeout(r, 1500));
for (let i = 0; i < 20; i++) {
  await call('Runtime.evaluate', { expression: accumulate, returnByValue: true });
  // simulate End key
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await new Promise(r => setTimeout(r, 3000));
  if ((i+1) % 4 === 0) {
    const r = await call('Runtime.evaluate', { 
      expression: '({seen: window.__seenTweets.size, y: window.scrollY, h: document.documentElement.scrollHeight, art: document.querySelectorAll(\'article[data-testid="tweet"]\').length})',
      returnByValue: true 
    });
    console.log(`  Step ${i+1}: ${JSON.stringify(r.result.value)}`);
  }
}
const final3 = await call('Runtime.evaluate', { expression: 'window.__seenTweets.size', returnByValue: true });
console.log('Strategy 3 total tweets:', final3.result.value);

ws.close();
