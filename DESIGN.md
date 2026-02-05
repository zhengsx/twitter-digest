# Twitter Digest 全面修复设计文档

## 📋 当前问题分析

### 问题 A: Jina Reader 缓存问题
**现状:**
- `getUserTimeline()` 函数调用 Jina API 时没有添加 cache 控制 headers
- 当前 headers:
  ```javascript
  headers: {
    'Authorization': `Bearer ${JINA_API_KEY}`,
    'X-Return-Format': 'markdown',
    'X-With-Generated-Alt': 'true',
  }
  ```
- 导致可能获取到旧数据

**解决方案:**
- 添加 `X-No-Cache: true` 强制跳过缓存
- 添加 `X-Timeout: 30` 确保等待页面完全加载
- 添加数据校验：检查最新推文时间，如果都超过 24h 可能是缓存问题

### 问题 B: 用户列表硬编码
**现状:**
- `fetch-and-generate-v2.js` 中硬编码 23 个用户
- `config.js` 支持通过 `FOLLOWING_USERS` 环境变量配置，但未使用
- 无法动态获取 @xxcc48764 的关注列表

**解决方案:**
- 创建 `following-fetcher.js` 专门爬取 following 列表
- 使用 Jina 爬取 `https://x.com/xxcc48764/following` 页面
- 存储关注列表到 `data/following.json`
- 每次运行时对比变更
- 主程序从 JSON 文件读取用户列表

### 问题 C: AI 分析不足
**现状:**
- `generateMarkdownReport()` 只是简单罗列推文
- 没有使用 LLM 进行内容分析

**解决方案:**
- 创建 `ai-analyzer.js` 使用 OpenRouter API
- 提取 insights、观点、技术细节、趋势
- 分类整理：AI/ML 技术、产品发布、行业观点、趋势预判
- 生成结构化日报

---

## 🛠️ 技术方案

### 1. Jina 缓存修复 (`jina-client.js`)

```javascript
const headers = {
  'Authorization': `Bearer ${JINA_API_KEY}`,
  'X-Return-Format': 'markdown',
  'X-With-Generated-Alt': 'true',
  'X-No-Cache': 'true',      // 新增：强制不用缓存
  'X-Timeout': '30',          // 新增：等待 30 秒让页面完全加载
};
```

数据校验逻辑：
- 解析返回推文的时间
- 如果所有推文都超过 7 天，打印警告（可能是缓存数据）
- 记录最新推文的实际时间

### 2. 动态关注列表 (`following-fetcher.js`)

```javascript
// 爬取 following 页面
async function fetchFollowingList(username) {
  const url = `https://r.jina.ai/https://x.com/${username}/following`;
  // ... 解析返回的用户名列表
}

// 存储和比对
async function syncFollowingList() {
  const current = await fetchFollowingList('xxcc48764');
  const stored = await loadStoredFollowing();
  
  const diff = {
    added: current.filter(u => !stored.includes(u)),
    removed: stored.filter(u => !current.includes(u)),
  };
  
  await saveFollowing(current);
  return { users: current, diff };
}
```

存储格式 `data/following.json`:
```json
{
  "username": "xxcc48764",
  "users": ["user1", "user2", ...],
  "lastUpdated": "2026-02-05T14:00:00Z",
  "history": [
    { "date": "2026-02-05", "added": [], "removed": [] }
  ]
}
```

### 3. AI 分析器 (`ai-analyzer.js`)

使用 OpenRouter API (Gemini Flash 便宜模型) 分析推文：

```javascript
async function analyzeTwitterDigest(tweetsData) {
  // 先压缩数据（只保留必要字段）
  const compressed = compressTweets(tweetsData);
  
  const prompt = `
分析以下 Twitter 推文，提取有价值的信息：

${JSON.stringify(compressed)}

请按以下结构输出：
1. 💡 关键 Insights（3-5 条最重要的见解）
2. 🔧 技术细节（具体技术、工具、方法）
3. 📈 趋势预判（行业走向、热点话题）
4. 🎯 观点汇总（KOL 的重要观点）
5. 📰 新闻摘要（重要发布、更新）

注意：每条 insight 后附上原文链接。
`;
  
  return callOpenRouter(prompt);
}
```

### 4. 新的报告格式

```markdown
# Twitter AI 日报 - 2026-02-05

## 💡 今日 Insights
1. **[主题]** 简要描述... [原文](链接)
2. ...

## 🔧 技术细节
- 具体技术点...

## 📈 趋势观察
- 行业趋势分析...

## 🎯 KOL 观点
- @username: 观点... [链接]

## 📝 推文原文
### @user1
- 推文内容... [链接]
```

---

## 📁 文件变更计划

### 新增文件
- `src/following-fetcher.js` - 关注列表爬取
- `src/ai-analyzer.js` - AI 分析器
- `data/following.json` - 关注列表存储

### 修改文件
- `src/jina-client.js` - 添加 cache headers
- `src/fetch-and-generate-v2.js` - 集成动态用户列表 + AI 分析
- `package.json` - 添加新的运行脚本

---

## ✅ 实现步骤

### Step 1: 修复 Jina 缓存
1. 在所有 Jina API 调用中添加 `X-No-Cache: true` 和 `X-Timeout: 30`
2. 添加数据校验逻辑

### Step 2: 实现关注列表动态获取
1. 创建 `following-fetcher.js`
2. 实现爬取、存储、比对逻辑
3. 修改主程序读取 JSON 而非硬编码

### Step 3: 实现 AI 分析
1. 创建 `ai-analyzer.js`
2. 设计 prompt 提取 insights
3. 修改报告生成器整合 AI 分析

### Step 4: 集成测试
1. 运行完整流程
2. 验证输出格式
3. 确保链接完整

---

## 🔑 验收标准

- [ ] Jina 请求包含 `X-No-Cache: true` 和 `X-Timeout: 30`
- [ ] 用户列表从 `data/following.json` 动态读取
- [ ] `data/following.json` 由爬取 @xxcc48764/following 生成
- [ ] 日报包含 AI 分析的 insights 部分
- [ ] 每条 insight 附有原文链接
- [ ] `npm run daily` 可以正常执行

---

*文档创建: 2026-02-05*
