import fs from 'fs';
const proposed = fs.readFileSync('src/list-feed-scraper.js.proposed', 'utf8');
fs.writeFileSync('src/_proposed_temp.mjs', proposed);
try {
  const { scrapeListFeed } = await import('../src/_proposed_temp.mjs');
  const tweets = await scrapeListFeed();
  console.log(`\n[summary] total=${tweets.length}`);
  // Check author quality
  const noAuthor = tweets.filter(t => !t.author || t.author === '@').length;
  const noUrl = tweets.filter(t => !t.tweetUrl).length;
  const noDate = tweets.filter(t => !t.datetime).length;
  console.log(`[summary] missing author: ${noAuthor}/${tweets.length}`);
  console.log(`[summary] missing tweetUrl: ${noUrl}/${tweets.length}`);
  console.log(`[summary] missing datetime: ${noDate}/${tweets.length}`);
  console.log(`[summary] sample 5:`);
  for (const t of tweets.slice(0, 5)) {
    console.log(`  ${t.author || '(empty)'} | ${t.datetime} | ${(t.text||'').slice(0,50)}`);
  }
  // Filter 24h
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = tweets.filter(t => t.datetime && new Date(t.datetime) >= cutoff);
  console.log(`[summary] within 24h: ${recent.length}/${tweets.length}`);
  // Authors in 24h
  const authors = new Set(recent.map(t => t.author).filter(Boolean));
  console.log(`[summary] unique authors (24h): ${authors.size}`);
} finally {
  fs.unlinkSync('src/_proposed_temp.mjs');
}
