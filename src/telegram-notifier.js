import fetch from 'node-fetch';
import { config } from './config.js';

/**
 * 发送 Telegram 消息
 */
export async function sendTelegramMessage(text) {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    console.log('⚠️ Telegram 未配置，跳过通知');
    return;
  }
  
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
  
  // Telegram 消息长度限制 4096
  const chunks = splitMessage(text, 4000);
  
  for (const chunk of chunks) {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: chunk,
        parse_mode: 'Markdown',
      }),
    });
    
    if (chunks.length > 1) {
      await sleep(500);
    }
  }
  
  console.log('✅ Telegram 通知已发送');
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  
  const chunks = [];
  let current = '';
  
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  
  if (current) chunks.push(current);
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
