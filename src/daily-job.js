import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { scrapeListFeed } from './list-feed-scraper.js';
import { generateReport } from './report-generator.js';
import { sendTelegramMessage } from './telegram-notifier.js';
import { generateGovReport } from './gov-report-generator.js';
import { generateGovPdf } from './gov-pdf-generator.js';

const DATA_DIR = config.paths.data;
const REPORTS_DIR = config.paths.reports;

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

async function main() {
  console.log('🚀 Twitter Digest 日报生成开始 (List feed CDP)\n');
  console.log(`📅 日期: ${new Date().toISOString().split('T')[0]}`);
  console.log(`🧭 List: ${config.listFeed.url}`);
  console.log(`🧩 CDP: ${config.listFeed.cdpHost}:${config.listFeed.cdpPort}\n`);
  
  await ensureDirs();
  
  // 1. List feed scrape
  console.log('⏰ 抓取 List feed 推文...\n');
  const rawTweets = await scrapeListFeed();

  if (!rawTweets || rawTweets.length === 0) {
    console.log('⚠️ 未获取到推文，跳过报告生成');
    return;
  }

  // 2. 过滤 24h 内
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = rawTweets.filter(t => {
    if (!t || !t.datetime) return false;
    const d = new Date(t.datetime);
    return !Number.isNaN(d.getTime()) && d >= cutoff;
  });

  console.log(`\n📈 List feed 原始推文 ${rawTweets.length} 条，24h 内 ${recent.length} 条\n`);
  
  if (recent.length === 0) {
    console.log('⚠️ 未获取到推文，跳过报告生成');
    return;
  }

  // 3. 按 author 分组，整理为 generateReport() 需要的结构
  const byAuthor = new Map(); // username -> tweets[]
  for (const t of recent) {
    const author = (t.author || '').trim();
    if (!author) continue;
    const username = author.startsWith('@') ? author.slice(1) : author;
    const tweetUrl = (t.tweetUrl || '').trim();
    const m = tweetUrl.match(/\/status\/(\d+)/);
    const tweetId = m ? m[1] : null;

    const tweet = {
      text: (t.text || '').trim(),
      originalText: (t.text || '').trim(),
      url: tweetUrl || null,
      tweetId,
      createdAt: t.datetime,
      likes: 0,
      retweets: 0,
      isReply: false,
      isRetweet: false,
      images: Array.isArray(t.images) ? t.images : [],
    };

    const arr = byAuthor.get(username) || [];
    arr.push(tweet);
    byAuthor.set(username, arr);
  }

  const tweetsData = [...byAuthor.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([username, tweets]) => ({
      user: { username, name: username, followers: 0 },
      tweets: tweets.sort((a, b) => {
        const ta = new Date(a.createdAt || 0).getTime();
        const tb = new Date(b.createdAt || 0).getTime();
        return tb - ta;
      }),
    }))
    .filter(d => d.tweets.length > 0);

  const totalTweets = tweetsData.reduce((sum, d) => sum + d.tweets.length, 0);
  console.log(`📊 活跃信源: ${tweetsData.length} | 推文: ${totalTweets}\n`);
  
  // 4. 保存原始数据
  const today = new Date().toISOString().split('T')[0];
  const dataPath = path.join(DATA_DIR, `tweets-${today}.json`);
  await fs.writeFile(dataPath, JSON.stringify(tweetsData, null, 2));
  console.log(`💾 原始数据已保存: ${dataPath}\n`);
  
  // 5. 生成报告
  console.log(`🤖 正在用 ${config.openrouter.model} 生成报告...\n`);
  const report = await generateReport(tweetsData, new Date());
  
  // 6. 保存报告
  const reportPath = path.join(REPORTS_DIR, `report-${today}.md`);
  const reportContent = `# Twitter 信源日报 - ${today}

> 信源数: ${report.sourcesCount} | 推文数: ${report.totalTweets} | 生成时间: ${report.generatedAt}

---

${report.report}
`;
  
  await fs.writeFile(reportPath, reportContent);
  console.log(`📄 报告已保存: ${reportPath}\n`);
  
  // 7. 发送 Telegram 通知
  const telegramMsg = `📰 *Twitter 信源日报 - ${today}*

_${report.sourcesCount} 个信源 | ${report.totalTweets} 条推文_

---

${report.report}`;
  
  await sendTelegramMessage(telegramMsg);
  
  // 8. 生成政府版精华简报
  console.log(`\n📋 正在生成政府版精华简报...\n`);
  try {
    const govReport = await generateGovReport(tweetsData, new Date());
    const govReportPath = path.join(REPORTS_DIR, `gov-report-${today}.json`);
    await fs.writeFile(govReportPath, JSON.stringify(govReport, null, 2));
    console.log(`📄 政府版精华 JSON: ${govReportPath}`);

    const govPdfPath = path.join(REPORTS_DIR, `gov-daily-${today}.pdf`);
    await generateGovPdf(govReport, tweetsData, govPdfPath);
    console.log(`📄 政府版 PDF: ${govPdfPath}`);
  } catch (err) {
    console.error('⚠️ 政府版生成失败（不影响日常版）:', err.message);
  }

  console.log('\n✅ 日报生成完成!');
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
