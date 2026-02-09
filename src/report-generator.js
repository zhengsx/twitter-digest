import fetch from 'node-fetch';
import { config } from './config.js';

/**
 * 用 OpenRouter API 生成报告（默认 Claude Opus 4.6）
 */
export async function generateReport(tweetsData, date) {
  const dateStr = date.toISOString().split('T')[0];
  
  // 整理数据
  const summary = tweetsData.map(d => {
    const originalTweets = d.tweets.filter(t => !t.isReply && !t.isRetweet);
    const replies = d.tweets.filter(t => t.isReply);
    const retweets = d.tweets.filter(t => t.isRetweet);
    
    return {
      user: `@${d.user.username} (${d.user.name})`,
      followers: d.user.followers,
      stats: {
        total: d.tweets.length,
        original: originalTweets.length,
        replies: replies.length,
        retweets: retweets.length,
      },
      topTweets: originalTweets
        .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
        .slice(0, 5)
        .map(t => ({
          text: t.text.slice(0, 280),
          likes: t.likes,
          retweets: t.retweets,
          url: buildTweetUrl(d.user.username, t),
          tweetId: t.tweetId || null,
        })),
    };
  });
  
  const prompt = `作为资深科技行业分析师，请根据以下 Twitter 信源的今日动态生成一份简洁有洞察的日报。

日期：${dateStr}
信源数量：${tweetsData.length} 个账号

数据：
${JSON.stringify(summary, null, 2)}

要求：
1. 提炼今日最重要的 3-5 个话题/趋势
2. 标注关键人物的重要发言
3. 如有行业热点事件，简要分析
4. 语言简洁，重点突出
5. 用中文输出`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openrouter.apiKey}`,
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
    }),
  });
  
  const data = await response.json();
  
  if (data.error) {
    throw new Error(`Gemini API 错误: ${data.error.message}`);
  }
  
  const report = data.choices[0].message.content + buildTweetListSection(tweetsData);

  return {
    date: dateStr,
    report,
    sourcesCount: tweetsData.length,
    totalTweets: tweetsData.reduce((sum, d) => sum + d.tweets.length, 0),
    generatedAt: new Date().toISOString(),
  };
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
