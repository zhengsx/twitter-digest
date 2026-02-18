import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { config } from './config.js';

/**
 * 政府版精华报告生成器
 * 从推文数据中精选 3-5 条最重要的 AI/科技动态
 */
export async function generateGovReport(tweetsData, date) {
  const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];

  // 整理数据供 AI 分析
  const summary = tweetsData.map(d => ({
    user: `@${d.user.username}`,
    tweets: d.tweets.map(t => ({
      text: (t.text || '').slice(0, 400),
      url: t.url || (t.tweetId ? `https://x.com/${d.user.username}/status/${t.tweetId}` : ''),
      images: t.images || [],
    })),
  }));

  const prompt = `你是一位面向政府领导的科技情报分析师。请从以下 Twitter 信源中精选 3-5 条最重要的 AI/科技动态，生成精华简报。

日期：${dateStr}

数据：
${JSON.stringify(summary, null, 2)}

## 要求
1. 只选 AI、科技、重大产品发布相关的内容（忽略政治、社会议论等）
2. 每条用中文撰写，通俗易懂，让不懂技术的领导也能看懂
3. 标题简洁有力，一句话概括
4. 摘要 2-3 句，简明扼要说清楚：是什么、为什么重要
5. 按重要性排序

## 输出格式
严格输出 JSON，不要有任何多余文字：
{
  "date": "${dateStr}",
  "items": [
    {
      "title": "一句话标题",
      "summary": "3-5句核心内容摘要",
      "source": "@handle",
      "url": "https://x.com/...",
      "importance": "high 或 medium"
    }
  ]
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GOV_REPORT_MODEL || 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
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
    console.error('Gov report API parse error:', rawText.slice(0, 500));
    throw new Error(`API response is not valid JSON`);
  }

  if (data.error) {
    throw new Error(`API error: ${data.error.message}`);
  }

  const content = data.choices[0].message.content;

  // Extract JSON from response (may be wrapped in markdown code block)
  let govReport;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
  
  // Try to fix truncated JSON by closing open structures
  try {
    govReport = JSON.parse(jsonStr);
  } catch (e1) {
    // Try adding closing brackets
    const fixes = ['}]}', '"}]}', '"}  ]}', '"\n    }  \n]}'];
    let parsed = false;
    for (const fix of fixes) {
      try {
        govReport = JSON.parse(jsonStr + fix);
        parsed = true;
        console.log('⚠️ Fixed truncated JSON by appending:', fix);
        break;
      } catch {}
    }
    if (!parsed) {
      console.error('Failed to parse gov report JSON:', jsonStr.slice(0, 500));
      throw new Error('AI did not return valid JSON for gov report');
    }
  }

  return govReport;
}

// CLI entry point
async function main() {
  const today = process.argv[2] || new Date().toISOString().split('T')[0];
  const dataPath = path.join(config.paths.data, `tweets-${today}.json`);

  console.log(`📋 政府版精华报告生成器`);
  console.log(`📅 日期: ${today}`);
  console.log(`📂 数据: ${dataPath}\n`);

  const raw = await fs.readFile(dataPath, 'utf-8');
  const tweetsData = JSON.parse(raw);

  const govModel = process.env.GOV_REPORT_MODEL || 'google/gemini-2.0-flash-001';
  console.log(`🤖 正在用 ${govModel} 生成精华版...\n`);
  const govReport = await generateGovReport(tweetsData, today);

  const outPath = path.join(config.paths.reports, `gov-report-${today}.json`);
  await fs.mkdir(config.paths.reports, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(govReport, null, 2));
  console.log(`✅ 精华报告已保存: ${outPath}`);
  console.log(`📊 精选条目: ${govReport.items.length} 条\n`);

  for (const item of govReport.items) {
    console.log(`  [${item.importance}] ${item.title}`);
    console.log(`    ${item.source} - ${item.url}\n`);
  }
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
