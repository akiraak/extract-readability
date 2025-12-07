#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
  // ブラウザのふりをする（ヘッドレスモードの検出回避のため少し古めのChrome設定などを混ぜることも有効）
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  TIMEOUT_MS: 60000, // 念のため60秒に延長
};

// ==========================================
// 内部関数
// ==========================================

function createCleanDom(rawHtml, url) {
  // --- 追加: ログ抑制用の仮想コンソール設定 ---
  const virtualConsole = new VirtualConsole();
  
  // CSSパースエラーなどは無視し、それ以外は表示する
  virtualConsole.on("jsdomError", (err) => {
    if (err.message.includes("Could not parse CSS stylesheet")) {
      return; // 無視
    }
    console.error(err);
  });
  // ----------------------------------------

  // 変更: virtualConsole オプションを追加
  const dom = new JSDOM(rawHtml, { 
    url: url, 
    virtualConsole: virtualConsole 
  });

  const doc = dom.window.document;
  const elements = doc.querySelectorAll('script, style, noscript, iframe, svg, form, footer, nav, aside');
  elements.forEach(el => el.remove());
  return dom;
}

async function extract(url) {
  let browser;
  try {
    console.error(`[Browser] Launching...`);
    
    browser = await puppeteer.launch({ 
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] // メモリ不足対策も追加
    });
    const page = await browser.newPage();
    
    // 【対策1】不要なリソース（画像・CSS・フォント・メディア）をブロックして高速化
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      // 'document' と 'script' (SPA対策) 以外はブロック
      // ※ サイトによってはscriptをブロックすると動かないため許可していますが、
      //    それでも遅い場合は 'script' もブロックリストに入れて試してください。
      if (['image', 'stylesheet', 'font', 'media', 'imageset', 'object', 'beacon', 'csp_report'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(CONFIG.USER_AGENT);

    console.error(`[Browser] Fetching: ${url}...`);
    
    // 【対策2】待機条件を 'domcontentloaded' に緩和
    // これにより、画像や広告の読み込み完了を待たずに次に進みます
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT_MS });

    // 一部のSPA（Reactなど）はHTMLロード直後は空っぽの場合があるので、少しだけ待つ（保険）
    // 必要なければ削除可。Yahoo Finance等はこれで安定することが多い。
    try {
        await page.waitForSelector('body', { timeout: 5000 });
    } catch(e) {
        // 無視して進む
    }

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

    return result;

  } catch (error) {
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

// ==========================================
// 実行判定
// ==========================================
if (require.main === module) {
  (async () => {
    const targetUrl = process.argv[2];
    if (!targetUrl) {
      console.error('Usage: node extract.js <URL>');
      process.exit(1);
    }
    try {
      const result = await extract(targetUrl);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Failed:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { extract };