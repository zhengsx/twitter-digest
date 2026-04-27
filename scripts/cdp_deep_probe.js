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
function call(method, params = {}) {
  const id = ++mid;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout '+method)); } }, 15000);
  });
}
await call('Runtime.enable');

// First scroll back to top
await call('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });
await new Promise(r => setTimeout(r, 2000));

// Probe deeply: list timeline structure, errors, retry buttons
const probe = `
(() => {
  const o = {};
  o.title = document.title;
  o.href = location.href;
  o.articles = document.querySelectorAll('article[data-testid="tweet"]').length;
  o.allArticles = document.querySelectorAll('article').length;
  o.cells = document.querySelectorAll('[data-testid="cellInnerDiv"]').length;
  
  // Check for "Show more posts" / "查看新帖子" 
  const newPostsBtn = document.querySelector('[data-testid="pillLabel"]') || document.querySelector('[role="button"][data-testid="pillButton"]');
  o.newPostsBtn = newPostsBtn ? newPostsBtn.outerHTML.substring(0, 300) : null;

  // Check timeline element
  const timeline = document.querySelector('[aria-label*="timeline"], [aria-label*="Timeline"], section[role="region"]');
  o.timeline = timeline ? {
    tag: timeline.tagName,
    children: timeline.children.length,
    h: timeline.scrollHeight,
    text: (timeline.innerText||'').substring(0, 500)
  } : 'NOT_FOUND';
  
  // Check for error messages
  const errorEls = document.querySelectorAll('[data-testid="error-detail"], [role="alert"]');
  o.errors = Array.from(errorEls).map(e => e.innerText).slice(0, 5);
  
  // Check "retry" or "试试" buttons
  const retryBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(b => /retry|try again|重试|再试/i.test(b.innerText || ''))
    .map(b => b.innerText);
  o.retryBtns = retryBtns;
  
  // Sample first 3 articles to see what we got
  const arts = document.querySelectorAll('article[data-testid="tweet"]');
  o.sampleArticles = Array.from(arts).slice(0, 3).map(a => ({
    text: (a.querySelector('[data-testid="tweetText"]')||{}).innerText?.substring(0,100),
    time: (a.querySelector('time')||{}).getAttribute?.('datetime')
  }));
  
  // What's at viewport bottom now? - last cellInnerDiv
  const cellsArr = Array.from(document.querySelectorAll('[data-testid="cellInnerDiv"]'));
  o.lastCells = cellsArr.slice(-3).map(c => (c.innerText||'').substring(0, 200));
  
  return JSON.stringify(o);
})()
`;
const r = await call('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('--- Probe result ---');
console.log(JSON.stringify(JSON.parse(r.result.value), null, 2));

// Try clicking "show new posts" if exists
console.log('\n--- Try clicking pillButton ---');
const clickResult = await call('Runtime.evaluate', { 
  expression: `(() => {
    const btn = document.querySelector('[data-testid="pillButton"]') || document.querySelector('[data-testid="pillLabel"]');
    if (btn) { btn.click(); return 'clicked'; }
    return 'no pill button';
  })()`,
  returnByValue: true
});
console.log('Click:', clickResult.result.value);

await new Promise(r => setTimeout(r, 3000));
const r2 = await call('Runtime.evaluate', { 
  expression: 'document.querySelectorAll(\'article[data-testid="tweet"]\').length',
  returnByValue: true 
});
console.log('Articles after pill click:', r2.result.value);

ws.close();
