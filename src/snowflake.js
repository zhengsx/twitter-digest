/**
 * Twitter Snowflake ID utilities.
 *
 * Twitter status IDs are snowflake IDs:
 * - high 41 bits: milliseconds since Twitter epoch
 * - epoch: 2010-11-04 01:42:54.657 UTC
 */

const TWITTER_EPOCH_MS = 1288834974657n;

/**
 * Extract UTC timestamp (ms) from a Twitter Snowflake ID.
 *
 * @param {string|number|bigint} tweetId
 * @returns {number|null} Unix timestamp in milliseconds (UTC), or null if invalid
 */
export function extractTimestamp(tweetId) {
  if (tweetId === null || tweetId === undefined || tweetId === '') return null;

  try {
    const id = typeof tweetId === 'bigint' ? tweetId : BigInt(String(tweetId));
    const ms = (id >> 22n) + TWITTER_EPOCH_MS;
    const n = Number(ms);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Check if a tweet ID is within the last 24 hours (based on Snowflake timestamp).
 *
 * @param {string|number|bigint} tweetId
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isWithin24Hours(tweetId, now = new Date()) {
  const ts = extractTimestamp(tweetId);
  if (ts === null) return false;
  return ts >= now.getTime() - 24 * 60 * 60 * 1000;
}

