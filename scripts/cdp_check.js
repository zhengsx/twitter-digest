import WebSocket from 'ws';
import fetch from 'node-fetch';

const tabs = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const target = tabs.find(t => t.url && t.url.includes('i/lists/'));
if (!target) { console.error('No list tab'); process.exit(1); }
console.log('Tab:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10000 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
console.log('WS connected');

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

function call(method, params = {}) {
  const id = ++mid;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout '+method)); } }, 15000);
  });
}

await call('Runtime.enable');

const probe = `
(() => {
  return JSON.stringify({
    title: document.title,
    href: location.href,
    articles: document.querySelectorAll('article[data-testid="tweet"]').length,
    cells: document.querySelectorAll('[data-testid="cellInnerDiv"]').length,
    primaryColumnH: (document.querySelector('[data-testid="primaryColumn"]')||{}).scrollHeight,
    docH: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    winH: window.innerHeight,
    bodyText: (document.body.innerText||'').substring(0, 300),
    h2: Array.from(document.querySelectorAll('h2')).slice(0,3).map(h=>h.innerText)
  });
})()
`;

let r = await call('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('--- Initial ---');
console.log(JSON.parse(r.result.value));

console.log('\nScrolling 10x with 3s gap, watching article count...');
for (let i = 0; i < 10; i++) {
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' });
  await new Promise(r => setTimeout(r, 3000));
  r = await call('Runtime.evaluate', {
    expression: '({a: document.querySelectorAll(\'article[data-testid="tweet"]\').length, y: window.scrollY, h: document.documentElement.scrollHeight})',
    returnByValue: true
  });
  console.log(`Step ${i+1}:`, r.result.value);
}

ws.close();
