import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { config } from './config.js';

/**
 * 政府版 PDF 生成器 v5
 * 紧凑布局：卡片自适应高度，连续排列，无强制分页
 * 修复：消除页尾空白、最后空白页、第一页空白问题
 * v5: 水平边距移到 HTML body padding，兼容微信 PDF 阅读器
 * 支持图片智能筛选（useImage 字段控制）
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
    const showImages = item.useImage !== false;
    const images = showImages ? (imageMap.get(item.url) || []) : [];
    const filteredImages = images.filter(src =>
      src.includes('pbs.twimg.com/media/') ||
      src.includes('pbs.twimg.com/ext_tw_video_thumb/')
    );

    const imagesHtml = filteredImages.length > 0
      ? `<div class="card-images">${filteredImages.slice(0, 2).map(src =>
          `<img src="${src}" style="max-width:100%;max-height:240px;border-radius:6px;margin:4px 0;object-fit:contain;" onerror="this.style.display='none'" />`
        ).join('\n')}${item.imageNote ? `<div class="image-note">${item.imageNote}</div>` : ''}</div>`
      : '';

    return `
    <div class="card">
      <div class="card-header">
        <span class="card-number">${String(idx + 1).padStart(2, '0')}</span>
        <span class="card-importance ${item.importance || 'medium'}">${
          item.importance === 'high' ? '🔴 重要' : '🟡 关注'
        }</span>
      </div>
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
        <span class="other-source">${o.source || ''}${o.url ? ` · <a href="${o.url}" style="color:#2b6cb0;">${o.url}</a>` : ''}</span>
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
    /* v5: @page margin:0, 水平边距由 body padding 控制 */
    @page {
      size: 100mm 180mm;
      margin: 0;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      background: #ffffff;
      color: #2d3748;
      font-size: 24px;
      line-height: 1.8;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      /* 防止最后空白页 */
      height: auto !important;
      margin: 0 !important;
      /* 水平 padding 内嵌到 HTML，微信 PDF 阅读器不吃 printToPDF margin */
      padding: 0 24px !important;
    }
    .header {
      background: linear-gradient(135deg, #1a365d 0%, #2c5282 100%);
      color: white;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .header-title {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: 2px;
    }
    .header-date {
      font-size: 20px;
      opacity: 0.85;
    }
    .section-title {
      font-size: 22px;
      color: #718096;
      letter-spacing: 2px;
      margin-bottom: 14px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
    }
    .card {
      padding: 20px 0;
      border-bottom: 2px solid #e2e8f0;
      position: relative;
      /* 允许在卡片内分页，防止大卡片把前页留空 */
      page-break-inside: auto;
      break-inside: auto;
    }
    .card:last-of-type {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 10px;
      /* 标题行不要跟内容分开 */
      page-break-after: avoid;
      break-after: avoid;
    }
    .card-number {
      font-size: 32px;
      font-weight: 700;
      color: #cbd5e0;
      line-height: 1;
    }
    .card-importance {
      display: inline-block;
      font-size: 16px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
    }
    .card-importance.high { background: #fed7d7; color: #c53030; }
    .card-importance.medium { background: #fefcbf; color: #975a16; }
    .card-title {
      font-size: 26px;
      font-weight: 700;
      color: #1a365d;
      line-height: 1.4;
      margin-bottom: 8px;
      page-break-after: avoid;
      break-after: avoid;
    }
    .card-images {
      margin: 16px 0;
      page-break-inside: auto;
      break-inside: auto;
    }
    .image-note {
      font-size: 16px;
      color: #718096;
      font-style: italic;
      margin-top: 6px;
    }
    .card-summary {
      font-size: 24px;
      line-height: 1.8;
      color: #2d3748;
      margin-bottom: 12px;
    }
    .card-meta {
      font-size: 18px;
      color: #718096;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 4px;
    }
    .card-source { font-weight: 600; }
    .card-link {
      word-break: break-all;
      max-width: 70%;
      text-align: right;
    }
    .others-section {
      margin-top: 30px;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .others-divider {
      border-top: 3px solid #e2e8f0;
      margin-bottom: 16px;
    }
    .others-title {
      font-size: 24px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 10px;
    }
    .other-item {
      padding: 8px 0;
      border-bottom: 1px solid #edf2f7;
      font-size: 20px;
      line-height: 1.7;
    }
    .other-item:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .other-title {
      font-weight: 600;
      color: #1a365d;
    }
    .other-brief {
      color: #4a5568;
      margin-left: 6px;
    }
    .other-source {
      color: #a0aec0;
      font-size: 16px;
      margin-left: 6px;
    }
    .footer-bar {
      margin-top: 16px;
      padding-top: 8px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 14px;
      color: #a0aec0;
      /* 确保 footer 不会推出新页 */
      margin-bottom: 0;
      padding-bottom: 0;
      page-break-before: avoid;
      break-before: avoid;
    }
    /* 防止最后元素产生空白页 */
    body > *:last-child {
      margin-bottom: 0 !important;
      padding-bottom: 0 !important;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">🤖 AI 科技动态精华简报</div>
    <div class="header-date">${date}</div>
  </div>
  <div class="section-title">今日精选 · ${highlights.length} 条要点</div>
  ${cardsHtml}
  ${othersHtml}
  <div class="footer-bar">
    本简报由 AI 自动分析 Twitter 信源生成 · ${date}
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

  // Use Playwright headless Chromium to export PDF
  const { chromium } = await import('playwright');

  const htmlAbsPath = path.resolve(htmlPath);
  const fileUrl = `file://${htmlAbsPath}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });
    // Gov version: mobile-style narrow PDF (100mm × 180mm)
    // Horizontal padding is controlled by HTML body, so margins are 0 on sides
    await page.pdf({
      path: outputPath,
      width: '100mm',
      height: '180mm',
      printBackground: true,
      margin: { top: '6mm', bottom: '6mm', left: '0mm', right: '0mm' },
    });
    const stat = fsSync.statSync(outputPath);
    console.log(`✅ PDF 已生成: ${outputPath} (${(stat.size / 1024).toFixed(0)} KB)`);
    return outputPath;
  } finally {
    await browser.close();
  }
}

// CLI entry point
async function main() {
  const today = process.argv[2] || new Date().toISOString().split('T')[0];
  const reportPath = path.join(config.paths.reports, `gov-report-${today}.json`);
  const dataPath = path.join(config.paths.data, `tweets-${today}.json`);
  const outputPath = path.join(config.paths.reports, `gov-daily-${today}.pdf`);

  console.log(`🖨️  政府版 PDF 生成器 v5`);
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

// Only run main() when executed directly, not when imported
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isDirectRun) {
  main().catch(err => {
    console.error('❌ 执行失败:', err);
    process.exit(1);
  });
}
