# Twitter Digest Scripts

## Production scripts
- `add-list-members.py` — 批量加 Twitter list 成员（Playwright CDP 取 cookies → GraphQL API 直调）
  - 用法：`python3 scripts/add-list-members.py --list-id <ID> --handles user1 user2 ...`
  - List ID `2019940021005058347` = AI Digest 私密列表

## CDP debug scripts (created 2026-04-27 during list-feed-scraper rewrite)
所有脚本依赖 Chrome 在 `127.0.0.1:18800` 已登录 x.com。从此目录跑 `node scripts/cdp_xxx.js`。

- `cdp_check.js` — 基础 scroll + DOM article count 诊断
- `cdp_check_alt.js` — 比较 list 页 vs /home 的 timeline 渲染行为，判断是否 list 特异
- `cdp_deep_probe.js` — DOM 深度诊断（cellInnerDiv、retry button、pill button、suggested follows）
- `cdp_scroll_strategies.js` — 三种 scroll 策略对比（slow / scroll-to-bottom / End 键）
- `cdp_stealth_test.js` — 探测 navigator.webdriver / cdc_xxx / chrome 等 automation 信号，patch 后对比
- `cdp_xhr_capture.js` — **关键**：监听 `Network.responseReceived`，抓 `ListLatestTweetsTimeline` graphql 响应。这是诊断 list 抓取问题最快的工具。
- `cdp_inspect_one.js` — 解析单个 tweet entry 的完整 schema（用于发现 X schema 变化，例如 screen_name 从 legacy 移到 core）
- `cdp_capture_full.js` / `cdp_capture_v2.js` — 完整 graphql 抓取流程的原型（已在 src/list-feed-scraper.js 里集成）

### 何时用这些
1. 推特日报推文数 < 20 → 怀疑抓取降级
2. 先跑 `cdp_xhr_capture.js` 看 graphql 是否返回正常体量
3. 如果 graphql 正常但 parse 后为 0 → 跑 `cdp_inspect_one.js` 看 schema 变化
4. 如果 graphql 没返回 → cookie 过期或 navigate 失败
