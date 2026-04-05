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
import { execSync } from 'child_process';

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
 * 确保 CDP 可用，直接使用 headless (18800)，跳过 relay（relay 有 bug #57209）。
 * 返回实际使用的端口号。
 */
async function ensureCdpRunning() {
  // 直接使用 headless (18800)，跳过 relay
  if (await tryConnect(HEADLESS_PORT)) {
    console.log('✅ Headless CDP 连接成功 (18800)');
    return HEADLESS_PORT;
  }

  // 尝试启动 headless
  await launchHeadless();
  if (await tryConnect(HEADLESS_PORT)) {
    console.log('✅ Headless CDP 启动并连接成功 (18800)');
    return HEADLESS_PORT;
  }

  console.error('❌ Headless CDP 不可达，请确保：');
  console.error('   1. Chrome 已安装');
  console.error('   2. headless Chrome 可以正常启动');
  throw new Error('❌ Headless CDP 不可达，请检查 Chrome 状态');
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

async function notifyFailure(errorMessage, suggestion) {
  const port = process.env.OPENCLAW_GATEWAY_PORT || 4152;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  
  const text = `❌ 推特日报生成失败\n\n错误: ${errorMessage}\n\n建议: ${suggestion}`;
  
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/message/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: 'openclaw-weixin',
        to: 'o9cq8098IQ2R72gf193fZuolDyw8@im.wechat',
        accountId: '75a1dab92392-im-bot',
        message: text,
      }),
    });
    if (resp.ok) {
      console.log('📨 已通知 sx 失败信息');
    } else {
      console.error('⚠️ 通知发送失败:', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('⚠️ 无法连接 Gateway 发送通知:', e.message);
  }
}

/**
 * Check if Twitter login has expired by looking for login buttons on the page.
 * Uses CDP to evaluate JS in the current page context.
 */
