import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { config } from './config.js';

/**
 * 政府版精华报告生成器 v3
 * 1. AI 精选 3-5 条最重要新闻
 * 2. Vision API 分析配图信息量
 * 3. 基于分析结果决定是否展示图片
 */

/**
 * 用 URL 过滤规则初筛图片
 * 只保留推文正文配图，排除头像、banner、视频缩略图
 */
function filterImageUrls(images) {
  if (!images || !Array.isArray(images)) return [];
  return images.filter(url => {
    // 只保留 pbs.twimg.com/media/ 开头的（推文正文配图）
    if (url.includes('pbs.twimg.com/media/')) return true;
    // 排除头像、banner、视频缩略图
    if (url.includes('profile_images')) return false;
    if (url.includes('profile_banners')) return false;
    if (url.includes('amplify_video_thumb')) return false;
    if (url.includes('ext_tw_video_thumb')) return false;
    if (url.includes('tweet_video_thumb')) return false;
    return false; // 默认排除其他
  });
}

/**
 * 用 Vision API 分析单张图片是否有信息量
 */
async function analyzeImageWithVision(imageUrl, tweetText) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `分析这张图片是否有信息量，适合放入政府科技简报。

推文原文：${tweetText.slice(0, 300)}

判断标准：
✅ 有信息量：benchmark 对比图、性能数据图表、架构图、技术示意图、数据可视化、测评对比表
❌ 无信息量：纯 logo、人头照/头像、产品 UI 截图、纯文字截图、meme/表情包、宣传海报、对话截图

请用JSON回复（不要包裹在代码块中）：
{"useful": true/false, "note": "一句话说明图片内容", "reason": "为什么有/没有信息量"}`
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl }
            }
          ]
        }],
        max_tokens: 200,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const rawText = await response.text();
    const data = JSON.parse(rawText);
    if (data.error) {
      console.log(`  ⚠️ Vision API error: ${data.error.message}`);
      return { useful: false, note: 'Vision API 错误', reason: data.error.message };
    }

    const content = data.choices[0].message.content;
    // Parse JSON from response
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Try to extract useful flag from text
      const isUseful = content.toLowerCase().includes('"useful": true') ||
                       content.toLowerCase().includes('"useful":true');
      return { useful: isUseful, note: content.slice(0, 100), reason: 'parsed from text' };
    }
  } catch (err) {
    console.log(`  ⚠️ Vision analysis failed: ${err.message}`);
    return { useful: false, note: '分析失败', reason: err.message };
  }
}

/**
 * 对精选新闻的图片进行 Vision 分析
 */
async function analyzeHighlightImages(highlights, tweetsData) {
  // Build image lookup from tweets data
  const imageMap = new Map();
  if (tweetsData) {
    for (const userData of tweetsData) {
      for (const tweet of (userData.tweets || [])) {
        const url = tweet.url || '';
        if (url && Array.isArray(tweet.images) && tweet.images.length > 0) {
          imageMap.set(url, { images: tweet.images, text: tweet.text || '' });
        }
      }
    }
  }

  console.log('🔍 开始分析精选新闻配图...');

  for (const item of highlights) {
    const tweetInfo = imageMap.get(item.url);
    if (!tweetInfo || !tweetInfo.images || tweetInfo.images.length === 0) {
      item.useImage = false;
      item.imageNote = '';
      console.log(`  📰 "${item.title.slice(0, 30)}..." → 无配图`);
      continue;
    }

    // URL-based filtering first
    const filteredImages = filterImageUrls(tweetInfo.images);
    if (filteredImages.length === 0) {
      item.useImage = false;
      item.imageNote = '';
      console.log(`  📰 "${item.title.slice(0, 30)}..." → 图片被 URL 规则过滤`);
      continue;
    }

    // Use vision API to analyze the first image
    const firstImage = filteredImages[0];
    console.log(`  🖼️  分析: "${item.title.slice(0, 30)}..." → ${firstImage.slice(0, 60)}...`);
    const result = await analyzeImageWithVision(firstImage, tweetInfo.text);
    
    item.useImage = result.useful === true;
    item.imageNote = result.note || '';
    console.log(`    ${item.useImage ? '✅ 保留' : '❌ 排除'}: ${result.note || result.reason || ''}`);
  }

  return highlights;
}

export async function generateGovReport(tweetsData, date) {
  const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];

  // 整理数据供 AI 分析（包含图片信息）
  const summary = tweetsData.map(d => ({
    user: `@${d.user.username}`,
    tweets: d.tweets.map(t => ({
      text: (t.text || '').slice(0, 400),
      url: t.url || (t.tweetId ? `https://x.com/${d.user.username}/status/${t.tweetId}` : ''),
      hasImages: (t.images || []).length > 0,
      imageCount: (t.images || []).length,
    })),
  }));

  const prompt = `你是一位面向政府领导的科技情报分析师。请从以下 Twitter 信源中分析 AI/科技动态，生成精华简报。

日期：${dateStr}

数据：
${JSON.stringify(summary, null, 2)}

## 要求
1. 精选 3-5 条最重要的作为"要点"（highlights），每条带 3-5 句详细摘要
2. 额外输出 5-10 条"其他动态"（others），每条只需一句话标题+一句话摘要
3. 只选 AI、科技、重大产品发布相关的内容（忽略政治、社会议论等）
4. 每条用中文撰写，通俗易懂，让不懂技术的领导也能看懂
5. 标题简洁有力，一句话概括
6. 按重要性排序

## 输出格式
严格输出 JSON，不要有任何多余文字：
{
  "date": "${dateStr}",
  "highlights": [
    {
      "title": "一句话标题",
      "summary": "3-5句核心内容摘要，详细说明是什么、为什么重要",
      "source": "@handle",
      "url": "https://x.com/...",
      "importance": "high 或 medium"
    }
  ],
  "others": [
    {
      "title": "一句话标题",
      "brief": "一句话简短摘要",
      "source": "@handle",
      "url": "https://x.com/..."
    }
  ]
}`

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

  // Step 2: Analyze images with Vision API
  console.log('\n📸 开始 Vision 图片分析...');
  govReport.highlights = await analyzeHighlightImages(
    govReport.highlights || [],
    tweetsData
  );
  console.log('📸 图片分析完成\n');

  return govReport;
}

// CLI entry point
async function main() {
  const today = process.argv[2] || new Date().toISOString().split('T')[0];
  const dataPath = path.join(config.paths.data, `tweets-${today}.json`);

  console.log(`📋 政府版精华报告生成器 v3`);
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
  console.log(`📊 要点: ${(govReport.highlights||[]).length} 条`);
  console.log(`   其他: ${(govReport.others||[]).length} 条\n`);

  for (const item of (govReport.highlights || [])) {
    const imgStatus = item.useImage ? '🖼️' : '📝';
    console.log(`  ${imgStatus} [要点] ${item.title}`);
    console.log(`    ${item.source} - ${item.url}`);
    if (item.imageNote) console.log(`    图片: ${item.imageNote}`);
    console.log('');
  }
  for (const item of (govReport.others || [])) {
    console.log(`  [其他] ${item.title}`);
  }
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
