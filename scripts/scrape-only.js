import { scrapeListFeed } from '../src/list-feed-scraper.js';
import fs from 'fs/promises';
import path from 'path';

const today = '2026-02-18';
const outPath = path.join('data', `tweets-${today}.json`);

console.log('🔄 Starting scrape-only run...');

try {
  const tweets = await scrapeListFeed();
  console.log(`✅ Got ${tweets.length} tweets`);
  
  // Count images
  let withImages = 0;
  let totalImages = 0;
  for (const t of tweets) {
    if (t.images && t.images.length > 0) {
      withImages++;
      totalImages += t.images.length;
    }
  }
  console.log(`📷 Tweets with images: ${withImages}, Total images: ${totalImages}`);
  
  // Group by author (same format as existing data)
  const byAuthor = {};
  for (const t of tweets) {
    const author = t.author || 'unknown';
    if (!byAuthor[author]) {
      byAuthor[author] = {
        user: { username: author.replace('@', '') },
        tweets: []
      };
    }
    byAuthor[author].tweets.push({
      text: t.text,
      datetime: t.datetime,
      url: t.tweetUrl,
      images: t.images || [],
    });
  }
  
  const grouped = Object.values(byAuthor);
  
  // Save
  await fs.writeFile(outPath, JSON.stringify(grouped, null, 2));
  console.log(`💾 Saved to ${outPath}`);
  console.log(`👥 ${grouped.length} authors`);
  
} catch (err) {
  console.error('❌ Scrape failed:', err.message);
  process.exit(1);
}
