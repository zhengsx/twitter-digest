/**
 * 测试 Jina API 获取推文
 */
import { getUserTimeline, searchTweets } from './jina-client.js';
import { config } from './config.js';

async function test() {
  console.log('🧪 Jina API 测试\n');
  console.log(`API Key: ${config.jina.apiKey?.slice(0, 20)}...`);
  console.log(`配置的用户: ${config.followingUsers.join(', ')}\n`);
  
  // 测试获取用户时间线
  const testUser = config.followingUsers[0] || 'elonmusk';
  console.log(`\n📥 测试获取 @${testUser} 的时间线...\n`);
  
  try {
    const result = await getUserTimeline(testUser);
    
    console.log('✅ 成功获取!');
    console.log(`\n用户信息:`);
    console.log(`  - 用户名: @${result.user.username}`);
    console.log(`  - 名称: ${result.user.name}`);
    console.log(`  - 粉丝数: ${result.user.followers}`);
    console.log(`  - 推文数: ${result.tweets.length}`);
    
    if (result.tweets.length > 0) {
      console.log(`\n最近 3 条推文:`);
      result.tweets.slice(0, 3).forEach((tweet, i) => {
        console.log(`\n[${i + 1}] ${tweet.text.slice(0, 150)}...`);
        console.log(`    ❤️ ${tweet.likes} | 🔁 ${tweet.retweets} | 💬 ${tweet.replies}`);
        if (tweet.isReply) console.log('    (回复)');
        if (tweet.isRetweet) console.log('    (转推)');
      });
    }
    
    // 输出原始 markdown 供调试
    console.log('\n\n--- 原始 Markdown (前 2000 字符) ---\n');
    console.log(result.rawMarkdown.slice(0, 2000));
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    console.error(error);
  }
}

test();