async function checkLoginExpired(cdpPort) {
  const WebSocket = (await import('ws')).default;
  const nodeFetch = (await import('node-fetch')).default;
  const host = config.listFeed.cdpHost || '127.0.0.1';
  const RELAY_PORT = 18792;
  const RELAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const tokenParam = cdpPort === RELAY_PORT ? `?token=${RELAY_TOKEN}` : '';

  try {
    const listRes = await nodeFetch(
      `http://${host}:${cdpPort}/json/list${tokenParam}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const targets = await listRes.json();
    const pageTarget = targets.find(
      t => t.type === 'page' && t.webSocketDebuggerUrl
    );
    if (!pageTarget) return false;

    let wsUrl = pageTarget.webSocketDebuggerUrl;
    if (cdpPort === RELAY_PORT && RELAY_TOKEN && !wsUrl.includes('token=')) {
      wsUrl += (wsUrl.includes('?') ? '&' : '?') + `token=${RELAY_TOKEN}`;
    }

    const ws = new WebSocket(wsUrl, { handshakeTimeout: 5000 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    let nextId = 1;
    const pending = new Map();
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {}
    });

    function cdpSend(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10000);
        pending.set(id, {
          resolve: v => { clearTimeout(timer); resolve(v); },
          reject: e => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const res = await cdpSend('Runtime.evaluate', {
      expression: `!!document.querySelector('[data-testid="loginButton"], a[href="/login"], [data-testid="login"]')`,
      returnByValue: true,
    });
    ws.close(1000, 'done');
    return res?.result?.value === true;
  } catch (err) {
    console.warn(`⚠️ checkLoginExpired 检查失败: ${err.message}`);
    return false;
  }
}

/**
 * Sync Twitter/X cookies from the user's main Chrome to the headless profile.
 * Returns true if sync succeeded and headless Chrome was restarted.
 */
async function syncCookiesFromMainChrome() {
  try {
    const srcCookies = path.join(
      process.env.HOME,
      'Library/Application Support/Google/Chrome/Default/Cookies'
    );
    const dstDir = '/tmp/chrome-cdp-profile/Default';
    const dstCookies = path.join(dstDir, 'Cookies');

    // Check source exists
    try {
      await fs.access(srcCookies);
    } catch {
      console.error('❌ 主 Chrome Cookies 文件不存在:', srcCookies);
      return false;
    }

    // Ensure destination dir exists
    await fs.mkdir(dstDir, { recursive: true });

    // Copy source to temp to avoid lock, then use python3+sqlite3 to transfer
    const pythonScript = `
import sqlite3, shutil, os
src = '/tmp/chrome-cookies-src-copy'
shutil.copy2('${srcCookies}', src)
dst = '${dstCookies}'

# Open source and read twitter/x.com cookies
src_conn = sqlite3.connect(src)
try:
    src_cookies = src_conn.execute(
        "SELECT * FROM cookies WHERE host_key LIKE '%x.com%' OR host_key LIKE '%twitter.com%'"
    ).fetchall()
    col_names = [d[0] for d in src_conn.execute("SELECT * FROM cookies LIMIT 0").description]
except Exception as e:
    print(f"Error reading source cookies: {e}")
    src_conn.close()
    os.remove(src)
    exit(1)
src_conn.close()
os.remove(src)

if not src_cookies:
    print("No twitter/x.com cookies found in source")
    exit(1)

print(f"Found {len(src_cookies)} twitter/x.com cookies in source Chrome")

# Open or create destination cookies DB
dst_conn = sqlite3.connect(dst)
try:
    # Try to get existing table info
    dst_conn.execute("SELECT * FROM cookies LIMIT 0")
except:
    # Create table if it doesn't exist - copy schema from source
    src_tmp = sqlite3.connect('${srcCookies}')
    schema = src_tmp.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='cookies'").fetchone()
    src_tmp.close()
    if schema:
        dst_conn.execute(schema[0])
        dst_conn.commit()

# Delete old twitter cookies in destination
dst_conn.execute("DELETE FROM cookies WHERE host_key LIKE '%x.com%' OR host_key LIKE '%twitter.com%'")

# Insert new cookies
placeholders = ','.join(['?' for _ in col_names])
dst_conn.executemany(f"INSERT INTO cookies ({','.join(col_names)}) VALUES ({placeholders})", src_cookies)
dst_conn.commit()
dst_conn.close()
print(f"Synced {len(src_cookies)} cookies to headless profile")
`;

    execSync(`python3 -c ${JSON.stringify(pythonScript)}`, {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('✅ Cookie 数据库已同步');

    // Kill existing headless chrome so LaunchAgent restarts it
    try {
      execSync('pkill -f "chrome.*headless.*chrome-cdp-profile"', {
        timeout: 5000,
        stdio: 'pipe',
      });
      console.log('🔄 已终止旧 headless Chrome，等待重启...');
    } catch {
      // Process might not exist, that's ok
      console.log('ℹ️ 未找到运行中的 headless Chrome 进程');
    }

    // Wait for CDP to come back (LaunchAgent auto-restart)
    const recovered = await waitForCdp(HEADLESS_PORT, 20000);
    if (!recovered) {
      // Try launching manually
      console.log('⚠️ LaunchAgent 未自动重启，手动启动 headless Chrome...');
      await launchHeadless();
    }
    console.log('✅ Headless Chrome 已恢复');
    return true;
  } catch (err) {
    console.error(`❌ Cookie 同步失败: ${err.message}`);
    return false;
  }
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
  let rawTweets = await scrapeListFeed(activeCdpPort);

  if (!rawTweets || rawTweets.length === 0) {
    // Check if login expired (cookie issue)
    const loginExpired = await checkLoginExpired(activeCdpPort);
    if (loginExpired) {
      console.error('❌ Twitter 登录态已过期！尝试自动同步 cookie...');
      const synced = await syncCookiesFromMainChrome();
      if (synced) {
        console.log('🔄 Cookie 已同步，重新尝试抓取...');
        const retryTweets = await scrapeListFeed(activeCdpPort);
        if (retryTweets && retryTweets.length > 0) {
          rawTweets = retryTweets; // fall through to normal flow
        }
      }
    }
    if (!rawTweets || rawTweets.length === 0) {
      console.log('⚠️ 未获取到推文，跳过报告生成');
      return;
    }
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

  // 6. 生成报告（带 daily-job 层重试：失败后 30s 重试一次）
  console.log(`🤖 正在用 ${config.openrouter.model} 生成报告...\n`);
  let report;
  try {
    try {
      report = await generateReport(tweetsData, new Date(), youtubePodcasts);
    } catch (firstErr) {
      console.warn(`⚠️ 报告生成第 1 次失败: ${firstErr.message}，30s 后重试...`);
      await new Promise(r => setTimeout(r, 30000));
      report = await generateReport(tweetsData, new Date(), youtubePodcasts);
    }
  } catch (finalErr) {
    console.error(`❌ 报告生成最终失败，跳过后续步骤（PDF/通知）`);
    console.error(`   错误: ${finalErr.message}`);
    
    // 判断错误类型给出修复建议
    let suggestion = '请检查日志并手动重跑: cd ~/Documents/Projects/twitter-digest && npm run daily';
    if (/overload|529/i.test(finalErr.message)) {
      suggestion = 'API 过载，稍后手动重跑或等明天自动重试';
    } else if (/timeout|abort/i.test(finalErr.message)) {
      suggestion = '请求超时，可能是网络问题或模型响应过慢，稍后重试';
    } else if (/401|auth/i.test(finalErr.message)) {
      suggestion = 'API Key 可能失效，检查 .env 里的 OPENROUTER_API_KEY';
    } else if (/429|rate/i.test(finalErr.message)) {
      suggestion = 'API 限流，等 10 分钟后手动重跑';
    } else if (/JSON|parse/i.test(finalErr.message)) {
      suggestion = 'API 返回异常数据，可能是临时问题，稍后重试';
    }
    
    await notifyFailure(finalErr.message, suggestion);
    
    console.log('\n⚠️ 日报生成未完成（报告生成失败），原始数据已保存。');
    return;
  }

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
}).catch(async (err) => {
  console.error('❌ 执行失败:', err);
  
  let suggestion = '请检查日志：cat /tmp/twitter-digest-stdout.log';
  if (/CDP|Chrome|headless/i.test(err.message)) {
    suggestion = 'Chrome CDP 不可用，需要重新配置浏览器连接';
  }
  
  await notifyFailure(err.message, suggestion).catch(() => {});
  process.exit(1);
});
