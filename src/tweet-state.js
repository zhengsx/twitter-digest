/**
 * 推文状态管理模块
 * 
 * 记录每个用户的 lastSeenTweetId，用于增量抓取
 * Twitter ID 是 snowflake ID，天然按时间递增
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'data', 'tweet-state.json');

/**
 * 状态结构:
 * {
 *   "karpathy": {
 *     "lastSeenTweetId": "1977755427569111362",
 *     "lastUpdated": "2026-02-05T08:00:00Z"
 *   },
 *   ...
 * }
 */

/**
 * 加载推文状态
 * @returns {Promise<Object>}
 */
export async function loadTweetState() {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 文件不存在，返回空状态
      return {};
    }
    console.error('加载推文状态失败:', error.message);
    return {};
  }
}

/**
 * 保存推文状态
 * @param {Object} state
 */
export async function saveTweetState(state) {
  try {
    // 确保目录存在
    const dir = path.dirname(STATE_FILE);
    await fs.mkdir(dir, { recursive: true });
    
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`💾 推文状态已保存: ${STATE_FILE}`);
  } catch (error) {
    console.error('保存推文状态失败:', error.message);
  }
}

/**
 * 获取用户的 lastSeenTweetId
 * @param {Object} state
 * @param {string} username
 * @returns {string|null}
 */
export function getLastSeenTweetId(state, username) {
  const userState = state[username.toLowerCase()];
  return userState?.lastSeenTweetId || null;
}

/**
 * 更新用户的 lastSeenTweetId
 * @param {Object} state
 * @param {string} username
 * @param {string} tweetId
 */
export function updateLastSeenTweetId(state, username, tweetId) {
  const key = username.toLowerCase();
  state[key] = {
    lastSeenTweetId: tweetId,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 比较两个 tweet ID，判断 id1 是否比 id2 新
 * Twitter snowflake ID 是递增的，数值越大越新
 * 
 * @param {string} id1
 * @param {string} id2
 * @returns {boolean} id1 > id2 (id1 更新)
 */
export function isNewerTweetId(id1, id2) {
  if (!id1 || !id2) return false;
  
  // 直接比较字符串长度+字典序（snowflake ID 长度固定时可行）
  // 更安全的做法是用 BigInt
  try {
    return BigInt(id1) > BigInt(id2);
  } catch {
    // 如果转换失败，回退到字符串比较
    return id1 > id2;
  }
}

/**
 * 过滤推文：只保留比 lastSeenTweetId 更新的推文
 * 
 * @param {Array} tweets - 推文数组（假设按时间倒序，最新在前）
 * @param {string|null} lastSeenTweetId - 上次看到的最新推文 ID
 * @returns {Object} { newTweets, newestTweetId, stats }
 */
export function filterNewTweets(tweets, lastSeenTweetId) {
  const stats = {
    total: tweets.length,
    new: 0,
    skipped: 0,
    noId: 0,
  };
  
  const newTweets = [];
  let newestTweetId = null;
  let encounteredOld = false;
  
  for (const tweet of tweets) {
    // 如果没有 tweetId，保守保留
    if (!tweet.tweetId) {
      stats.noId++;
      newTweets.push(tweet);
      continue;
    }
    
    // 记录最新的 tweetId
    if (!newestTweetId || isNewerTweetId(tweet.tweetId, newestTweetId)) {
      newestTweetId = tweet.tweetId;
    }
    
    // 如果没有 lastSeenTweetId，全部保留
    if (!lastSeenTweetId) {
      stats.new++;
      newTweets.push(tweet);
      continue;
    }
    
    // 比较：如果当前推文比上次看到的新，保留
    if (isNewerTweetId(tweet.tweetId, lastSeenTweetId)) {
      stats.new++;
      newTweets.push(tweet);
    } else {
      // 遇到旧推文，可以提前终止（因为是按时间倒序的）
      stats.skipped++;
      if (!encounteredOld) {
        encounteredOld = true;
        // 继续处理一下，确保不漏（有时候顺序不完全严格）
      }
    }
  }
  
  return { newTweets, newestTweetId, stats };
}

/**
 * 批量更新状态
 * 
 * @param {Object} state - 当前状态
 * @param {Array} results - [{username, newestTweetId}, ...]
 */
export function batchUpdateState(state, results) {
  for (const { username, newestTweetId } of results) {
    if (newestTweetId) {
      updateLastSeenTweetId(state, username, newestTweetId);
    }
  }
}
