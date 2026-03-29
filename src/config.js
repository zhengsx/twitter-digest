import 'dotenv/config';

export const config = {
  // Jina API (替代 Twitter API)
  jina: {
    apiKey: process.env.JINA_API_KEY,
  },
  // List feed (CDP scrape)
  listFeed: {
    url: process.env.LIST_FEED_URL || 'https://x.com/i/lists/2019940021005058347',
    cdpHost: process.env.LIST_FEED_CDP_HOST || '127.0.0.1',
    cdpPort: Number(process.env.LIST_FEED_CDP_PORT || 18792),
    scrollCount: Number(process.env.LIST_FEED_SCROLL_COUNT || 40),
    scrollDelay: Number(process.env.LIST_FEED_SCROLL_DELAY || 2000),
    scrollAmount: Number(process.env.LIST_FEED_SCROLL_AMOUNT || 2000),
    pageLoadDelay: Number(process.env.LIST_FEED_PAGE_LOAD_DELAY || 8000),
    // Additional safety for slow loads; scraper will still wait pageLoadDelay afterwards.
    pageLoadTimeoutMs: Number(process.env.LIST_FEED_PAGE_LOAD_TIMEOUT_MS || 30000),
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
    model: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.6',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  paths: {
    data: './data',
    reports: './reports',
  },
  // YouTube 播客信源（follow-builders 整合）
  youtube: {
    podcasts: [
      {
        name: 'Latent Space',
        handle: '@LatentSpacePod',
        channelId: 'UCxBcwypKK-W3GHd_RZ9FZrQ',
      },
      {
        name: 'Training Data',
        handle: '@TrainingDataPod',
        playlistId: 'PLOhHNjZItNnMm5tdW61JpnyxeYH5NDDx8',
      },
      {
        name: 'No Priors',
        handle: '@NoPriorsPodcast',
        channelId: 'UCSI7h9hydQ40K5MJHnCrQvw',
      },
      {
        name: 'Unsupervised Learning',
        handle: '@RedpointAI',
        channelId: 'UCUl-s_Vp-Kkk_XVyDylNwLA',
      },
      {
        name: 'The MAD Podcast (Data Driven NYC)',
        handle: '@DataDrivenNYC',
        channelId: 'UCQID78IY6EOojr5RUdD47MQ',
      },
    ],
  },
};
