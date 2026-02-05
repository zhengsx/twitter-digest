import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  loadTweetState, 
  saveTweetState, 
  getLastSeenTweetId, 
  filterNewTweets,
  batchUpdateState 
} from './tweet-state.js';
import { filterTweetsByTime, formatTweetTime, getTweetTimeFromId } from './tweet-time.js';
import { loadStoredFollowing, syncFollowingList } from './following-fetcher.js';
import { analyzeTwitterDigest } from './ai-analyzer.js';

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

// 用户列表 - 从 following-list.json 加载，或使用默认
async function loadUserList() {
  try {
    const listPath = path.join(dataDir, 'following-list.json');
    const content = await fs.readFile(listPath, 'utf-8');
    const data = JSON.parse(content);
    console.log(`📋 从 following-list.json 加载了 ${data.users.length} 个用户`);
    return data.users;
  } catch (error) {
    console.log('⚠️ 无法加载 following-list.json，使用默认用户列表');
    return DEFAULT_USERS;
  }
}

const DEFAULT_USERS = [
  'lexfridman', 'LiorOnAI', 'cjpedregal', 'steph_palazzolo', 'gdb', 'indigox',
  'borgeaud_s', 'dwarkesh_sp', '_The_Prophet__', 'gregisenberg',
  'omarsar0', 'onechancefreedm', 'akshay_pachaar', 'dair_ai',
  'rasbt', 'chetaslua', 'Thom_Wolf', 'soumithchintala', 'mattshumer_',
  'emollick', 'michaeljburry', 'JeffDean', 'EpochAIResearch', 'METR_Evals',
  'ilyasut', 'karpathy', 'OriolVinyalsML'
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
      'X-No-Cache': 'true',
      'X-Timeout': '30',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Jina API 错误: ${response.status}`);
  }
  
  const markdown = await response.text();
  const data = parseTwitterMarkdown(username, markdown);
  warnIfAllTweetsOlderThanDays(username, data.tweets, 7, new Date(data.fetchedAt));
  return data;
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
  
  // 新解析策略：直接查找所有 tweet URL，不依赖时间格式
  // 匹配 https://x.com/username/status/ID 格式
  const tweetUrlPattern = /https:\/\/x\.com\/(\w+)\/status\/(\d+)/g;
  const urlMatches = [...markdown.matchAll(tweetUrlPattern)];
  
  // 去重 URL（同一条推文可能出现多次）
  const seenUrls = new Set();
  const uniqueMatches = urlMatches.filter(match => {
    const url = match[0];
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
  
  for (let i = 0; i < uniqueMatches.length; i++) {
    const match = uniqueMatches[i];
    const tweetUrl = match[0];
    const tweetAuthor = match[1];
    const tweetId = match[2];
    const matchIndex = match.index;
    
    // 跳过其他用户的推文（引用、转发等），只保留目标用户的
    if (tweetAuthor.toLowerCase() !== username.toLowerCase()) {
      continue;
    }
    
    const nextMatch = uniqueMatches[i + 1];
    const endIndex = nextMatch ? nextMatch.index : Math.min(matchIndex + 2000, markdown.length);
    
    // 向前也取一些内容（推文文本可能在 URL 之前）
    const startIndex = Math.max(0, matchIndex - 500);
    const tweetSection = markdown.slice(startIndex, endIndex);
    
    const tweet = parseTweetSection(tweetSection, null, tweetUrl, username);
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

function warnIfAllTweetsOlderThanDays(username, tweets, days, now = new Date()) {
  if (!tweets || tweets.length === 0) return;
  
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const parsedTimes = tweets
    .map(tweet => getTweetTimeFromId(tweet.tweetId))
    .filter(Boolean);
  
  if (parsedTimes.length === 0) return;
  
  const newest = parsedTimes.reduce((a, b) => (a > b ? a : b));
  
  if (parsedTimes.every(time => time < cutoff)) {
    console.log(`⚠️  @${username}: 所有推文时间都超过 ${days} 天（最新: ${newest.toISOString().split('T')[0]}），可能是缓存数据`);
  }
}

/**
 * 解析单条推文区块
 */
function parseTweetSection(section, timeStr, tweetUrl, currentUser) {
  const tweetId = extractTweetIdFromUrl(tweetUrl);
  const normalizedUrl = tweetId
    ? `https://x.com/${currentUser}/status/${tweetId}`
    : tweetUrl;

  // 清理文本：移除 URL 本身和图片标记
  let text = section
    .replace(new RegExp(tweetUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '') // 移除当前 URL
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
async function fetchAllUsers(users) {
  const allData = [];
  const failed = [];
  const noRecentTweets = [];
  const stateUpdates = []; // 记录需要更新的状态
  
  let totalFiltered = 0;
  let totalKept = 0;
  let totalSkippedById = 0;
  
  // 加载上次的推文状态
  const tweetState = USE_TWEET_ID_MODE ? await loadTweetState() : {};
  
  for (let i = 0; i < users.length; i++) {
    const username = users[i];
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
      
      // 模式2: 用 snowflake ID 计算时间过滤（更准确！）
      const { filtered, stats } = filterTweetsByTime(filteredTweets, FILTER_HOURS);
      
      totalFiltered += stats.filtered;
      totalKept += stats.kept;
      
      if (filtered.length > 0) {
        data.tweets = filtered;
        data.filterStats = stats;
        data.newestTweetId = newestTweetId;
        allData.push(data);
        
        const timeRange = stats.newestTime 
          ? `(最新: ${formatTweetTime(newestTweetId)})` 
          : '';
        console.log(`   ✓ @${username}: ${stats.kept}/${stats.total} 条近期推文 ${timeRange}`);
      } else {
        noRecentTweets.push(username);
        const newestInfo = stats.newestTime 
          ? ` (最新: ${stats.newestTime.toISOString().split('T')[0]})`
          : '';
        console.log(`   ⏭ @${username}: 无近 ${FILTER_HOURS}h 推文 (共 ${stats.total} 条)${newestInfo}`);
      }
    } catch (error) {
      console.log(`   ✗ @${username}: 失败 - ${error.message}`);
      failed.push(username);
    }
    
    // 进度汇报
    if ((i + 1) % 5 === 0) {
      console.log(`   📊 进度: ${i + 1}/${users.length}`);
    }
    
    // 避免请求过快
    await sleep(2000);
  }
  
  // 更新并保存推文状态
  if (USE_TWEET_ID_MODE && stateUpdates.length > 0) {
    batchUpdateState(tweetState, stateUpdates);
    await saveTweetState(tweetState);
  }
  
  console.log(`\n📈 爬取完成: ${allData.length}/${users.length} 个用户有新内容`);
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
async function generateMarkdownReport(tweetsData, dateStr) {
  const lines = [];
  
  lines.push(`# Twitter 信源日报 - ${dateStr}\n`);
  lines.push(`> 信源数: ${tweetsData.length} | 时间范围: 过去 ${FILTER_HOURS} 小时 | 生成时间: ${new Date().toISOString()}\n`);
  lines.push('---\n');

  let aiAnalysis;
  try {
    aiAnalysis = await analyzeTwitterDigest(tweetsData);
  } catch (error) {
    aiAnalysis = {
      insights: [],
      technicalDetails: [],
      trends: [],
      kolOpinions: [],
      error: error.message,
    };
  }
  lines.push('## 🤖 AI 分析\n');

  lines.push('### 💡 今日 Insights\n');
  if (aiAnalysis.insights.length > 0) {
    aiAnalysis.insights.slice(0, 5).forEach((item, index) => {
      lines.push(`${index + 1}. ${item.text} [原文](${item.url})`);
    });
  } else {
    lines.push('- 暂无可用 insights（可能未配置 OPENROUTER_API_KEY 或输入数据为空）');
  }
  lines.push('');

  lines.push('### 🔧 技术细节\n');
  if (aiAnalysis.technicalDetails.length > 0) {
    aiAnalysis.technicalDetails.forEach(detail => {
      lines.push(`- ${detail}`);
    });
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  lines.push('### 📈 趋势观察\n');
  if (aiAnalysis.trends.length > 0) {
    aiAnalysis.trends.forEach(trend => {
      lines.push(`- ${trend}`);
    });
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  lines.push('### 🎯 KOL 观点\n');
  if (aiAnalysis.kolOpinions.length > 0) {
    aiAnalysis.kolOpinions.forEach(opinion => {
      lines.push(`- ${opinion.username}: ${opinion.text} [原文](${opinion.url})`);
    });
  } else {
    lines.push('- 暂无');
  }
  lines.push('\n---\n');
  
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

async function resolveUserList() {
  try {
    const result = await syncFollowingList('xxcc48764');
    if (result?.users?.length > 0) {
      const { added, removed } = result.diff || { added: [], removed: [] };
      console.log(`👥 关注列表已更新: ${result.users.length} 人`);
      if (added.length > 0 || removed.length > 0) {
        console.log(`   新增: ${added.join(', ') || '无'} | 取消关注: ${removed.join(', ') || '无'}`);
      }
      return result.users;
    }
  } catch (error) {
    console.log(`⚠️  关注列表更新失败: ${error.message}`);
  }

  const stored = await loadStoredFollowing();
  if (stored?.users?.length > 0) {
    console.log(`📁 使用本地 following.json 列表: ${stored.users.length} 人`);
    return stored.users;
  }

  console.log(`📌 使用默认硬编码列表: ${DEFAULT_USERS.length} 人`);
  return DEFAULT_USERS;
}

// 主程序
async function main() {
  console.log('🚀 开始获取 Twitter 推文...\n');
  
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  
  // 确保目录存在
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const users = await resolveUserList();
  
  // 获取所有用户推文
  const tweetsData = await fetchAllUsers(users);
  
  if (tweetsData.length === 0) {
    console.log('❌ 没有获取到任何数据');
    process.exit(1);
  }
  
  // 保存原始数据
  const dataPath = path.join(dataDir, `tweets-${dateStr}-v2.json`);
  await fs.writeFile(dataPath, JSON.stringify(tweetsData, null, 2));
  console.log(`\n💾 数据已保存: ${dataPath}`);
  
  // 生成 Markdown 报告
  const mdReport = await generateMarkdownReport(tweetsData, dateStr);
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
