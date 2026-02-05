import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { filterRecentTweets, formatTimeAgo } from './time-filter.js';
import { 
  loadTweetState, 
  saveTweetState, 
  getLastSeenTweetId, 
  filterNewTweets,
  batchUpdateState 
} from './tweet-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const reportsDir = path.join(__dirname, '..', 'reports');

// 时间过滤配置
const FILTER_HOURS = 24; // 只保留最近 24 小时的推文
// 是否使用 tweetId 增量模式（推荐）
const USE_TWEET_ID_MODE = true;

// 配置
const JINA_API_KEY = 'jina_422c9ce559de4c519e827233cdcd90a0E22LcYJzishlFevVhkXkuuHXS_0G';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// 用户列表
const USERS = [
  'LiorOnAI', 'cjpedregal', 'steph_palazzolo', 'gdb', 'indigox',
  'borgeaud_s', 'dwarkesh_sp', '_The_Prophet__', 'gregisenberg',
  'omarsar0', 'onechancefreedm', 'akshay_pachaar', 'dair_ai',
  'rasbt', 'chetaslua', 'Thom_Wolf', 'soumithchintala', 'mattshumer_',
  'emollick', 'michaeljburry', 'JeffDean', 'EpochAIResearch', 'METR_Evals'
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseFollowerCount(str) {
  if (!str) return 0;
  const num = parseFloat(str.replace(/,/g, ''));
  if (isNaN(num)) return 0;
  if (/[Kk]$/i.test(str)) return Math.round(num * 1000);
  if (/[Mm]$/i.test(str)) return Math.round(num * 1000000);
  return Math.round(num);
}

function extractTweetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * 使用 Jina Reader API 获取用户时间线
 */
async function getUserTimeline(username) {
  const url = `https://r.jina.ai/https://x.com/${username}`;
  
  console.log(`📥 获取 @${username}...`);
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${JINA_API_KEY}`,
      'X-Return-Format': 'markdown',
      'X-With-Generated-Alt': 'true',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Jina API 错误: ${response.status}`);
  }
  
  const markdown = await response.text();
  return parseTwitterMarkdown(username, markdown);
}

/**
 * 解析 Markdown 为结构化推文数据
 */
