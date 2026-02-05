import 'dotenv/config';

export const config = {
  // Jina API (替代 Twitter API)
  jina: {
    apiKey: process.env.JINA_API_KEY,
  },
  // 关注用户列表 (逗号分隔)
  followingUsers: process.env.FOLLOWING_USERS 
    ? process.env.FOLLOWING_USERS.split(',').map(u => u.trim()).filter(Boolean)
    : [],
  // 保留旧配置兼容
  twitter: {
    targetUsername: process.env.TARGET_USERNAME || 'xxcc48764',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: 'google/gemini-3-pro-preview',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  paths: {
    data: './data',
    reports: './reports',
  }
};
