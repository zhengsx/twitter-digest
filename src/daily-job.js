import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { getFollowingList, fetchAllUserTimelines } from './jina-client.js';
import { generateReport } from './report-generator.js';
import { sendTelegramMessage } from './telegram-notifier.js';

const DATA_DIR = config.paths.data;
const REPORTS_DIR = config.paths.reports;

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

async function loadFollowingList() {
  // 使用 Jina API 后，关注列表从环境变量读取
  console.log('📋 从配置加载关注列表...');
  const users = await getFollowingList();
  
  if (users.length === 0) {
    console.log('⚠️ 未配置关注用户，请在 .env 中设置 FOLLOWING_USERS');
    console.log('   示例: FOLLOWING_USERS=elonmusk,sama,kaborolin');
  }
  
  return users;
}

async function main() {
  console.log('🚀 Twitter Digest 日报生成开始 (Jina API)\n');
  console.log(`📅 日期: ${new Date().toISOString().split('T')[0]}`);
  console.log(`🔑 使用 Jina Reader API\n`);
  console.log(`👥 配置 followingUsers: ${config.followingUsers.length}\n`);
  
  await ensureDirs();
  
  // 1. 获取关注列表
  const following = await loadFollowingList();
  console.log(`\n📊 共 ${following.length} 个信源\n`);
  
  if (following.length === 0) {
    console.log('❌ 没有配置信源用户，退出');
    return;
  }
  
  // 2. 获取推文 (Jina API 获取的是最近推文，不支持时间过滤)
  console.log('⏰ 获取各信源最近推文...\n');
  
  const usernames = following.map(u => u.username);
  const tweetsData = await fetchAllUserTimelines(usernames);
  
  const totalTweets = tweetsData.reduce((sum, d) => sum + d.tweets.length, 0);
  console.log(`\n📈 共获取 ${totalTweets} 条推文 (来自 ${tweetsData.length} 个活跃账号)\n`);
  
  if (totalTweets === 0) {
    console.log('⚠️ 未获取到推文，跳过报告生成');
    return;
  }
  
  // 3. 保存原始数据
  const today = new Date().toISOString().split('T')[0];
  const dataPath = path.join(DATA_DIR, `tweets-${today}.json`);
  await fs.writeFile(dataPath, JSON.stringify(tweetsData, null, 2));
  console.log(`💾 原始数据已保存: ${dataPath}\n`);
  
  // 4. 生成报告
  console.log('🤖 正在用 Gemini 3 Pro 生成报告...\n');
  const report = await generateReport(tweetsData, new Date());
  
  // 5. 保存报告
  const reportPath = path.join(REPORTS_DIR, `report-${today}.md`);
  const reportContent = `# Twitter 信源日报 - ${today}

> 信源数: ${report.sourcesCount} | 推文数: ${report.totalTweets} | 生成时间: ${report.generatedAt}

---

${report.report}
`;
  
  await fs.writeFile(reportPath, reportContent);
  console.log(`📄 报告已保存: ${reportPath}\n`);
  
  // 6. 发送 Telegram 通知
  const telegramMsg = `📰 *Twitter 信源日报 - ${today}*

_${report.sourcesCount} 个信源 | ${report.totalTweets} 条推文_

---

${report.report}`;
  
  await sendTelegramMessage(telegramMsg);
  
  console.log('✅ 日报生成完成!');
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
