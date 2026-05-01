import { scrapeListFeed } from '../src/list-feed-scraper-dom.mjs';
const t0 = Date.now();
try {
  const tweets = await scrapeListFeed();
  const elapsed = Date.now() - t0;
  console.log(`[exp_c] DOM mode: ${tweets.length} tweets, elapsed=${(elapsed/1000).toFixed(1)}s`);
  for (const t of tweets.slice(0,3)) {
    console.log(`  ${t.author} @ ${t.datetime}: ${(t.text||'').slice(0,60)}`);
  }
  await import('fs').then(fs => fs.writeFileSync('tmp/exp_c_results.json', JSON.stringify({
    totalTweets: tweets.length, elapsedMs: elapsed,
    timestamp: new Date().toISOString(),
  }, null, 2)));
} catch (e) {
  console.error('[exp_c] failed:', e.message);
  process.exit(1);
}
process.exit(0);
