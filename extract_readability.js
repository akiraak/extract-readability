#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const fs = require('fs');
const path = require('path');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  TIMEOUT_MS: 60000,
  // 削除対象のセレクタを定義
  REMOVE_SELECTORS: 'script, style, noscript, iframe, svg, form, footer, nav, aside',
  // リソースブロック対象
  BLOCK_RESOURCES: ['image', 'stylesheet', 'font', 'media', 'imageset', 'object', 'beacon', 'csp_report']
};

// ==========================================
// ヘルパー関数群 (Helpers)
// ==========================================

/**
 * HTMLから不要な要素を除去し、JSDOMオブジェクトを生成する
 */
function createCleanDom(rawHtml, url) {
  const virtualConsole = new VirtualConsole();
  
  // CSSパースエラーなどは抑制
  virtualConsole.on("jsdomError", (err) => {
    if (err.message.includes("Could not parse CSS stylesheet")) return; 
    console.error(err);
  });

  const dom = new JSDOM(rawHtml, { 
    url: url, 
    virtualConsole: virtualConsole 
  });

  const doc = dom.window.document;
  const elements = doc.querySelectorAll(CONFIG.REMOVE_SELECTORS);
  elements.forEach(el => el.remove());
  
  return dom;
}

/**
 * Puppeteerを使って指定URLのHTMLを取得する
 */
async function fetchHtmlWithBrowser(url) {
  console.error(`[Browser] Launching...`);
  const browser = await puppeteer.launch({ 
      headless: "new", 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    
    // リソースのブロック設定
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (CONFIG.BLOCK_RESOURCES.includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(CONFIG.USER_AGENT);

    console.error(`[Browser] Fetching: ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT_MS });

    // bodyが表示されるまで待機（エラー時は無視して進む）
    try { await page.waitForSelector('body', { timeout: 5000 }); } catch(e) {}

    return await page.content();

  } finally {
    await browser.close();
  }
}

/**
 * デバッグ用のファイル保存処理
 */
function saveDebugFiles(debugDir, rawHtml, result) {
  if (!debugDir) return;

  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const artifacts = [
    { name: 'original.html', content: rawHtml },
    { name: 'title.txt',     content: result.title },
    { name: 'content.txt',   content: result.content }
  ];

  artifacts.forEach(({ name, content }) => {
    const filePath = path.join(debugDir, name);
    fs.writeFileSync(filePath, content);
    console.error(`[Debug] Saved ${name} to: ${filePath}`);
  });
}

// ==========================================
// メインロジック
// ==========================================

/**
 * 記事抽出のメインフロー
 */
async function extract(url, debugDir = null) {
  try {
    // 1. ブラウザでHTMLを取得
    const rawHtml = await fetchHtmlWithBrowser(url);

    // 2. Readabilityで解析
    console.error('[Process] Parsing with Readability...');
    const dom = createCleanDom(rawHtml, url);
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      throw new Error('Failed to parse article content.');
    }

    const result = {
      title: article.title,
      content: article.textContent.trim(),
      domain: new URL(url).hostname,
      url: url,
    };

    // 3. デバッグ情報の保存
    if (debugDir) {
      saveDebugFiles(debugDir, rawHtml, result);
    }

    return result;

  } catch (error) {
    throw error;
  }
}

/**
 * コマンドライン引数の解析
 */
function parseArgs() {
  const args = process.argv.slice(2);
  
  // デバッグ表示
  console.error('--- [extract_readability.js] Received Args ---');
  console.error(args);
  console.error('----------------------------------------------');

  const targetUrl = args.find(arg => !arg.startsWith('-'));
  const debugIndex = args.findIndex(arg => arg === '--debug-dir' || arg === '-d');
  
  let debugDir = null;
  if (debugIndex !== -1 && args[debugIndex + 1]) {
    debugDir = args[debugIndex + 1];
  }

  return { targetUrl, debugDir };
}

// ==========================================
// エントリーポイント
// ==========================================
if (require.main === module) {
  (async () => {
    const { targetUrl, debugDir } = parseArgs();

    console.error(`[Debug] Target URL: ${targetUrl}`);
    console.error(`[Debug] Debug Dir:  ${debugDir}`);

    if (!targetUrl) {
      console.error('Usage: node extract.js <URL> [--debug-dir <OUTPUT_DIR>]');
      process.exit(1);
    }

    try {
      const result = await extract(targetUrl, debugDir);
      // JSON出力 (標準出力)
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Failed:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { extract };