function parseTwitterMarkdown(username, markdown) {
  const tweets = [];
  
  // 提取用户信息
  let userInfo = {
    username: username,
    name: username,
    description: '',
    followers: 0,
  };
  
  // 提取 followers 数
  const followersMatch = markdown.match(/\[([\d.,]+[KkMm]?)\s*Followers\]/i) || 
                         markdown.match(/([\d.,]+[KkMm]?)\s*Followers/i);
  if (followersMatch) {
    userInfo.followers = parseFollowerCount(followersMatch[1]);
  }
  
  // 查找推文链接模式
  const tweetPattern = /\[(\d+[hms]|[A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)\]\((https:\/\/x\.com\/\w+\/status\/\d+)\)/g;
  const tweetMatches = [...markdown.matchAll(tweetPattern)];
  
  for (let i = 0; i < tweetMatches.length; i++) {
    const match = tweetMatches[i];
    const timeStr = match[1];
    const tweetUrl = match[2];
    const matchIndex = match.index;
    
    const nextMatch = tweetMatches[i + 1];
    const endIndex = nextMatch ? nextMatch.index : markdown.length;
    
    const tweetSection = markdown.slice(matchIndex, endIndex);
    
    const tweet = parseTweetSection(tweetSection, timeStr, tweetUrl, username);
    if (tweet) {
      tweets.push(tweet);
    }
  }
  
  // 去重
  const seen = new Set();
  const uniqueTweets = tweets.filter(t => {
    const key = t.text.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  return {
    user: userInfo,
    tweets: uniqueTweets,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 解析单条推文区块
 */
function parseTweetSection(section, timeStr, tweetUrl, currentUser) {
  const tweetId = extractTweetIdFromUrl(tweetUrl);
  const normalizedUrl = tweetId
    ? `https://x.com/${currentUser}/status/${tweetId}`
    : tweetUrl;

  // 清理文本
  let text = section
    .replace(/\[!\[Image[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[Image[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^\s*[-=]+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  const lines = text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^@\w+$/.test(trimmed)) return false;
    if (/^·$/.test(trimmed)) return false;
    if (/^(Show|Quote|Reply|Repost|Like|Bookmark|Share|More)$/i.test(trimmed)) return false;
    return true;
  });
  
  let cleanText = lines.join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const isReply = /Replying to/i.test(section);
  const isRetweet = /reposted$/im.test(section) || section.includes('Reposted');
  const isQuote = /Quote$/im.test(section);
  
  cleanText = cleanText
    .replace(/Show more/gi, '')
    .replace(/Replying to @\w+/gi, '')
    .replace(/\d+[KkMm]?\s*$/g, '')
    .trim();
  
  if (cleanText.length < 15) return null;
  if (/^(Elon Musk|@\w+|Posts|Replies|Highlights|Media)$/i.test(cleanText)) return null;
  
  return {
    text: cleanText.slice(0, 500),
    originalText: cleanText,
    url: normalizedUrl,
    tweetId,
    time: timeStr,
    isReply,
    isRetweet,
    isQuote,
  };
}

/**
 * 获取所有用户推文 (支持 tweetId 增量模式 + 时间过滤)
 */
async function fetchAllUsers() {
  const allData = [];
  const failed = [];
  const noRecentTweets = [];
  const stateUpdates = []; // 记录需要更新的状态
  
  let totalFiltered = 0;
  let totalKept = 0;
  let totalSkippedById = 0;
  
  // 加载上次的推文状态
  const tweetState = USE_TWEET_ID_MODE ? await loadTweetState() : {};
  
  for (let i = 0; i < USERS.length; i++) {
    const username = USERS[i];
    try {
      const data = await getUserTimeline(username);
      const fetchedAt = new Date(data.fetchedAt);
      
      if (data.tweets.length === 0) {
        console.log(`   - @${username}: 无推文`);
        continue;
      }
      
      let filteredTweets = data.tweets;
      let newestTweetId = null;
      
      // 模式1: 使用 tweetId 增量过滤（优先）
      if (USE_TWEET_ID_MODE) {
        const lastSeenId = getLastSeenTweetId(tweetState, username);
        const idResult = filterNewTweets(data.tweets, lastSeenId);
        
        filteredTweets = idResult.newTweets;
        newestTweetId = idResult.newestTweetId;
        totalSkippedById += idResult.stats.skipped;
        
        if (lastSeenId) {
          console.log(`   🔖 @${username}: lastSeen=${lastSeenId.slice(-8)}... 新增=${idResult.stats.new} 跳过=${idResult.stats.skipped}`);
        }
        
        // 记录更新
        if (newestTweetId) {
          stateUpdates.push({ username, newestTweetId });
        }
      }
      
      // 模式2: 时间过滤（作为兜底或额外过滤）
      const { filtered, stats } = filterRecentTweets(filteredTweets, FILTER_HOURS, fetchedAt);
      
      totalFiltered += stats.filtered;
      totalKept += stats.kept;
      
      if (filtered.length > 0) {
        data.tweets = filtered;
        data.filterStats = stats;
        data.newestTweetId = newestTweetId;
        allData.push(data);
        
        const timeRange = stats.newestKept 
          ? `(最新: ${formatTimeAgo(stats.newestKept)})` 
          : '';
        console.log(`   ✓ @${username}: ${stats.kept}/${stats.total} 条近期推文 ${timeRange}`);
      } else {
        noRecentTweets.push(username);
        console.log(`   ⏭ @${username}: 无近 ${FILTER_HOURS}h 推文 (共 ${stats.total} 条旧推文)`);
      }
    } catch (error) {
      console.log(`   ✗ @${username}: 失败 - ${error.message}`);
      failed.push(username);
    }
    
    // 进度汇报
    if ((i + 1) % 5 === 0) {
      console.log(`   📊 进度: ${i + 1}/${USERS.length}`);
    }
    
    // 避免请求过快
    await sleep(2000);
  }
  
  // 更新并保存推文状态
  if (USE_TWEET_ID_MODE && stateUpdates.length > 0) {
    batchUpdateState(tweetState, stateUpdates);
    await saveTweetState(tweetState);
  }
  
  console.log(`\n📈 爬取完成: ${allData.length}/${USERS.length} 个用户有新内容`);
  console.log(`📊 过滤统计:`);
  if (USE_TWEET_ID_MODE) {
    console.log(`   🔖 ID跳过: ${totalSkippedById} 条 (已处理过的旧推文)`);
  }
  console.log(`   ✓ 保留: ${totalKept} 条 (${FILTER_HOURS}h 内)`);
  console.log(`   ✗ 时间过滤: ${totalFiltered} 条 (旧推文)`);
  
  if (noRecentTweets.length > 0) {
    console.log(`   ⏭ 无新内容: ${noRecentTweets.length} 个用户`);
  }
  if (failed.length > 0) {
    console.log(`   ❌ 失败: ${failed.join(', ')}`);
  }
  
  return allData;
}

/**
 * 生成 Markdown 报告
 */
function generateMarkdownReport(tweetsData, dateStr) {
  const lines = [];
  
  lines.push(`# Twitter 信源日报 - ${dateStr}\n`);
  lines.push(`> 信源数: ${tweetsData.length} | 时间范围: 过去 ${FILTER_HOURS} 小时 | 生成时间: ${new Date().toISOString()}\n`);
  lines.push('---\n');
  
  // 概览
  lines.push('## 📊 今日概览\n');
  let totalTweets = 0;
  for (const data of tweetsData) {
    const originalCount = data.tweets.filter(t => !t.isReply && !t.isRetweet).length;
    totalTweets += data.tweets.length;
    lines.push(`- **@${data.user.username}**: ${originalCount} 条原创 / ${data.tweets.length} 条总推文`);
  }
  lines.push(`\n**总计: ${totalTweets} 条推文**\n`);
  lines.push('---\n');
  
  // 各用户推文详情
  lines.push('## 📝 推文详情\n');
  
  for (const data of tweetsData) {
    const { user, tweets } = data;
    const originalTweets = tweets.filter(t => !t.isReply && !t.isRetweet);
    
    if (originalTweets.length === 0) continue;
    
    lines.push(`### @${user.username}\n`);
    if (user.followers > 0) {
      const followersStr = user.followers >= 1000000 
        ? `${(user.followers / 1000000).toFixed(1)}M`
        : user.followers >= 1000 
          ? `${(user.followers / 1000).toFixed(1)}K`
          : `${user.followers}`;
      lines.push(`*${followersStr} followers*\n`);
    }
    
    for (const tweet of originalTweets.slice(0, 10)) {
      lines.push(`**原文:** ${tweet.originalText}\n`);
      lines.push(`**链接:** ${tweet.url}\n`);
      lines.push(`**时间:** ${tweet.time}\n`);
      lines.push('');
    }
    
    lines.push('---\n');
  }
  
  return lines.join('\n');
}

/**
 * 使用 pandoc 转换为 PDF
 */
async function convertToPDF(markdownPath, pdfPath) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    // 尝试使用 pandoc
    await execAsync(`pandoc "${markdownPath}" -o "${pdfPath}" --pdf-engine=xelatex -V mainfont="PingFang SC" -V geometry:margin=1in`);
    console.log(`✓ PDF 生成成功: ${pdfPath}`);
    return true;
  } catch (e1) {
    console.log('pandoc 转换失败，尝试 wkhtmltopdf...');
    try {
      // 先转成 HTML
      const htmlPath = markdownPath.replace('.md', '.html');
      await execAsync(`pandoc "${markdownPath}" -o "${htmlPath}"`);
      await execAsync(`wkhtmltopdf "${htmlPath}" "${pdfPath}"`);
      console.log(`✓ PDF 生成成功: ${pdfPath}`);
      return true;
    } catch (e2) {
      console.log('wkhtmltopdf 也失败，使用 markdown 输出');
      return false;
    }
  }
}

// 主程序
async function main() {
  console.log('🚀 开始获取 Twitter 推文...\n');
  
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  
  // 确保目录存在
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  
  // 获取所有用户推文
  const tweetsData = await fetchAllUsers();
  
  if (tweetsData.length === 0) {
    console.log('❌ 没有获取到任何数据');
    process.exit(1);
  }
  
  // 保存原始数据
  const dataPath = path.join(dataDir, `tweets-${dateStr}-v2.json`);
  await fs.writeFile(dataPath, JSON.stringify(tweetsData, null, 2));
  console.log(`\n💾 数据已保存: ${dataPath}`);
  
  // 生成 Markdown 报告
  const mdReport = generateMarkdownReport(tweetsData, dateStr);
  const mdPath = path.join(reportsDir, `twitter-daily-report-${dateStr}-v2.md`);
  await fs.writeFile(mdPath, mdReport);
  console.log(`📄 Markdown 报告: ${mdPath}`);
  
  // 转换为 PDF
  const pdfPath = path.join(reportsDir, `twitter-daily-report-${dateStr}-v2.pdf`);
  const pdfSuccess = await convertToPDF(mdPath, pdfPath);
  
  if (pdfSuccess) {
    console.log(`\n✅ 完成! PDF 路径: ${pdfPath}`);
  } else {
    console.log(`\n✅ 完成! Markdown 路径: ${mdPath}`);
  }
  
  return { mdPath, pdfPath: pdfSuccess ? pdfPath : null };
}

main().catch(console.error);
