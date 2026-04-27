import WebSocket from 'ws';
import fetch from 'node-fetch';

const tabs = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const target = tabs.find(t => t.url && t.url.includes('x.com'));
console.log('Tab:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10000 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let mid = 0; const pending = new Map();
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
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
await call('Runtime.enable');
await call('Page.enable');

// Probe automation signals
const probe = `
JSON.stringify({
  webdriver: navigator.webdriver,
  ua: navigator.userAgent,
  languages: navigator.languages,
  platform: navigator.platform,
  plugins: navigator.plugins.length,
  cdpRuntime: !!window.cdc_adoQpoasnfa76pfcZLmcfl_Array,
  hasChrome: !!window.chrome,
  permsQuery: typeof navigator.permissions?.query
})
`;
const r = await call('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('Automation signals:', JSON.parse(r.result.value));

// Patch and reload
console.log('\n--- Patch navigator.webdriver, reload list ---');
await call('Page.addScriptToEvaluateOnNewDocument', { 
  source: `
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
  `
});
await call('Page.navigate', { url: 'https://x.com/i/lists/2019940021005058347' });
await new Promise(r => setTimeout(r, 8000));

const r2 = await call('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('After patch:', JSON.parse(r2.result.value));

const ar1 = await call('Runtime.evaluate', { expression: 'document.querySelectorAll(\'article[data-testid="tweet"]\').length', returnByValue: true });
console.log('Initial articles:', ar1.result.value);

for (let i = 0; i < 15; i++) {
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 2000)' });
  await new Promise(r => setTimeout(r, 2500));
  if ((i+1)%5===0) {
    const a = await call('Runtime.evaluate', { 
      expression: '({art: document.querySelectorAll(\'article[data-testid="tweet"]\').length, y: window.scrollY, h: document.documentElement.scrollHeight})',
      returnByValue: true 
    });
    console.log(`Step ${i+1}:`, a.result.value);
  }
}
ws.close();
