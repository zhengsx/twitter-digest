/**
 * Twitter Snowflake ID 时间工具
 * 
 * Twitter ID 是 snowflake ID，高 41 位是毫秒时间戳（从 Twitter epoch 起）
 * 可以直接从 ID 计算出推文发布时间，不需要解析页面上的时间字符串
 */

// Twitter epoch: 2010-11-04 01:42:54.657 UTC
const TWITTER_EPOCH = 1288834974657n;

/**
 * 从 Tweet ID 计算发布时间
 * @param {string} tweetId - 推文 ID
 * @returns {Date|null} 发布时间
 */
export function getTweetTimeFromId(tweetId) {
  if (!tweetId) return null;
  
  try {
    const id = BigInt(tweetId);
    const timestamp = (id >> 22n) + TWITTER_EPOCH;
    return new Date(Number(timestamp));
  } catch (error) {
    console.error(`无法解析 tweet ID: ${tweetId}`, error.message);
    return null;
  }
}

/**
 * 判断推文是否在指定时间范围内
 * @param {string} tweetId - 推文 ID
 * @param {number} hoursAgo - 多少小时前（默认 24）
 * @param {Date} now - 当前时间
 * @returns {boolean}
 */
export function isTweetWithinHours(tweetId, hoursAgo = 24, now = new Date()) {
  const tweetTime = getTweetTimeFromId(tweetId);
  if (!tweetTime) return false;
  
  const cutoff = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
  return tweetTime >= cutoff;
}

/**
 * 格式化推文时间为可读字符串
 * @param {string} tweetId - 推文 ID
 * @param {Date} now - 当前时间
 * @returns {string}
 */
export function formatTweetTime(tweetId, now = new Date()) {
  const tweetTime = getTweetTimeFromId(tweetId);
  if (!tweetTime) return 'unknown';
  
  const diffMs = now - tweetTime;
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return tweetTime.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });
}

/**
 * 过滤推文：只保留指定时间范围内的推文
 * @param {Array} tweets - 推文数组（需要有 tweetId 字段）
 * @param {number} hoursAgo - 保留多少小时内的推文
 * @param {Date} now - 当前时间
 * @returns {Object} { filtered, stats }
 */
export function filterTweetsByTime(tweets, hoursAgo = 24, now = new Date()) {
  const cutoff = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
  
  const stats = {
    total: tweets.length,
    kept: 0,
    filtered: 0,
    noId: 0,
    newestTime: null,
    oldestKeptTime: null,
  };
  
  const filtered = tweets.filter(tweet => {
    if (!tweet.tweetId) {
      stats.noId++;
      return true; // 保守保留
    }
    
    const tweetTime = getTweetTimeFromId(tweet.tweetId);
    if (!tweetTime) {
      stats.noId++;
      return true;
    }
    
    // 记录最新时间
    if (!stats.newestTime || tweetTime > stats.newestTime) {
      stats.newestTime = tweetTime;
    }
    
    if (tweetTime >= cutoff) {
      stats.kept++;
      if (!stats.oldestKeptTime || tweetTime < stats.oldestKeptTime) {
        stats.oldestKeptTime = tweetTime;
      }
      // 附加解析后的时间到推文对象
      tweet.parsedTime = tweetTime;
      tweet.timeAgo = formatTweetTime(tweet.tweetId, now);
      return true;
    }
    
    stats.filtered++;
    return false;
  });
  
  return { filtered, stats };
}
