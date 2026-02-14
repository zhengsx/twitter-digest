import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { generateReport } from './report-generator.js';

const DATA_DIR = config.paths.data;
const REPORTS_DIR = config.paths.reports;

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const dataPath = path.join(DATA_DIR, `tweets-${today}.json`);

  console.log(`📅 日期: ${today}`);
  console.log(`📂 读取已有数据: ${dataPath}`);

  const raw = await fs.readFile(dataPath, 'utf8');
  const tweetsData = JSON.parse(raw);

  const totalTweets = tweetsData.reduce((sum, d) => sum + d.tweets.length, 0);
  console.log(`📊 活跃信源: ${tweetsData.length} | 推文: ${totalTweets}`);

  // Build prompt to show its size
  const summary = tweetsData.map(d => ({
    user: `@${d.user.username}`,
    allTweets: d.tweets.map(t => ({
      text: (t.text || '').slice(0, 300),
      url: t.url || (t.tweetId ? `https://x.com/${d.user.username}/status/${t.tweetId}` : null),
    })),
  }));
  const promptPreview = JSON.stringify(summary, null, 2);
  console.log(`📏 Prompt data size: ${promptPreview.length} chars`);

  console.log(`🤖 正在用 ${config.openrouter.model} 生成报告...`);
  const report = await generateReport(tweetsData, new Date());

  const reportPath = path.join(REPORTS_DIR, `report-${today}.md`);
  const reportContent = `# Twitter 信源日报 - ${today}\n\n> 信源数: ${report.sourcesCount} | 推文数: ${report.totalTweets} | 生成时间: ${report.generatedAt}\n\n---\n\n${report.report}\n`;

  await fs.writeFile(reportPath, reportContent);
  console.log(`📄 报告已保存: ${reportPath}`);
  console.log(`✅ 完成！`);
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
