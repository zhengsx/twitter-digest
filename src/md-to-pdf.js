import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const mdPath = process.argv[2] || '/Users/shuxin/Documents/Projects/twitter-digest/reports/twitter-daily-report-2026-02-04-v2.md';
const pdfPath = process.argv[3] || '/Users/shuxin/Documents/Projects/twitter-digest/reports/twitter-daily-report-2026-02-04-v2.pdf';

// 读取 Markdown 文件
const markdown = fs.readFileSync(mdPath, 'utf-8');

// 创建 PDF 文档
const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 50, bottom: 50, left: 50, right: 50 },
  bufferPages: true,
  info: {
    Title: 'Twitter 信源日报 - 2026-02-04',
    Author: 'OpenClaw AI Assistant',
    Subject: 'Twitter Daily Report',
  }
});

// 输出流
const stream = fs.createWriteStream(pdfPath);
doc.pipe(stream);

// 解析并渲染 Markdown
const lines = markdown.split('\n');

let inCodeBlock = false;
let currentY = doc.y;

for (const line of lines) {
  // 检查是否需要新页
  if (doc.y > 750) {
    doc.addPage();
  }
  
  // 代码块
  if (line.startsWith('```')) {
    inCodeBlock = !inCodeBlock;
    continue;
  }
  
  if (inCodeBlock) {
    doc.font('Courier').fontSize(9).text(line, { continued: false });
    continue;
  }
  
  // 一级标题
  if (line.startsWith('# ')) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(18).text(line.slice(2));
    doc.moveDown(0.5);
    continue;
  }
  
  // 二级标题
  if (line.startsWith('## ')) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(14).text(line.slice(3));
    doc.moveDown(0.3);
    continue;
  }
  
  // 三级标题
  if (line.startsWith('### ')) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(12).text(line.slice(4));
    doc.moveDown(0.2);
    continue;
  }
  
  // 引用
  if (line.startsWith('> ')) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666666').text(line.slice(2));
    doc.fillColor('#000000');
    continue;
  }
  
  // 分隔线
  if (line.startsWith('---')) {
    doc.moveDown(0.3);
    doc.strokeColor('#cccccc').lineWidth(0.5)
       .moveTo(50, doc.y)
       .lineTo(545, doc.y)
       .stroke();
    doc.moveDown(0.3);
    continue;
  }
  
  // 列表项
  if (line.startsWith('- ')) {
    const content = line.slice(2).replace(/\*\*([^*]+)\*\*/g, '$1');
    doc.font('Helvetica').fontSize(10).text('• ' + content, { indent: 10 });
    continue;
  }
  
  // 粗体行 (如 **原文:**)
  if (line.startsWith('**')) {
    const content = line.replace(/\*\*([^*]+)\*\*/g, '$1');
    if (line.includes('原文:') || line.includes('链接:') || line.includes('时间:')) {
      const parts = content.split(':');
      const label = parts[0];
      const value = parts.slice(1).join(':').trim();
      
      doc.font('Helvetica-Bold').fontSize(10).text(label + ':', { continued: true });
      doc.font('Helvetica').text(' ' + value);
    } else {
      doc.font('Helvetica-Bold').fontSize(10).text(content);
    }
    continue;
  }
  
  // 斜体 (如 *xxx followers*)
  if (line.startsWith('*') && line.endsWith('*')) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666666')
       .text(line.slice(1, -1));
    doc.fillColor('#000000');
    continue;
  }
  
  // 普通文本
  if (line.trim()) {
    doc.font('Helvetica').fontSize(10).text(line);
  } else {
    doc.moveDown(0.3);
  }
}

// 完成文档
doc.end();

stream.on('finish', () => {
  console.log(`✅ PDF 生成成功: ${pdfPath}`);
});

stream.on('error', (err) => {
  console.error('PDF 生成失败:', err);
  process.exit(1);
});
