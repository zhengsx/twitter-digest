import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';

/**
 * 政府版 PDF 生成器
 * 读取精华版 JSON → 生成 HTML → 通过 CDP 导出 PDF
 */

function buildGovHtml(govReport, tweetsData) {
  const date = govReport.date || new Date().toISOString().split('T')[0];
  const items = govReport.items || [];

  // Build image lookup: url -> images[]
  const imageMap = new Map();
  if (tweetsData) {
    for (const userData of tweetsData) {
      for (const tweet of userData.tweets) {
        const url = tweet.url || '';
        if (url && Array.isArray(tweet.images) && tweet.images.length > 0) {
          imageMap.set(url, tweet.images);
        }
      }
    }
  }

  const cardsHtml = items.map((item, idx) => {
    const images = imageMap.get(item.url) || [];
    const imagesHtml = images.length > 0
      ? images.map(src =>
          `<img src="${src}" style="width:100%;border-radius:8px;margin:12px 0;" />`
        ).join('\n')
      : '';

    return `
    <div class="card">
      <div class="card-number">${String(idx + 1).padStart(2, '0')}</div>
      <div class="card-importance ${item.importance}">${item.importance === 'high' ? '🔴 重要' : '🟡 关注'}</div>
      <h2 class="card-title">${item.title}</h2>
      ${imagesHtml}
      <p class="card-summary">${item.summary}</p>
      <div class="card-meta">
        <span class="card-source">${item.source}</span>
        <span class="card-link">${item.url}</span>
      </div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 科技动态精华简报 - ${date}</title>
  <style>
    @page {
      size: A4;
      margin: 0;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
      background: #ffffff;
      color: #2d3748;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cover {
      width: 100%;
      min-height: 100vh;
      background: linear-gradient(135deg, #1a365d 0%, #2c5282 50%, #2b6cb0 100%);
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      color: white;
      text-align: center;
      padding: 60px 40px;
      page-break-after: always;
    }
    .cover-icon { font-size: 72px; margin-bottom: 30px; }
    .cover-title {
      font-size: 42px;
      font-weight: 700;
      letter-spacing: 4px;
      margin-bottom: 16px;
      line-height: 1.4;
    }
    .cover-subtitle {
      font-size: 22px;
      opacity: 0.85;
      margin-bottom: 40px;
      font-weight: 300;
    }
    .cover-date {
      font-size: 28px;
      font-weight: 500;
      border-top: 2px solid rgba(255,255,255,0.3);
      padding-top: 24px;
      letter-spacing: 2px;
    }
    .cover-footer {
      margin-top: 60px;
      font-size: 16px;
      opacity: 0.6;
    }
    .content { padding: 40px 48px; }
    .section-title {
      font-size: 18px;
      color: #718096;
      text-transform: uppercase;
      letter-spacing: 3px;
      margin-bottom: 30px;
      padding-bottom: 12px;
      border-bottom: 2px solid #e2e8f0;
    }
    .card {
      background: #f7fafc;
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 24px;
      border-left: 4px solid #2b6cb0;
      position: relative;
      page-break-inside: avoid;
    }
    .card-number {
      position: absolute;
      top: 20px;
      right: 24px;
      font-size: 48px;
      font-weight: 700;
      color: #e2e8f0;
      line-height: 1;
    }
    .card-importance {
      display: inline-block;
      font-size: 13px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 4px;
      margin-bottom: 10px;
    }
    .card-importance.high { background: #fed7d7; color: #c53030; }
    .card-importance.medium { background: #fefcbf; color: #975a16; }
    .card-title {
      font-size: 24px;
      font-weight: 700;
      color: #1a365d;
      line-height: 1.5;
      margin-bottom: 14px;
      padding-right: 60px;
    }
    .card-summary {
      font-size: 17px;
      line-height: 1.8;
      color: #2d3748;
      margin-bottom: 16px;
    }
    .card-meta {
      font-size: 14px;
      color: #718096;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    .card-source { font-weight: 600; }
    .card-link {
      word-break: break-all;
      max-width: 70%;
      text-align: right;
    }
    .footer-bar {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 13px;
      color: #a0aec0;
    }
  </style>
</head>
<body>
  <div class="cover">
    <div class="cover-icon">🤖</div>
    <div class="cover-title">AI 科技动态<br/>精华简报</div>
    <div class="cover-subtitle">Tech Intelligence Brief</div>
    <div class="cover-date">${date}</div>
    <div class="cover-footer">基于 Twitter 信源 · AI 自动生成</div>
  </div>
  <div class="content">
    <div class="section-title">今日精选 · ${items.length} 条动态</div>
    ${cardsHtml}
    <div class="footer-bar">
      本简报由 AI 自动分析 Twitter 信源生成 · ${date}
    </div>
  </div>
</body>
</html>`;
}

export async function generateGovPdf(govReport, tweetsData, outputPath) {
  const html = buildGovHtml(govReport, tweetsData);

  // Save HTML for debug
  const htmlPath = outputPath.replace(/\.pdf$/, '.html');
  await fs.writeFile(htmlPath, html, 'utf-8');
  console.log(`📄 HTML 已生成: ${htmlPath}`);

  // Use CDP to export PDF (similar to existing pattern)
  const WebSocket = (await import('ws')).default;
  const nodeFetch = (await import('node-fetch')).default;

  const host = config.listFeed.cdpHost || '127.0.0.1';
  const port = Number(config.listFeed.cdpPort || 18800);

  // Get page target
  const listRes = await nodeFetch(`http://${host}:${port}/json/list`);
  const targets = await listRes.json();
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    throw new Error('No CDP page target found');
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl, { handshakeTimeout: 10000 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 1;
  const pending = new Map();
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    } catch {}
  });

  function cdpSend(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    await cdpSend('Page.enable');

    // Navigate to HTML file
    const fileUrl = `file://${path.resolve(htmlPath)}`;
    await cdpSend('Page.navigate', { url: fileUrl });

    // Wait for load
    await new Promise(r => setTimeout(r, 3000));

    // Print to PDF
    const pdfResult = await cdpSend('Page.printToPDF', {
      landscape: false,
      displayHeaderFooter: false,
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 8.27,   // A4
      paperHeight: 11.69,  // A4
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    });

    const pdfBuffer = Buffer.from(pdfResult.data, 'base64');
    await fs.writeFile(outputPath, pdfBuffer);
    console.log(`✅ PDF 已生成: ${outputPath} (${(pdfBuffer.length / 1024).toFixed(0)} KB)`);

    return outputPath;
  } finally {
    ws.close(1000, 'done');
  }
}

// CLI entry point
async function main() {
  const today = process.argv[2] || new Date().toISOString().split('T')[0];
  const reportPath = path.join(config.paths.reports, `gov-report-${today}.json`);
  const dataPath = path.join(config.paths.data, `tweets-${today}.json`);
  const outputPath = path.join(config.paths.reports, `gov-daily-${today}.pdf`);

  console.log(`🖨️  政府版 PDF 生成器`);
  console.log(`📅 日期: ${today}`);
  console.log(`📂 精华报告: ${reportPath}`);
  console.log(`📂 原始数据: ${dataPath}\n`);

  const govReport = JSON.parse(await fs.readFile(reportPath, 'utf-8'));

  let tweetsData = null;
  try {
    tweetsData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
  } catch {
    console.log('⚠️ 无法读取原始数据，将不包含图片');
  }

  await fs.mkdir(config.paths.reports, { recursive: true });
  await generateGovPdf(govReport, tweetsData, outputPath);
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
