import { getUserTimeline, getFollowingList as getFollowingFromConfig } from './jina-client.js';

/**
 * 获取用户的关注列表 (Jina 版本：从配置读取)
 */
export async function getFollowingList() {
  return getFollowingFromConfig();
}

/**
 * 获取用户最近的推文 (Jina Reader API)
 * 兼容旧签名：userId 参数改为 username
 */
export async function getUserTweets(userIdOrUsername, since) {
  try {
    const username = normalizeUsername(userIdOrUsername);
    if (!username) {
      throw new Error('缺少用户名，无法获取推文');
    }

    // Jina Reader API 不支持时间过滤，忽略 since
    if (since) {
      console.log(`ℹ️ Jina Reader API 不支持时间过滤，忽略 since: ${since.toISOString()}`);
    }

    const data = await getUserTimeline(username);
    return data.tweets;
  } catch (error) {
    console.error(`获取用户推文失败:`, error.message);
    return [];
  }
}

/**
 * 批量获取多个用户的推文
 */
export async function fetchAllTweets(users, since) {
  const allData = [];

  for (const user of users) {
    const username = normalizeUsername(user?.username || user);
    if (!username) continue;

    console.log(`📥 获取 @${username} 的推文...`);
    const tweets = await getUserTweets(username, since);

    if (tweets.length > 0) {
      allData.push({
        user: {
          username,
          name: user?.name || username,
          description: user?.description || '',
          followers: user?.followers || 0,
        },
        tweets,
        fetchedAt: new Date().toISOString(),
      });
      console.log(`   ✓ ${tweets.length} 条推文`);
    }

    // 避免请求过快
    await sleep(2000);
  }

  return allData;
}

function normalizeUsername(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/^@/, '');
  return value?.username ? String(value.username).replace(/^@/, '') : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
