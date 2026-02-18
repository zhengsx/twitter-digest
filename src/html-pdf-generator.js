#!/usr/bin/env node
/**
 * html-pdf-generator.js
 * Markdown → HTML generator (senior-friendly mobile layout)
 *
 * Usage:
 *   node src/html-pdf-generator.js [input.md] [output.html]
 *
 * Defaults:
 *   input  = reports/report-YYYY-MM-DD.md
 *   output = reports/twitter-daily-YYYY-MM-DD.html
 */

import fs from 'fs';
import path from 'path';
import markdownit from 'markdown-it';

const md = markdownit({ html: true, linkify: true, typographer: true });

const today = new Date().toISOString().split('T')[0];
const reportsDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../reports'
);

const inputPath  = process.argv[2]
  || path.join(reportsDir, `report-${today}.md`);
const outputPath = process.argv[3]
  || path.join(reportsDir, `twitter-daily-${today}.html`);

if (!fs.existsSync(inputPath)) {
  console.error(`❌ 文件不存在: ${inputPath}`);
  process.exit(1);
}

const markdown = fs.readFileSync(inputPath, 'utf-8');
const body = md.render(markdown);

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

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Twitter 信源日报 - ${today}</title>
  <style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;

fs.writeFileSync(outputPath, html, 'utf-8');
console.log(`✅ HTML 已生成: ${outputPath}`);
