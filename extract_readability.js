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
};

// ==========================================
// 内部関数
// ==========================================

function createCleanDom(rawHtml, url) {
  const virtualConsole = new VirtualConsole();
  
  virtualConsole.on("jsdomError", (err) => {
    if (err.message.includes("Could not parse CSS stylesheet")) {
      return; 
    }
    console.error(err);
  });

  const dom = new JSDOM(rawHtml, { 
    url: url, 
    virtualConsole: virtualConsole 
  });

  const doc = dom.window.document;
  const elements = doc.querySelectorAll('script, style, noscript, iframe, svg, form, footer, nav, aside');
  elements.forEach(el => el.remove());
  return dom;
}

/**
 * 記事を抽出する
 * @param {string} url 
 * @param {string|null} debugDir デバッグ出力先 (指定がない場合はnull)
 */
async function extract(url, debugDir = null) {
  let browser;
  try {
    // デバッグディレクトリの準備
    if (debugDir && !fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    console.error(`[Browser] Launching...`);
    
    browser = await puppeteer.launch({ 
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'imageset', 'object', 'beacon', 'csp_report'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(CONFIG.USER_AGENT);

    console.error(`[Browser] Fetching: ${url}...`);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT_MS });

    try {
        await page.waitForSelector('body', { timeout: 5000 });
    } catch(e) {
        // 無視
    }

    // 生のHTMLを取得
    const rawHtml = await page.content();
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

    // =========================================================
    // 追加: デバッグ出力 (HTML, タイトル, 本文を保存)
    // =========================================================
    if (debugDir) {
      // 1. 元のHTMLを保存
      const htmlPath = path.join(debugDir, 'original.html');
      fs.writeFileSync(htmlPath, rawHtml);
      console.error(`[Debug] Saved HTML to: ${htmlPath}`);

      // 2. タイトルを保存
      const titlePath = path.join(debugDir, 'title.txt');
      fs.writeFileSync(titlePath, result.title);
      console.error(`[Debug] Saved title to: ${titlePath}`);
      
      // 3. 本文を保存
      const contentPath = path.join(debugDir, 'content.txt');
      fs.writeFileSync(contentPath, result.content);
      console.error(`[Debug] Saved content to: ${contentPath}`);
    }

    return result;

  } catch (error) {
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

// ==========================================
// 実行判定 & 引数解析
// ==========================================
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    // 引数の内容を表示 (標準エラー出力に出すこと)
    console.error('--- [extract_readability.js] Received Args ---');
    console.error(args);
    console.error('----------------------------------------------');
    
    // オプション以外の引数をURLとみなす
    const targetUrl = args.find(arg => !arg.startsWith('-'));
    
    // --debug-dir または -d の後の値を取得
    const debugIndex = args.findIndex(arg => arg === '--debug-dir' || arg === '-d');
    let debugDir = null;
    
    if (debugIndex !== -1 && args[debugIndex + 1]) {
      debugDir = args[debugIndex + 1];
    }

    if (!targetUrl) {
      console.error('Usage: node extract.js <URL> [--debug-dir <OUTPUT_DIR>]');
      process.exit(1);
    }

    try {
      const result = await extract(targetUrl, debugDir);
      // 標準出力にはJSONを出す（パイプ処理などで使うため）
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Failed:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { extract };