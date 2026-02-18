import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';

/**
 * 政府版 PDF 生成器 v2
 * 无封面页，直接显示内容，支持图片和附录
 */

function buildGovHtml(govReport, tweetsData) {
  const date = govReport.date || new Date().toISOString().split('T')[0];
  const highlights = govReport.highlights || govReport.items || [];
  const others = govReport.others || [];

  // Build image lookup: url -> images[]
  const imageMap = new Map();
  if (tweetsData) {
    for (const userData of tweetsData) {
      for (const tweet of (userData.tweets || [])) {
        const url = tweet.url || '';
        if (url && Array.isArray(tweet.images) && tweet.images.length > 0) {
          imageMap.set(url, tweet.images);
        }
      }
    }
  }

  const cardsHtml = highlights.map((item, idx) => {
    const images = imageMap.get(item.url) || [];
    const imagesHtml = images.length > 0
      ? `<div class="card-images">${images.map(src =>
          `<img src="${src}" style="width:100%;border-radius:8px;margin:8px 0;" onerror="this.style.display='none'" />`
        ).join('\n')}</div>`
      : '';

    return `
    <div class="card">
      <div class="card-number">${String(idx + 1).padStart(2, '0')}</div>
      <div class="card-importance ${item.importance || 'medium'}">${
        item.importance === 'high' ? '🔴 重要' : '🟡 关注'
      }</div>
      <h2 class="card-title">${item.title}</h2>
      ${imagesHtml}
      <p class="card-summary">${item.summary}</p>
      <div class="card-meta">
        <span class="card-source">${item.source}</span>
        <span class="card-link">${item.url || ''}</span>
      </div>
    </div>`;
  }).join('\n');

  // Others appendix
  let othersHtml = '';
  if (others.length > 0) {
    const otherItems = others.map(o => `
      <div class="other-item">
        <span class="other-title">${o.title}</span>
        <span class="other-brief">${o.brief || ''}</span>
        <span class="other-source">${o.source || ''}</span>
      </div>
    `).join('\n');

    othersHtml = `
    <div class="others-section">
      <div class="others-divider"></div>
      <div class="others-title">📎 其他值得关注的动态</div>
      ${otherItems}
    </div>`;
  }

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
    .header {
      background: linear-gradient(135deg, #1a365d 0%, #2c5282 100%);
      color: white;
      padding: 20px 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header-title {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: 2px;
    }
    .header-date {
      font-size: 16px;
      opacity: 0.85;
    }
    .content { padding: 30px 48px; }
    .section-title {
      font-size: 16px;
      color: #718096;
      letter-spacing: 3px;
      margin-bottom: 24px;
      padding-bottom: 10px;
      border-bottom: 2px solid #e2e8f0;
    }
    .card {
      background: #f7fafc;
      border-radius: 12px;
      padding: 24px 28px;
      margin-bottom: 20px;
      border-left: 4px solid #2b6cb0;
      position: relative;
      page-break-inside: avoid;
    }
    .card-number {
      position: absolute;
      top: 16px;
      right: 20px;
      font-size: 42px;
      font-weight: 700;
      color: #e2e8f0;
      line-height: 1;
    }
    .card-importance {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .card-importance.high { background: #fed7d7; color: #c53030; }
    .card-importance.medium { background: #fefcbf; color: #975a16; }
    .card-title {
      font-size: 22px;
      font-weight: 700;
      color: #1a365d;
      line-height: 1.5;
      margin-bottom: 12px;
      padding-right: 50px;
    }
    .card-images {
      margin: 10px 0;
    }
    .card-summary {
      font-size: 16px;
      line-height: 1.8;
      color: #2d3748;
      margin-bottom: 14px;
    }
    .card-meta {
      font-size: 13px;
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
    .others-section {
      margin-top: 36px;
      page-break-inside: avoid;
    }
    .others-divider {
      border-top: 2px solid #e2e8f0;
      margin-bottom: 16px;
    }
    .others-title {
      font-size: 18px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 16px;
    }
    .other-item {
      padding: 8px 0;
      border-bottom: 1px solid #edf2f7;
      font-size: 15px;
      line-height: 1.6;
    }
    .other-title {
      font-weight: 600;
      color: #1a365d;
    }
    .other-brief {
      color: #4a5568;
      margin-left: 8px;
    }
    .other-source {
      color: #a0aec0;
      font-size: 13px;
      margin-left: 8px;
    }
    .footer-bar {
      margin-top: 30px;
      padding-top: 16px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 12px;
      color: #a0aec0;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">🤖 AI 科技动态精华简报</div>
    <div class="header-date">${date}</div>
  </div>
  <div class="content">
    <div class="section-title">今日精选 · ${highlights.length} 条要点</div>
    ${cardsHtml}
    ${othersHtml}
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

  // Use CDP to export PDF
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

    // Wait for load + images
    await new Promise(r => setTimeout(r, 5000));

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

  console.log(`🖨️  政府版 PDF 生成器 v2`);
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
