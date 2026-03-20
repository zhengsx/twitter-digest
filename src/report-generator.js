import fetch from 'node-fetch';
import { config } from './config.js';

/**
 * 用 OpenRouter API 生成报告（默认 Claude Opus 4.6）
 * @param {Array} tweetsData - 推文数据
 * @param {Date} date - 日期
 * @param {Array} [youtubePodcasts] - YouTube 播客更新（可选）
 */
export async function generateReport(tweetsData, date, youtubePodcasts = []) {
  const dateStr = date.toISOString().split('T')[0];
  
  // 整理数据
  const summary = tweetsData.map(d => {
    return {
      user: `@${d.user.username}`,
      // 传所有推文给模型，不做截断筛选
      allTweets: d.tweets
        .map(t => ({
          text: (t.text || '').slice(0, 300),
          url: buildTweetUrl(d.user.username, t),
        })),
    };
  });
  
  // 构建 YouTube 播客章节（如果有更新）
  const youtubeSectionText = youtubePodcasts && youtubePodcasts.length > 0
    ? `\n\nYouTube 播客今日更新：\n${JSON.stringify(
        youtubePodcasts.map(({ podcast, videos }) => ({
          podcast: podcast.name,
          handle: podcast.handle,
          newVideos: videos.map(v => ({
            title: v.title,
            url: v.url,
            published: v.published,
            description: v.description,
          })),
        })),
        null, 2
      )}`
    : '';

  const prompt = `你是一位科技行业信息聚合分析师。请根据以下 Twitter 信源的今日动态生成一份**周全、完整**的日报。

日期：${dateStr}
信源数量：${tweetsData.length} 个账号

数据：
${JSON.stringify(summary, null, 2)}${youtubeSectionText}

## 核心原则（必须遵守！）
- **不要自行判断信息是否重要进行筛选！** 你的任务是信息的聚合和排序，不是筛选
- **每一条有实质内容的推文都必须出现在报告中**，不能遗漏
- 所谓"无实质内容"仅指纯表情、"Yes"、"Cool"、"True" 等单词回复
- 只要推文包含具体信息（产品名、公司名、技术概念、数据、观点），就必须收录

## 报告结构
1. **🔥 今日要点**（5-10 条，按重要性排序）
   - 每条包含：标题、涉及人物、核心内容摘要、原文链接
   
2. **👤 各信源动态**（按信源分组，覆盖所有有推文的信源）
   - 每个信源的每条推文都要简要提及
   - 包含原文精选和链接
${youtubePodcasts && youtubePodcasts.length > 0 ? `
3. **📺 播客更新**（YouTube 播客新节目）
   - 列出每个有更新的播客频道及新集标题、链接
   - 简要概述节目主题（根据标题和描述推断）
` : ''}
4. **📊 统计** — 信源数、推文数${youtubePodcasts && youtubePodcasts.length > 0 ? '、播客更新数' : ''}

## 其他要求
- 用中文输出
- 保留所有技术细节（模型名、参数、benchmark 数据等）
- 保留所有人名、公司名、项目名
- 链接必须保留`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000); // 3 分钟超时
  
  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 16000,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error('API response parse error. Raw length:', rawText.length, 'First 500 chars:', rawText.slice(0, 500));
    throw new Error(`API response is not valid JSON (${rawText.length} bytes)`);
  }
  
  if (data.error) {
    throw new Error(`API 错误: ${data.error.message}`);
  }
  
  const youtubeSection = buildYoutubePodcastSection(youtubePodcasts);
  const report = data.choices[0].message.content + buildTweetListSection(tweetsData) + youtubeSection;

  const totalYoutubeVideos = youtubePodcasts.reduce((s, r) => s + r.videos.length, 0);

  return {
    date: dateStr,
    report,
    sourcesCount: tweetsData.length,
    totalTweets: tweetsData.reduce((sum, d) => sum + d.tweets.length, 0),
    totalYoutubeVideos,
    generatedAt: new Date().toISOString(),
  };
}

function buildYoutubePodcastSection(youtubePodcasts) {
  if (!youtubePodcasts || youtubePodcasts.length === 0) return '';

  const lines = ['\n\n【YouTube 播客更新列表】'];
  for (const { podcast, videos } of youtubePodcasts) {
    if (!videos || videos.length === 0) continue;
    lines.push(`\n频道：${podcast.name} (${podcast.handle})`);
    for (const v of videos) {
      lines.push(`标题：${v.title}`);
      lines.push(`链接：${v.url}`);
      if (v.published) lines.push(`发布时间：${v.published}`);
      if (v.description) lines.push(`简介：${v.description}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function buildTweetListSection(tweetsData) {
  const lines = ['\n\n【推文列表】'];
  for (const userData of tweetsData) {
    const username = userData.user.username;
    for (const tweet of userData.tweets) {
      const originalText = tweet.originalText || tweet.text || '';
      const url = buildTweetUrl(username, tweet) || tweet.url || '';
      lines.push(`账号：@${username}`);
      lines.push(`原文：${originalText}`);
      lines.push(`链接：${url}`);
      lines.push(''); // blank line between tweets
    }
  }
  return lines.join('\n');
}

function buildTweetUrl(username, tweet) {
  if (tweet && tweet.tweetId) {
    return `https://x.com/${username}/status/${tweet.tweetId}`;
  }
  return tweet && tweet.url ? tweet.url : null;
}
