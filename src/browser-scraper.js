/**
 * 使用 OpenClaw 浏览器 API 抓取 Twitter 推文
 * 绕过 Jina 缓存问题
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

// 加载用户列表
async function loadUserList() {
  try {
    const listPath = path.join(dataDir, 'following-list.json');
    const content = await fs.readFile(listPath, 'utf-8');
    const data = JSON.parse(content);
    return data.users;
  } catch (error) {
    console.error('无法加载用户列表:', error.message);
    return [];
  }
}

// 解析推文时间
function parseTimeAgo(timeStr) {
  const now = new Date();
  
  // "5h" -> 5 hours ago
  const hoursMatch = timeStr.match(/^(\d+)h$/);
  if (hoursMatch) {
    return new Date(now.getTime() - parseInt(hoursMatch[1]) * 60 * 60 * 1000);
  }
  
  // "30m" -> 30 minutes ago
  const minsMatch = timeStr.match(/^(\d+)m$/);
  if (minsMatch) {
    return new Date(now.getTime() - parseInt(minsMatch[1]) * 60 * 1000);
  }
  
  // "Feb 5" -> this year
  const monthDayMatch = timeStr.match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const month = months[monthDayMatch[1]];
    const day = parseInt(monthDayMatch[2]);
    const date = new Date(now.getFullYear(), month, day);
    // 如果是未来日期，说明是去年的
    if (date > now) date.setFullYear(date.getFullYear() - 1);
    return date;
  }
  
  return null;
}

// 检查是否在24小时内
function isWithin24Hours(date) {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  return diff < 24 * 60 * 60 * 1000;
}

// 主函数
async function main() {
  console.log('📋 加载用户列表...');
  const users = await loadUserList();
  console.log(`找到 ${users.length} 个用户`);
  
  // 由于 Jina 缓存问题，建议：
  // 1. 使用 OpenClaw browser 工具抓取
  // 2. 或者等待 Jina 修复缓存问题
  // 3. 或者使用 Twitter API (需要付费)
  
  console.log(`
⚠️  Jina Reader API 有严重的缓存问题
    - X-No-Cache header 不起作用
    - 返回的数据可能是几天甚至几个月前的
    
推荐方案：
1. 使用 OpenClaw 浏览器工具手动抓取
2. 等待 Jina 修复缓存
3. 使用官方 Twitter API (需要付费)

当前状态：无法获取实时推文数据
`);
}

main().catch(console.error);
