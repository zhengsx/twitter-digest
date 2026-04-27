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

// Check current cookie - sniff for guest-id, kdt, auth_token
const cookieR = await call('Network.getCookies', { urls: ['https://x.com'] }, 5000).catch(e => ({error: e.message}));
if (cookieR.error) {
  // Try via Runtime
  const r = await call('Runtime.evaluate', { 
    expression: 'document.cookie.split(";").map(s=>s.trim().split("=")[0]).join(",")',
    returnByValue: true 
  });
  console.log('Cookies (names from JS):', r.result.value);
} else {
  const names = cookieR.cookies.map(c => c.name);
  console.log('Cookies (names):', names.join(','));
  console.log('Has auth_token:', names.includes('auth_token'));
  console.log('Has ct0:', names.includes('ct0'));
  console.log('Has twid:', names.includes('twid'));
}

// Now browse to home timeline to compare
console.log('\n--- Navigate to /home ---');
await call('Page.navigate', { url: 'https://x.com/home' });
await new Promise(r => setTimeout(r, 6000));
const homeR = await call('Runtime.evaluate', { 
  expression: '({title: document.title, href: location.href, articles: document.querySelectorAll(\'article[data-testid="tweet"]\').length})',
  returnByValue: true 
});
console.log('Home:', homeR.result.value);

// Scroll home a bit
for (let i = 0; i < 5; i++) {
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 1500)' });
  await new Promise(r => setTimeout(r, 2500));
}
const homeR2 = await call('Runtime.evaluate', { 
  expression: 'document.querySelectorAll(\'article[data-testid="tweet"]\').length',
  returnByValue: true 
});
console.log('Home after 5 scrolls:', homeR2.result.value);

// Now go back to list
console.log('\n--- Back to list ---');
await call('Page.navigate', { url: 'https://x.com/i/lists/2019940021005058347' });
await new Promise(r => setTimeout(r, 6000));
const listR = await call('Runtime.evaluate', {
  expression: 'document.querySelectorAll(\'article[data-testid="tweet"]\').length',
  returnByValue: true
});
console.log('List initial:', listR.result.value);

// scroll list
for (let i = 0; i < 8; i++) {
  await call('Runtime.evaluate', { expression: 'window.scrollBy(0, 1500)' });
  await new Promise(r => setTimeout(r, 2500));
}
const listR2 = await call('Runtime.evaluate', {
  expression: '({art: document.querySelectorAll(\'article[data-testid="tweet"]\').length, y: window.scrollY, h: document.documentElement.scrollHeight})',
  returnByValue: true
});
console.log('List after scroll:', listR2.result.value);

ws.close();
