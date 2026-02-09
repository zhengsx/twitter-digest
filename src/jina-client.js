import fetch from 'node-fetch';
import { config } from './config.js';
import { filterRecentTweets, formatTimeAgo, parseTweetTime } from './time-filter.js';
import { extractTimestamp } from './snowflake.js';

/**
 * 使用 Jina Reader API 获取用户时间线
 * @param {string} username - Twitter 用户名 (不含 @)
 * @returns {Promise<Object>} 用户信息和推文
 */
export async function getUserTimeline(username) {
  const url = `https://r.jina.ai/https://x.com/${username}`;
  
  console.log(`📥 通过 Jina API 获取 @${username} 的时间线...`);
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.jina.apiKey}`,
        'X-Return-Format': 'markdown',
        'X-With-Generated-Alt': 'true',
        'X-No-Cache': 'true',
        'X-Timeout': '30',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Jina API 错误: ${response.status} ${response.statusText}`);
    }
    
    const markdown = await response.text();
    const data = parseTwitterMarkdown(username, markdown);
    warnIfAllTweetsOlderThanDays(username, data.tweets, 7, new Date(data.fetchedAt));
    return data;
  } catch (error) {
    console.error(`获取 @${username} 时间线失败:`, error.message);
    throw error;
  }
}

/**
 * 使用 Jina Search API 搜索推文
 * @param {string} query - 搜索关键词
 * @returns {Promise<Array>} 搜索结果
 */
export async function searchTweets(query) {
  const url = `https://s.jina.ai/?q=site:twitter.com+${encodeURIComponent(query)}`;
  
  console.log(`🔍 搜索推文: ${query}`);
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.jina.apiKey}`,
        'X-Return-Format': 'markdown',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Jina Search API 错误: ${response.status} ${response.statusText}`);
    }
    
    const markdown = await response.text();
    return parseSearchResults(markdown);
  } catch (error) {
    console.error(`搜索失败:`, error.message);
    return [];
  }
}

/**
 * 解析 Jina 返回的 Twitter 页面 markdown
 * @param {string} username 
 * @param {string} markdown 
 * @returns {Object}
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
  
  // 提取 followers 数 (233.8M Followers)
  const followersMatch = markdown.match(/\[([\d.,]+[KkMm]?)\s*Followers\]/i) || 
                         markdown.match(/([\d.,]+[KkMm]?)\s*Followers/i);
  if (followersMatch) {
    userInfo.followers = parseFollowerCount(followersMatch[1]);
  }
  
  // 新的解析策略：查找推文链接模式
  // Twitter 页面中每条推文都有类似 [10h](https://x.com/elonmusk/status/xxx) 
  // 或 [Apr 25, 2022](https://x.com/elonmusk/status/xxx) 的格式
  const tweetPattern = /\[(\d+[hms]|[A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)\]\((https:\/\/x\.com\/\w+\/status\/\d+)\)/g;
  const tweetMatches = [...markdown.matchAll(tweetPattern)];
  
  // 对于每个匹配，向后查找推文内容
  for (let i = 0; i < tweetMatches.length; i++) {
    const match = tweetMatches[i];
    const timeStr = match[1];
    const tweetUrl = match[2];
    const matchIndex = match.index;
    
    // 找到下一个推文的位置（或文件末尾）
    const nextMatch = tweetMatches[i + 1];
    const endIndex = nextMatch ? nextMatch.index : markdown.length;
    
    // 提取这个范围内的内容
    const tweetSection = markdown.slice(matchIndex, endIndex);
    
    // 解析推文内容
    const tweet = parseTweetSection(tweetSection, timeStr, tweetUrl, username);
    if (tweet) {
      tweets.push(tweet);
    }
  }
  
  // 如果没有找到标准格式，尝试备用解析
  if (tweets.length === 0) {
    const backupTweets = parseBackupMethod(markdown, username);
    tweets.push(...backupTweets);
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
    rawMarkdown: markdown,
    fetchedAt: new Date().toISOString(),
  };
}

function warnIfAllTweetsOlderThanDays(username, tweets, days, fetchedAt) {
  if (!tweets || tweets.length === 0) return;
  
  const now = fetchedAt instanceof Date ? fetchedAt : new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const parsedTimes = tweets
    .map(tweet => parseTweetTime(tweet.time, now))
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
  const snowflakeMs = tweetId ? extractTimestamp(tweetId) : null;
  const snowflakeTime = snowflakeMs !== null ? new Date(snowflakeMs) : null;

  // 移除链接和图片标记
  let text = section
    .replace(/\[!\[Image[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '') // 嵌套图片链接
    .replace(/!\[Image[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ') // 其他链接
    .replace(/^\s*[-=]+\s*$/gm, '') // 分隔线
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  // 提取主要文本内容（跳过用户名行）
  const lines = text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // 跳过用户名行
    if (/^@\w+$/.test(trimmed)) return false;
    if (/^·$/.test(trimmed)) return false;
    // 跳过菜单项
    if (/^(Show|Quote|Reply|Repost|Like|Bookmark|Share|More)$/i.test(trimmed)) return false;
    return true;
  });
  
  // 合并行
  let cleanText = lines.join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // 提取互动数据
  const likes = extractNumber(section, /([\d.]+[KkMm]?)\s*$/m) || 0;
  
  // 检测类型
  const isReply = /Replying to/i.test(section);
  const isRetweet = /reposted$/im.test(section) || section.includes('Reposted');
  const isQuote = /Quote$/im.test(section);
  
  // 清理掉不需要的内容
  cleanText = cleanText
    .replace(/Show more/gi, '')
    .replace(/Replying to @\w+/gi, '')
    .replace(/\d+[KkMm]?\s*$/g, '') // 移除末尾数字
    .trim();
  
  // 过滤太短或无意义的内容
  if (cleanText.length < 15) return null;
  if (/^(Elon Musk|@\w+|Posts|Replies|Highlights|Media)$/i.test(cleanText)) return null;
  
  const originalText = cleanText;

  return {
    username: currentUser,
    text: cleanText.slice(0, 500),
    originalText,
    url: normalizedUrl,
    tweetId,
    snowflakeTime,
    time: timeStr,
    likes: 0,
    retweets: 0,
    replies: 0,
    isReply,
    isRetweet,
    isQuote,
  };
}

/**
 * 备用解析方法
 */
