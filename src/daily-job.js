import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { scrapeListFeed } from './list-feed-scraper.js';
import { generateReport } from './report-generator.js';
import { sendTelegramMessage } from './telegram-notifier.js';
import { generateDailyPdf } from './html-pdf-generator.js';
import { generateGovReport } from './gov-report-generator.js';
import { generateGovPdf } from './gov-pdf-generator.js';
import { fetchYouTubePodcasts } from './youtube-fetcher.js';

const DATA_DIR = config.paths.data;
const REPORTS_DIR = config.paths.reports;

// ⚠️ 安全优先：Relay 使用真实浏览器指纹，封号风险远低于 headless
// Headless 仅作备选，且操作速度要更慢（headless 模式下滚动间隔 ×1.5）
const RELAY_PORT = 18792;
const HEADLESS_PORT = 18800;
const CDP_HOST = config.listFeed.cdpHost;

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function buildHeadlessArgs(port) {
  return [
    `--remote-debugging-port=${port}`,
    '--user-data-dir=/tmp/chrome-cdp-profile',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ];
}

const RELAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

async function tryConnect(port) {
  try {
    const tokenParam = port === RELAY_PORT ? `?token=${RELAY_TOKEN}` : '';
    const url = `http://${CDP_HOST}:${port}/json/version${tokenParam}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await tryConnect(port)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function launchHeadless() {
  const { spawn } = await import('child_process');
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`🔄 第 ${attempt} 次尝试启动 headless Chrome (${HEADLESS_PORT})...`);
    const child = spawn(CHROME_PATH, buildHeadlessArgs(HEADLESS_PORT), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (await waitForCdp(HEADLESS_PORT, 15000)) {
      return;
    }
    console.log(`⚠️ 第 ${attempt} 次等待超时`);
  }
  throw new Error('❌ 无法启动 headless Chrome，两次尝试均失败');
}

/**
 * 确保 CDP 可用，优先使用 Chrome Relay (18792)，回退 headless (18800)。
 * 返回实际使用的端口号。
 */
async function ensureCdpRunning() {
  // 1. 先试 relay (18792)
  if (await tryConnect(RELAY_PORT)) {
    console.log('✅ Chrome Relay 连接成功 (18792)');
    return RELAY_PORT;
  }
  console.warn('⚠️ Relay 不可达，回退到 headless CDP (18800)');

  // 2. 再试 headless (18800)
  if (await tryConnect(HEADLESS_PORT)) {
    console.log('✅ Headless CDP 连接成功 (18800)');
    return HEADLESS_PORT;
  }

  // 3. 尝试启动 headless
  await launchHeadless();
  if (await tryConnect(HEADLESS_PORT)) {
    console.log('✅ Headless CDP 启动并连接成功 (18800)');
    return HEADLESS_PORT;
  }

  // 最后尝试：通知 sx
  console.error('❌ Relay 和 Headless 均不可达。请确保：');
  console.error('   1. Chrome 已打开');
  console.error('   2. OpenClaw Browser Relay 扩展已 attach 一个 tab');
  console.error('   3. 或者 headless Chrome 正在运行');
  throw new Error('❌ Relay 和 Headless 均不可达，请检查 Chrome 状态');
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

async function main() {
  const activeCdpPort = await ensureCdpRunning();

  console.log('🚀 Twitter Digest 日报生成开始 (List feed CDP)\n');
  console.log(`📅 日期: ${new Date().toISOString().split('T')[0]}`);
  console.log(`🧭 List: ${config.listFeed.url}`);
  console.log(`🧩 CDP: ${config.listFeed.cdpHost}:${activeCdpPort}\n`);
  
  await ensureDirs();
  
  // 1. List feed scrape
  console.log('⏰ 抓取 List feed 推文...\n');
  const rawTweets = await scrapeListFeed(activeCdpPort);

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
  const byAuthor = new Map();
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
  
  // 5. 获取 YouTube 播客更新（错误不阻塞主流程）
  console.log('📺 获取 YouTube 播客更新...\n');
  let youtubePodcasts = [];
  try {
    youtubePodcasts = await fetchYouTubePodcasts(config.youtube?.podcasts || []);
  } catch (err) {
    console.warn('⚠️ YouTube 播客获取失败（不影响日报生成）:', err.message);
  }

  // 6. 生成报告
  console.log(`🤖 正在用 ${config.openrouter.model} 生成报告...\n`);
  const report = await generateReport(tweetsData, new Date(), youtubePodcasts);
  
  // 7. 保存报告 MD
  const reportPath = path.join(REPORTS_DIR, `report-${today}.md`);
  const youtubeStats = report.totalYoutubeVideos > 0 ? ` | 播客更新: ${report.totalYoutubeVideos}` : '';
  const reportContent = `# Twitter 信源日报 - ${today}

> 信源数: ${report.sourcesCount} | 推文数: ${report.totalTweets}${youtubeStats} | 生成时间: ${report.generatedAt}

---

${report.report}
`;
  
  await fs.writeFile(reportPath, reportContent);
  console.log(`📄 报告已保存: ${reportPath}\n`);

  // 7. 日常版 PDF（MD → HTML → CDP printToPDF）
  console.log(`📰 正在生成日常版 PDF...\n`);
  try {
    const dailyPdfPath = path.join(REPORTS_DIR, `twitter-daily-${today}.pdf`);
    await generateDailyPdf(reportPath, dailyPdfPath, today);
    console.log(`📄 日常版 PDF: ${dailyPdfPath}`);
  } catch (err) {
    console.error('⚠️ 日常版 PDF 生成失败（不影响其他步骤）:', err.message);
  }
  
  // 8. 发送 Telegram 通知
  const youtubeStatsLine = report.totalYoutubeVideos > 0 ? ` | 📺 播客 ${report.totalYoutubeVideos} 集` : '';
  const telegramMsg = `📰 *Twitter 信源日报 - ${today}*

_${report.sourcesCount} 个信源 | ${report.totalTweets} 条推文${youtubeStatsLine}_

---

${report.report}`;
  
  await sendTelegramMessage(telegramMsg);
  
  // 9. 生成政府版精华简报（默认跳过，传 --gov 或 ENABLE_GOV=1 时启用）
  const enableGov = process.argv.includes('--gov') || process.env.ENABLE_GOV === '1';
  if (enableGov) {
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
  } else {
    console.log(`\n⏭️ 政府版已跳过（传 --gov 或 ENABLE_GOV=1 启用）`);
  }

  console.log('\n✅ 日报生成完成!');
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
