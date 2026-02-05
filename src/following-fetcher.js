import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const followingPath = path.join(dataDir, 'following.json');

const DEFAULT_USERNAME = 'xxcc48764';
const JINA_API_KEY = 'jina_422c9ce559de4c519e827233cdcd90a0E22LcYJzishlFevVhkXkuuHXS_0G';

function extractUsernames(markdown, ownerUsername) {
  if (!markdown) return [];

  const seen = new Set();
  const users = [];
  const regex = /@([A-Za-z0-9_]{1,15})/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    const username = match[1];
    if (!username) continue;
    if (ownerUsername && username.toLowerCase() === ownerUsername.toLowerCase()) continue;
    if (seen.has(username)) continue;
    seen.add(username);
    users.push(username);
  }

  return users;
}

export async function loadStoredFollowing() {
  try {
    const raw = await fs.readFile(followingPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveFollowing(data) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(followingPath, JSON.stringify(data, null, 2));
}

async function fetchFollowingMarkdown(username) {
  const url = `https://r.jina.ai/https://x.com/${username}/following`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${JINA_API_KEY}`,
      'X-Return-Format': 'markdown',
      'X-With-Generated-Alt': 'true',
      'X-No-Cache': 'true',
      'X-Timeout': '30',
    },
  });

  if (!response.ok) {
    throw new Error(`Jina API 错误: ${response.status}`);
  }

  return await response.text();
}

export async function syncFollowingList(username = DEFAULT_USERNAME) {
  const markdown = await fetchFollowingMarkdown(username);
  const users = extractUsernames(markdown, username);

  const stored = await loadStoredFollowing();
  const storedUsers = stored?.users || [];

  const added = users.filter(u => !storedUsers.includes(u));
  const removed = storedUsers.filter(u => !users.includes(u));

  const now = new Date();
  const date = now.toISOString().split('T')[0];

  const history = Array.isArray(stored?.history) ? [...stored.history] : [];
  const entry = { date, added, removed };

  if (history.length > 0 && history[history.length - 1].date === date) {
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }

  const data = {
    username,
    users,
    lastUpdated: now.toISOString(),
    history,
  };

  await saveFollowing(data);

  return { users, diff: { added, removed }, data };
}
