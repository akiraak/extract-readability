#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  TIMEOUT_MS: 60000,
  // 削除対象のセレクタ (ブラウザ内で削除実行)
  REMOVE_SELECTORS: 'script, style, noscript, iframe, svg, form, footer, nav, aside',
  // リソースブロック対象
  BLOCK_RESOURCES: ['image', 'stylesheet', 'font', 'media', 'imageset', 'object', 'beacon', 'csp_report']
};

// ==========================================
// メインロジック
// ==========================================

/**
 * 記事抽出のメインフロー (Puppeteer内で完結)
 */
async function extract(url, debugDir = null) {
  console.error(`[Browser] Launching...`);
  
  // ブラウザ起動
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();

    // 1. リソースのブロック設定 (高速化)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (CONFIG.BLOCK_RESOURCES.includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(CONFIG.USER_AGENT);

    // 2. ページ取得
    console.error(`[Browser] Fetching: ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT_MS });

    // bodyが表示されるまで待機（念のため）
    try { await page.waitForSelector('body', { timeout: 5000 }); } catch (e) {}

    // 3. Readability.js ライブラリをブラウザに注入
    // node_modulesの中からライブラリのパスを解決して読み込ませる
    const readabilityPath = require.resolve('@mozilla/readability/Readability.js');
    await page.addScriptTag({ path: readabilityPath });

    console.error('[Process] Parsing with Readability (inside Browser)...');

    // 4. ブラウザ内でパースを実行
    const result = await page.evaluate((removeSelectors) => {
      // 事前のDOMお掃除
      if (removeSelectors) {
        document.querySelectorAll(removeSelectors).forEach(el => el.remove());
      }

      // Readability実行
      // @ts-ignore (ブラウザ内にはReadabilityクラスが存在する)
      const reader = new Readability(document.cloneNode(true));
      const article = reader.parse();

      if (!article) return null;

      return {
        title: article.title,
        content: article.textContent.trim(),
        rawContent: document.documentElement.outerHTML // デバッグ用にHTML全体も取得可能にしておく
      };
    }, CONFIG.REMOVE_SELECTORS);

    if (!result) {
      throw new Error('Failed to parse article content.');
    }

    // 整形
    const output = {
      title: result.title,
      content: result.content,
      domain: new URL(url).hostname,
      url: url,
    };

    // 5. デバッグ情報の保存
    if (debugDir) {
      saveDebugFiles(debugDir, result.rawContent, output);
    }

    return output;

  } catch (error) {
    throw error;
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
    fs.writeFileSync(filePath, content || '');
    console.error(`[Debug] Saved ${name} to: ${filePath}`);
  });
}

/**
 * コマンドライン引数の解析
 */
function parseArgs() {
  const args = process.argv.slice(2);
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

    if (!targetUrl) {
      console.error('Usage: node extract.js <URL> [--debug-dir <OUTPUT_DIR>]');
      process.exit(1);
    }

    try {
      const result = await extract(targetUrl, debugDir);
      // 標準出力(stdout)にはJSONだけを出力する
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Failed:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { extract };