#!/usr/bin/env node
/**
 * html-pdf-generator.js
 * Markdown → HTML → PDF generator (senior-friendly mobile layout)
 *
 * Library usage:
 *   import { generateDailyHtml, generateDailyPdf } from './html-pdf-generator.js';
 *   generateDailyHtml(inputMd, outputHtml);
 *   await generateDailyPdf(inputMd, outputPdf);
 *
 * CLI usage:
 *   node src/html-pdf-generator.js [input.md] [output.html]
 */

import fs from 'fs';
import fsP from 'fs/promises';
import path from 'path';
import markdownit from 'markdown-it';
import { config } from './config.js';

const md = markdownit({ html: true, linkify: true, typographer: true });

const CSS = `
body {
  font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  max-width: 100%;
  margin: 0;
  padding: 20px;
  font-size: 20px;
  line-height: 2.0;
  color: #1a1a1a;
  background: #ffffff;
}
h1 {
  font-size: 28px;
  color: #1a1a2e;
  margin-top: 30px;
  margin-bottom: 15px;
  line-height: 1.4;
}
h2 {
  font-size: 24px;
  color: #16213e;
  border-bottom: 2px solid #eee;
  padding-bottom: 8px;
  margin-top: 25px;
  margin-bottom: 12px;
  line-height: 1.4;
}
h3 {
  font-size: 22px;
  color: #2c3e50;
  margin-top: 20px;
  margin-bottom: 10px;
  line-height: 1.4;
}
p {
  margin-bottom: 16px;
}
a {
  color: #0055cc;
  font-size: 20px;
  word-break: break-all;
}
ul, ol {
  padding-left: 25px;
}
li {
  margin-bottom: 12px;
  line-height: 1.8;
}
blockquote {
  border-left: 4px solid #ddd;
  margin: 15px 0;
  padding: 10px 20px;
  font-size: 20px;
  color: #444;
  background: #f9f9f9;
}
code {
  font-size: 18px;
  background: #f4f4f4;
  padding: 2px 6px;
  border-radius: 3px;
}
hr {
  border: none;
  border-top: 2px solid #eee;
  margin: 25px 0;
}
strong {
  color: #1a1a1a;
}
`;

/**
 * Generate HTML from a markdown file.
 * @param {string} inputMdPath - path to .md file
 * @param {string} outputHtmlPath - path for output .html
 * @param {string} [dateStr] - optional date string for title
 * @returns {string} outputHtmlPath
 */
export function generateDailyHtml(inputMdPath, outputHtmlPath, dateStr) {
  const date = dateStr || new Date().toISOString().split('T')[0];
  const markdown = fs.readFileSync(inputMdPath, 'utf-8');
  const body = md.render(markdown);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Twitter 信源日报 - ${date}</title>
  <style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;

  fs.writeFileSync(outputHtmlPath, html, 'utf-8');
  console.log(`✅ HTML 已生成: ${outputHtmlPath}`);
  return outputHtmlPath;
}

/**
 * Generate PDF from a markdown file via HTML + CDP printToPDF.
 * @param {string} inputMdPath - path to .md file
 * @param {string} outputPdfPath - path for output .pdf
 * @param {string} [dateStr] - optional date string
 */
export async function generateDailyPdf(inputMdPath, outputPdfPath, dateStr) {
  // 1. Generate HTML first
  const htmlPath = outputPdfPath.replace(/\.pdf$/, '.html');
  generateDailyHtml(inputMdPath, htmlPath, dateStr);

  // 2. Use CDP to print PDF (same pattern as gov-pdf-generator.js)
  const WebSocket = (await import('ws')).default;
  const nodeFetch = (await import('node-fetch')).default;

  const host = config.listFeed.cdpHost || '127.0.0.1';
  const port = Number(config.listFeed.cdpPort || 18800);

  // Get page target
  const listRes = await nodeFetch(`http://${host}:${port}/json/list`);
  const targets = await listRes.json();
  const pageTarget = targets.find(
    t => t.type === 'page' && t.webSocketDebuggerUrl
  ) || targets[0];
  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    throw new Error('No CDP page target found');
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl, {
    handshakeTimeout: 10000,
  });
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

    const fileUrl = `file://${path.resolve(htmlPath)}`;
    await cdpSend('Page.navigate', { url: fileUrl });

    // Wait for page load
    await new Promise(r => setTimeout(r, 3000));

    // Print to PDF - daily version uses narrower margins
    const pdfResult = await cdpSend('Page.printToPDF', {
      landscape: false,
      displayHeaderFooter: false,
      printBackground: true,
      preferCSSPageSize: false,
      paperWidth: 8.27,   // A4
      paperHeight: 11.69, // A4
      marginTop: 0.6,
      marginBottom: 0.6,
      marginLeft: 0.6,
      marginRight: 0.6,
    });

    const pdfBuffer = Buffer.from(pdfResult.data, 'base64');
    await fsP.writeFile(outputPdfPath, pdfBuffer);
    console.log(
      `✅ PDF 已生成: ${outputPdfPath} (${(pdfBuffer.length / 1024).toFixed(0)} KB)`
    );

    return outputPdfPath;
  } finally {
    ws.close(1000, 'done');
  }
}

// CLI entry point — only run when executed directly
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  const today = new Date().toISOString().split('T')[0];
  const reportsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../reports'
  );
  const inputPath = process.argv[2]
    || path.join(reportsDir, `report-${today}.md`);
  const outputPath = process.argv[3]
    || path.join(reportsDir, `twitter-daily-${today}.html`);

  generateDailyHtml(inputPath, outputPath, today);
}
