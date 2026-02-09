# List Feed 爬取方案设计

## 目标
将日报数据源从"逐个用户爬取"改为"List feed 一次爬取"，确保 cron job 自动执行时稳定可靠。

## 技术方案

### 核心：新建 `src/list-feed-scraper.js`

通过 CDP (Chrome DevTools Protocol) 连接 OpenClaw 管理的浏览器，爬取 Twitter List feed。

**流程：**
1. 连接 CDP（`http://127.0.0.1:18800/json/list` 获取 page target）
2. 导航到 List feed URL: `https://x.com/i/lists/2019940021005058347`
3. 等待页面加载（5 秒）
4. 滚动页面 + 提取推文（每次滚动 2000px，等 1.5 秒，循环 20 次）
5. 从每条 `article[data-testid="tweet"]` 提取：
   - `author`: 第一个 `@xxx` 格式的 span
   - `text`: `[data-testid="tweetText"]` 的 innerText（截断 800 字符）
   - `datetime`: `time` 元素的 `datetime` 属性（ISO 8601 格式）
   - `tweetUrl`: `time` 外层 `a` 的 href
6. 去重（按 tweetUrl）
7. 按 datetime 过滤 24h 内的推文
8. 返回结果

**关键参数（写在 config.js 中）：**
```js
listFeed: {
  url: 'https://x.com/i/lists/2019940021005058347',
  cdpHost: '127.0.0.1',
  cdpPort: 18800,
  scrollCount: 20,      // 滚动次数
  scrollDelay: 1500,     // 每次滚动等待 ms
  pageLoadDelay: 5000,   // 页面加载等待 ms
}
```

**依赖：** 只需要 `ws` (WebSocket)，加到 package.json。

### 提取 JS 代码（在浏览器中执行）

```javascript
// 初始化全局存储
window.__allTweets = window.__allTweets || {};

function extractTweets() {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const art of articles) {
    try {
      const timeEl = art.querySelector('time');
      if (!timeEl) continue;
      const datetime = timeEl.getAttribute('datetime') || '';
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText : '';
      
      // 提取 author
      const userLinks = art.querySelectorAll('a[href^="/"]');
      let author = '';
      for (const link of userLinks) {
        const spans = link.querySelectorAll('span');
        for (const span of spans) {
          if (span.textContent.startsWith('@')) { 
            author = span.textContent; 
            break; 
          }
        }
        if (author) break;
      }
      
      // 提取 tweet URL
      const timeLink = timeEl.closest('a');
      const tweetUrl = timeLink ? 'https://x.com' + timeLink.getAttribute('href') : '';
      
      const key = tweetUrl || datetime + text.substring(0, 50);
      if (!window.__allTweets[key]) {
        window.__allTweets[key] = { author, text: text.substring(0, 800), datetime, tweetUrl };
      }
    } catch(e) {}
  }
}

extractTweets();
```

### 修改 `src/daily-job.js`

**改动最小化**：
- 新增导入 `list-feed-scraper.js`
- 数据获取步骤改为调用 `scrapeListFeed()`
- 保留时间过滤逻辑（用 datetime ISO 字符串直接比较）
- 保留报告生成和发送逻辑

```javascript
// 旧: const tweetsData = await fetchAllUserTimelines(usernames);
// 新:
import { scrapeListFeed } from './list-feed-scraper.js';
const rawTweets = await scrapeListFeed();
// 过滤 24h 内
const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
const recentTweets = rawTweets.filter(t => {
  if (!t.datetime) return false;
  try {
    return new Date(t.datetime) >= cutoff;
  } catch { return false; }
});
```

### 修改 `src/config.js`

添加 `listFeed` 配置块，List ID 从环境变量读取：
```
LIST_FEED_URL=https://x.com/i/lists/2019940021005058347
```

### 不需要改动的文件
- `src/snowflake.js` — 不用了（List feed 直接有 ISO datetime）
- `src/time-filter.js` — 不用了（datetime 直接比较）
- `src/jina-client.js` — 废弃（不再用 Jina）
- `src/following-fetcher.js` — 废弃（不再逐个用户）
- `src/browser-scraper.js` — 废弃（这是旧的浏览器方案）

## 关键注意

1. **ws 模块**: 需要 `npm install ws`
2. **CDP 连接**: 浏览器必须是 OpenClaw 管理的（端口 18800）
3. **错误处理**: CDP 连接失败、页面加载超时、限流等都要有清晰的错误信息
4. **导出函数**: `scrapeListFeed()` 返回 `Promise<Array<{author, text, datetime, tweetUrl}>>`
5. **日志**: 每步都要有日志，方便 cron 调试
