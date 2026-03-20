/**
 * youtube-fetcher.js
 * 
 * 通过 YouTube RSS feed 获取最新播客/频道视频
 * 错误安全：网络失败不阻塞日报生成
 */

import fetch from 'node-fetch';

/**
 * 解析 YouTube RSS XML，返回视频列表
 * @param {string} xml - RSS XML 内容
 * @returns {Array<{title, url, published, description, channelTitle}>}
 */
function parseYouTubeRss(xml) {
  const entries = [];

  // Extract channel/feed title
  const channelTitleMatch = xml.match(/<title>([^<]*)<\/title>/);
  const channelTitle = channelTitleMatch ? channelTitleMatch[1].replace(/&amp;/g, '&').trim() : 'Unknown';

  // Find all <entry> blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];

    const titleMatch = block.match(/<title>([^<]*)<\/title>/);
    const linkMatch = block.match(/<link rel="alternate" href="([^"]*)"/);
    const publishedMatch = block.match(/<published>([^<]*)<\/published>/);
    const descMatch = block.match(/<media:description>([^<]*)<\/media:description>/);

    if (!titleMatch || !linkMatch) continue;

    entries.push({
      title: titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
      url: linkMatch[1].trim(),
      published: publishedMatch ? publishedMatch[1].trim() : null,
      description: descMatch ? descMatch[1].replace(/&amp;/g, '&').trim().slice(0, 300) : '',
      channelTitle,
    });
  }

  return entries;
}

/**
 * 获取单个 RSS feed 的最新视频（24h 内）
 * @param {string} feedUrl - RSS URL
 * @param {number} maxAgeDays - 最多几天内的视频（默认 1 天）
 * @returns {Array} 视频列表，出错返回空数组
 */
async function fetchFeedVideos(feedUrl, maxAgeDays = 1) {
  try {
    const resp = await fetch(feedUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'twitter-digest-bot/2.0' },
    });

    if (!resp.ok) {
      console.warn(`⚠️ YouTube RSS 请求失败 (${resp.status}): ${feedUrl}`);
      return [];
    }

    const xml = await resp.text();
    const videos = parseYouTubeRss(xml);

    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const recent = videos.filter(v => {
      if (!v.published) return false;
      const d = new Date(v.published);
      return !Number.isNaN(d.getTime()) && d >= cutoff;
    });

    return recent;
  } catch (err) {
    console.warn(`⚠️ YouTube RSS 获取出错 (${feedUrl}): ${err.message}`);
    return [];
  }
}

/**
 * 获取所有配置的 YouTube 播客更新（24h 内）
 * @param {Array} podcasts - config.youtube.podcasts 数组
 * @returns {Array<{podcast, videos}>} 有新视频的播客列表
 */
export async function fetchYouTubePodcasts(podcasts) {
  if (!podcasts || podcasts.length === 0) return [];

  const results = await Promise.allSettled(
    podcasts.map(async (podcast) => {
      const feedUrl = podcast.playlistId
        ? `https://www.youtube.com/feeds/videos.xml?playlist_id=${podcast.playlistId}`
        : `https://www.youtube.com/feeds/videos.xml?channel_id=${podcast.channelId}`;

      const videos = await fetchFeedVideos(feedUrl);
      return { podcast, videos };
    })
  );

  const successful = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.videos.length > 0) {
      successful.push(r.value);
    }
  }

  const total = successful.reduce((s, r) => s + r.videos.length, 0);
  console.log(`📺 YouTube 播客: ${successful.length}/${podcasts.length} 有更新，共 ${total} 个视频`);

  return successful;
}
