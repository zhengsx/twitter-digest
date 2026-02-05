import fetch from 'node-fetch';
import 'dotenv/config';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-flash-1.5';
const MAX_CHARS = 50000;

function compressTweets(tweetsData, maxChars = MAX_CHARS) {
  const compressed = [];
  let totalChars = 2;

  for (const data of tweetsData || []) {
    const username = data?.user?.username || data?.user?.name || '';
    const tweets = Array.isArray(data?.tweets) ? data.tweets : [];

    for (const tweet of tweets) {
      if (!tweet || tweet.isReply || tweet.isRetweet) continue;
      const entry = {
        username,
        text: tweet.originalText || tweet.text || '',
        url: tweet.url || '',
      };

      const entryStr = JSON.stringify(entry);
      const nextLength = totalChars + entryStr.length + (compressed.length > 0 ? 1 : 0);
      if (nextLength > maxChars) {
        return compressed;
      }

      compressed.push(entry);
      totalChars = nextLength;
    }
  }

  return compressed;
}

function buildPrompt(compressed) {
  return [
    '你是严谨的中文内容分析助手。请基于给定的推文数据进行分析，禁止编造。',
    '要求输出严格 JSON，不要包含额外文字或 Markdown。',
    'JSON 结构如下：',
    '{',
    '  "insights": [{"text": "...", "url": "..."}],',
    '  "technical_details": ["..."],',
    '  "trends": ["..."],',
    '  "kol_opinions": [{"username": "...", "text": "...", "url": "..."}]',
    '}',
    '约束：',
    '- insights 3-5 条，每条必须附原文 url，并且来自给定推文。',
    '- technical_details、trends、kol_opinions 可为空数组，但不要缺字段。',
    '- kol_opinions 用 @username 格式，text 简洁总结观点，附原文 url。',
    '输入数据：',
    JSON.stringify(compressed),
  ].join('\n');
}

function normalizeResult(result) {
  const safeArray = value => (Array.isArray(value) ? value : []);
  return {
    insights: safeArray(result?.insights)
      .filter(item => item && item.text && item.url)
      .slice(0, 5),
    technicalDetails: safeArray(result?.technical_details).filter(Boolean),
    trends: safeArray(result?.trends).filter(Boolean),
    kolOpinions: safeArray(result?.kol_opinions)
      .filter(item => item && item.username && item.text && item.url),
  };
}

function tryParseJson(content) {
  if (!content) return null;
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;
  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = jsonText.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function callOpenRouter(prompt) {
  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是专业的信息分析助手，输出严格 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenRouter API 错误: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';
  return content;
}

export async function analyzeTwitterDigest(tweetsData) {
  if (!OPENROUTER_API_KEY) {
    return {
      insights: [],
      technicalDetails: [],
      trends: [],
      kolOpinions: [],
      error: 'missing_openrouter_api_key',
    };
  }

  const compressed = compressTweets(tweetsData, MAX_CHARS);
  if (compressed.length === 0) {
    return {
      insights: [],
      technicalDetails: [],
      trends: [],
      kolOpinions: [],
      error: 'empty_input',
    };
  }

  const prompt = buildPrompt(compressed);
  const content = await callOpenRouter(prompt);
  const parsed = tryParseJson(content);
  if (!parsed) {
    return {
      insights: [],
      technicalDetails: [],
      trends: [],
      kolOpinions: [],
      error: 'invalid_json_response',
      raw: content,
    };
  }

  return normalizeResult(parsed);
}

export { compressTweets };