function parseBackupMethod(markdown, username) {
  const tweets = [];
  
  // 查找 "posts" 标题后的内容
  const postsMatch = markdown.match(/posts\s*=+\s*([\s\S]*?)(?=\n=+|$)/i);
  if (!postsMatch) return tweets;
  
  const postsSection = postsMatch[1];
  
  // 按分隔符分割
  const sections = postsSection.split(/\n(?=\[!\[)/);
  
  for (const section of sections) {
    if (section.trim().length < 50) continue;
    
    const tweet = extractTweetFromParagraph(section, username);
    if (tweet) {
      tweets.push(tweet);
    }
  }
  
  return tweets;
}

/**
 * 从段落中提取推文
 */
function extractTweetFromParagraph(paragraph, currentUser) {
  const text = paragraph.trim();
  
  // 过滤掉明显不是推文的内容
  if (text.length < 10) return null;
  if (/^(Sign up|Log in|What['']s happening)/i.test(text)) return null;
  if (/^https?:\/\//.test(text) && text.split('\n').length === 1) return null;
  
  const urlMatch = text.match(/https:\/\/(?:twitter|x)\.com\/(\w+)\/status\/(\d+)/);
  const tweetId = urlMatch ? urlMatch[2] : null;
  const urlUsername = urlMatch ? urlMatch[1] : currentUser;
  const normalizedUrl = tweetId
    ? `https://x.com/${urlUsername}/status/${tweetId}`
    : null;
  const snowflakeMs = tweetId ? extractTimestamp(tweetId) : null;
  const snowflakeTime = snowflakeMs !== null ? new Date(snowflakeMs) : null;

  // 检测是否是转推
  const isRetweet = /^.*reposted$/im.test(text) || /^RT @/i.test(text);
  
  // 检测是否是回复
  const isReply = /^Replying to @/i.test(text) || text.includes('·') && text.includes('Replying to');
  
  // 提取互动数据
  const likes = extractNumber(text, /([\d.]+[KkMm]?)\s*(likes?|❤)/i);
  const retweets = extractNumber(text, /([\d.]+[KkMm]?)\s*(retweets?|reposts?|🔁)/i);
  const replies = extractNumber(text, /([\d.]+[KkMm]?)\s*(replies|comments?|💬)/i);
  
  // 清理推文文本
  let cleanText = text
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([\d.]+[KkMm]?)\s*(likes?|retweets?|reposts?|replies|views?|impressions?)/gi, '')
    .replace(/·\s*\d+[hms]/g, '')
    .replace(/Show more/gi, '')
    .trim();
  
  if (cleanText.length < 10) return null;
  
  const originalText = cleanText;

  return {
    username: currentUser,
    text: cleanText.slice(0, 500),
    originalText,
    url: normalizedUrl,
    tweetId,
    snowflakeTime,
    likes,
    retweets,
    replies,
    isReply,
    isRetweet,
    isQuote: false,
  };
}

/**
 * 从文本中提取数字
 */
function extractNumber(text, pattern) {
  const match = text.match(pattern);
  if (!match) return 0;
  return parseFollowerCount(match[1]);
}

/**
 * 解析带 K/M 后缀的数字
 */
function parseFollowerCount(str) {
  const num = parseFloat(str.replace(/,/g, ''));
  if (isNaN(num)) return 0;
  if (/[Kk]$/i.test(str)) return Math.round(num * 1000);
  if (/[Mm]$/i.test(str)) return Math.round(num * 1000000);
  return Math.round(num);
}

/**
 * 解析搜索结果
 */
function parseSearchResults(markdown) {
  const results = [];
  const sections = markdown.split(/---+/);
  
  for (const section of sections) {
    const urlMatch = section.match(/https:\/\/(?:twitter|x)\.com\/\w+\/status\/\d+/);
    if (urlMatch) {
      const tweetId = extractTweetIdFromUrl(urlMatch[0]);
      results.push({
        url: urlMatch[0],
        tweetId,
        content: section.trim().slice(0, 500),
      });
    }
  }
  
  return results;
}

function extractTweetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * 批量获取多个用户的推文
 * @param {Array<string>} usernames - 用户名列表
 * @param {Object} options - 选项
 * @param {number} options.hoursAgo - 只保留多少小时内的推文（默认 24）
 * @param {boolean} options.filterTime - 是否启用时间过滤（默认 true）
 * @returns {Promise<Array>}
 */
export async function fetchAllUserTimelines(usernames, options = {}) {
  const { hoursAgo = 24, filterTime = true } = options;
  const allData = [];
  
  let totalFiltered = 0;
  let totalKept = 0;
  let usersWithNoRecent = [];
  
  for (const username of usernames) {
    try {
      const data = await getUserTimeline(username);
      const fetchedAt = new Date(data.fetchedAt);
      
      if (data.tweets.length === 0) {
        console.log(`   - @${username}: 无推文`);
        continue;
      }
      
      // 应用时间过滤（强制启用：避免旧推文混入日报）
      if (filterTime === false) {
        console.log(`⚠️  fetchAllUserTimelines(): filterTime=false 已废弃，仍会强制过滤旧推文`);
      }
      {
        const { filtered, stats } = filterRecentTweets(data.tweets, hoursAgo, fetchedAt, { username });
        
        totalFiltered += stats.filtered;
        totalKept += stats.kept;
        
        if (filtered.length > 0) {
          data.tweets = filtered;
          data.filterStats = stats;
          allData.push(data);
          
          const timeRange = stats.newestKept 
            ? `(最新: ${formatTimeAgo(stats.newestKept)})` 
            : '';
          console.log(`   ✓ @${username}: ${stats.kept}/${stats.total} 条近期推文 ${timeRange}`);
        } else {
          usersWithNoRecent.push(username);
          console.log(`   ⏭ @${username}: 无近 ${hoursAgo}h 推文 (共 ${stats.total} 条旧推文)`);
        }
      }
    } catch (error) {
      console.log(`   ✗ @${username}: 失败 - ${error.message}`);
    }
    
    // 避免请求过快
    await sleep(2000);
  }
  
  // 汇总统计
  console.log(`\n📊 时间过滤统计:`);
  console.log(`   ✓ 保留: ${totalKept} 条 (${hoursAgo}h 内)`);
  console.log(`   ✗ 过滤: ${totalFiltered} 条 (旧推文/无法解析时间)`);
  if (usersWithNoRecent.length > 0) {
    console.log(`   ⏭ 无新内容用户: ${usersWithNoRecent.length} 个`);
  }
  
  return allData;
}

/**
 * 从硬编码列表获取关注用户
 * 由于 Jina 无法直接获取关注列表，需要预先配置
 */
export async function getFollowingList() {
  // 从配置中读取，或使用默认列表
  const users = config.followingUsers || [];
  
  if (users.length === 0) {
    console.log('⚠️ 未配置关注用户列表，请在 .env 中设置 FOLLOWING_USERS');
    return [];
  }
  
  return users.map(username => ({
    username: username.replace(/^@/, ''),
    name: username,
    description: '',
    followers: 0,
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
