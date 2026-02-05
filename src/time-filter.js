/**
 * 推文时间解析和过滤模块
 * 
 * 解析 Jina 返回的时间字符串，过滤只保留最近 24 小时的推文
 */

/**
 * 解析推文时间字符串
 * 
 * 支持格式:
 * - 相对时间: "1h", "2h", "30m", "5s", "1d"
 * - 绝对日期: "Feb 4, 2026", "Jan 25", "Feb 4"
 * 
 * @param {string} timeStr - 时间字符串
 * @param {Date} fetchedAt - 抓取时间（用于计算相对时间）
 * @returns {Date|null} 解析后的日期，无法解析返回 null
 */
export function parseTweetTime(timeStr, fetchedAt = new Date()) {
  if (!timeStr) return null;
  
  const trimmed = timeStr.trim();
  
  // 1. 相对时间格式: "1h", "2h", "30m", "5s", "1d"
  const relativeMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    
    const msPerUnit = {
      's': 1000,           // 秒
      'm': 60 * 1000,      // 分钟
      'h': 60 * 60 * 1000, // 小时
      'd': 24 * 60 * 60 * 1000, // 天
    };
    
    const ms = value * msPerUnit[unit];
    return new Date(fetchedAt.getTime() - ms);
  }
  
  // 2. 绝对日期格式: "Feb 4, 2026" 或 "Feb 4" 或 "Jan 25, 2024"
  const monthNames = {
    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
  };
  
  // 格式: "Feb 4, 2026" 或 "Feb 4"
  const absoluteMatch = trimmed.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
  if (absoluteMatch) {
    const monthStr = absoluteMatch[1].toLowerCase();
    const day = parseInt(absoluteMatch[2], 10);
    let year = absoluteMatch[3] ? parseInt(absoluteMatch[3], 10) : fetchedAt.getFullYear();
    
    const month = monthNames[monthStr];
    if (month === undefined) return null;
    
    // 如果没有年份，判断是今年还是去年
    // 如果日期在未来，说明是去年的
    if (!absoluteMatch[3]) {
      const candidateDate = new Date(year, month, day);
      if (candidateDate > fetchedAt) {
        year -= 1;
      }
    }
    
    return new Date(year, month, day, 12, 0, 0); // 设为当天中午，避免时区问题
  }
  
  return null;
}

/**
 * 判断推文是否在指定时间范围内
 * 
 * @param {Date} tweetDate - 推文日期
 * @param {number} hoursAgo - 多少小时前（默认 24）
 * @param {Date} now - 当前时间
 * @returns {boolean}
 */
export function isWithinHours(tweetDate, hoursAgo = 24, now = new Date()) {
  if (!tweetDate || !(tweetDate instanceof Date) || isNaN(tweetDate.getTime())) {
    return false;
  }
  
  const cutoff = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
  return tweetDate >= cutoff;
}

/**
 * 过滤推文列表，只保留最近 N 小时内的推文
 * 
 * @param {Array} tweets - 推文数组
 * @param {number} hoursAgo - 保留多少小时内的推文（默认 24）
 * @param {Date} fetchedAt - 抓取时间
 * @returns {Object} { filtered: 过滤后的推文, stats: 统计信息 }
 */
export function filterRecentTweets(tweets, hoursAgo = 24, fetchedAt = new Date()) {
  const now = new Date();
  const stats = {
    total: tweets.length,
    kept: 0,
    filtered: 0,
    unparseable: 0,
    oldestKept: null,
    newestKept: null,
  };
  
  const filtered = tweets.filter(tweet => {
    const tweetDate = parseTweetTime(tweet.time, fetchedAt);
    
    if (!tweetDate) {
      stats.unparseable++;
      // 无法解析时间的推文，保守起见保留
      return true;
    }
    
    // 附加解析后的时间到推文对象
    tweet.parsedTime = tweetDate;
    
    if (isWithinHours(tweetDate, hoursAgo, now)) {
      stats.kept++;
      
      if (!stats.newestKept || tweetDate > stats.newestKept) {
        stats.newestKept = tweetDate;
      }
      if (!stats.oldestKept || tweetDate < stats.oldestKept) {
        stats.oldestKept = tweetDate;
      }
      
      return true;
    }
    
    stats.filtered++;
    return false;
  });
  
  return { filtered, stats };
}

/**
 * 判断时间字符串是否表示"最近"（24小时内）
 * 快速检查，不做完整解析
 * 
 * @param {string} timeStr - 时间字符串
 * @returns {boolean|null} true=确定是最近, false=确定不是, null=需要完整解析
 */
export function isLikelyRecent(timeStr) {
  if (!timeStr) return null;
  
  const trimmed = timeStr.trim();
  
  // 相对时间通常是最近的
  // h = 小时, m = 分钟, s = 秒 → 肯定是 24 小时内
  if (/^\d+[smh]$/i.test(trimmed)) {
    return true;
  }
  
  // 天数判断
  const dayMatch = trimmed.match(/^(\d+)d$/i);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    return days < 1; // 0d 是今天
  }
  
  // 绝对日期需要完整解析
  return null;
}

/**
 * 格式化时间差为可读字符串
 * 
 * @param {Date} date - 日期
 * @param {Date} now - 当前时间
 * @returns {string}
 */
export function formatTimeAgo(date, now = new Date()) {
  const diffMs = now - date;
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  
  if (diffHours < 1) {
    const diffMins = Math.floor(diffMs / (60 * 1000));
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
