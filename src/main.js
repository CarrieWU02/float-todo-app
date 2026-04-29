const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { execFile } = require('child_process');

// 忽略 EPIPE 错误（打包后无终端时 console.log 会触发）
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') return; });
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') return; });

// ─── 自动更新 ────────────────────────────────────────────────────────────────
let autoUpdater = null;
function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      dialog.showMessageBox({
        type: 'info', title: '发现新版本',
        message: `FloatTodo ${info.version} 正在后台下载，完成后下次启动自动安装。`,
        buttons: ['好的'],
      });
    });
    autoUpdater.on('update-downloaded', () => {
      dialog.showMessageBox({
        type: 'info', title: '更新就绪',
        message: '新版本已下载完成，点击"立即重启"以完成更新。',
        buttons: ['立即重启', '稍后'], defaultId: 0,
      }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
    });
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  } catch (e) {}
}

// ─── 数据路径 ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(app.getPath('userData'), 'float-todo');
const DATA_FILE = path.join(DATA_DIR, 'todos.json');
const CATDESK_SOCK = path.join(process.env.HOME || '', '.catpaw', 'catdesk.sock');
const CATDESK_JSON = path.join(process.env.HOME || '', '.catpaw', 'catdesk.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) { console.error('loadData error:', e); }
  return { todos: {}, windowBounds: null };
}

function saveData(data) {
  ensureDataDir();
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8'); }
  catch (e) { console.error('saveData error:', e); }
}

// ─── CatDesk AI 调用（通过 Unix socket） ─────────────────────────────────────

/**
 * 确保 ~/.catpaw/catdesk.json 存在且包含 evaluation:true
 * 这是解锁 /cli/send 接口的前提条件
 */
function ensureCatdeskEvalMode() {
  try {
    let cfg = {};
    if (fs.existsSync(CATDESK_JSON)) {
      cfg = JSON.parse(fs.readFileSync(CATDESK_JSON, 'utf-8'));
    }
    if (cfg.evaluation !== true) {
      cfg.evaluation = true;
      fs.writeFileSync(CATDESK_JSON, JSON.stringify(cfg, null, 2), 'utf-8');
    }
  } catch (e) {
    console.warn('[CatdeskAI] ensureCatdeskEvalMode failed:', e.message);
  }
}

/**
 * 向 CatDesk socket 发送 HTTP 请求，返回响应里第一个完整 JSON 对象字符串
 * （自动处理 chunked encoding，不依赖严格分割）
 */
function socketRequest(method, urlPath, bodyStr) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(CATDESK_SOCK);
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf-8') : Buffer.alloc(0);
    const headers = [
      `${method} ${urlPath} HTTP/1.1`,
      `Host: localhost`,
      `Content-Type: application/json`,
      `Content-Length: ${bodyBuf.length}`,
      `Connection: close`,
      '',
      '',
    ].join('\r\n');

    const chunks = [];
    sock.setTimeout(90000);
    sock.on('connect', () => {
      sock.write(headers);
      if (bodyBuf.length) sock.write(bodyBuf);
    });
    sock.on('data', chunk => { chunks.push(chunk); });
    sock.on('end', () => {
      // 全部原始内容，直接用 safeParseJSON 提取第一个 { } 对象
      // 无需手动解码 chunked，因为 JSON 对象不会跨 chunk 边界断居
      const raw = Buffer.concat(chunks).toString('utf-8');
      resolve(raw);
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('socket timeout')); });
    sock.on('error', reject);
  });
}

/**
 * 安全 JSON 解析：只取第一个完整 JSON 对象（防止 body 末尾有多余内容）
 */
function safeParseJSON(str) {
  const s = (str || '').trim();
  // 找到第一个 { 开始，用括号计数找到匹配的 }
  const start = s.indexOf('{');
  if (start === -1) throw new SyntaxError('No JSON object found in: ' + s.slice(0, 100));
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape)          { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"')       { inStr = !inStr; continue; }
    if (inStr)           { continue; }
    if (c === '{')       { depth++; }
    else if (c === '}')  { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  throw new SyntaxError('Unmatched braces in: ' + s.slice(0, 100));
}

/**
 * 获取当前 CatDesk 会话的 conversationId
 */
async function getCatdeskConversationId() {
  const raw = await socketRequest('POST', '/cli/session', JSON.stringify({ sessionAction: 'current' }));
  console.log('[CatdeskAI] /cli/session raw:', raw.slice(0, 300));
  const resp = safeParseJSON(raw);
  if (!resp.success) throw new Error('获取 CatDesk 会话失败: ' + resp.error);
  const session = typeof resp.data?.result === 'string' ? safeParseJSON(resp.data.result) : (resp.data?.result || {});
  return session.conversationId;
}

/**
 * 订阅 SSE 流，拼接所有 model_chunk 内容，等待 done 事件
 */
function readCatdeskStream(streamId) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(CATDESK_SOCK);
    const req = [
      `GET /cli/stream/${streamId} HTTP/1.1`,
      `Host: localhost`,
      `Connection: close`,
      '',
      '',
    ].join('\r\n');

    let raw = '';
    let content = '';
    sock.setTimeout(120000);
    sock.on('connect', () => sock.write(req));
    let resolved = false;
    const finish = (val) => { if (!resolved) { resolved = true; sock.destroy(); resolve(val); } };
    const fail   = (err) => { if (!resolved) { resolved = true; sock.destroy(); reject(err); } };

    sock.on('data', chunk => {
      raw += chunk.toString();
      // 逐行解析 SSE
      const lines = raw.split('\n');
      raw = lines.pop(); // 保留未完整的行
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        // 标准 SSE 结束标志
        if (payload === '[DONE]') { finish(content); continue; }
        try {
          const evt = JSON.parse(payload);
          // 调试：打印每个事件的 kind 和结构（只打前200字）
          console.log('[SSE-evt]', JSON.stringify(evt).slice(0, 200));
          // 拼接 AI 输出内容 —— 兼容多种字段名
          const chunk_content =
            (evt.kind === 'event' && evt.data?.type === 'model_chunk' && evt.data?.content) ? evt.data.content :
            (evt.type === 'model_chunk' && evt.content) ? evt.content :
            (evt.delta?.content) ? evt.delta.content :
            (evt.choices?.[0]?.delta?.content) ? evt.choices[0].delta.content :
            null;
          if (chunk_content) {
            content += chunk_content;
          }
          // 完成事件 —— 兼容多种格式
          const isDone =
            evt.kind === 'done' ||
            evt.type === 'done' ||
            (evt.kind === 'status' && (evt.data?.status === 'success' || evt.data?.status === 'done')) ||
            (evt.status === 'success') ||
            (evt.choices?.[0]?.finish_reason === 'stop');
          if (isDone) { finish(content); }
          // 错误事件
          const isError =
            (evt.kind === 'status' && evt.data?.status === 'error') ||
            (evt.status === 'error') ||
            (evt.type === 'error');
          if (isError) {
            fail(new Error(evt.data?.message || evt.message || 'CatDesk AI 返回错误'));
          }
        } catch (_) {}
      }
    });
    sock.on('end', () => {
      console.log('[SSE-end] content length:', content.length, '| preview:', content.slice(0, 100));
      finish(content);
    });
    sock.on('timeout', () => fail(new Error('stream timeout')));
    sock.on('error', fail);
  });
}

/**
 * 通过 CatDesk 当前会话调用 AI 分析文本，返回解析后的 JSON 对象
 */
async function callCatdeskAI(prompt) {
  ensureCatdeskEvalMode();

  // 检查 socket 是否存在
  if (!fs.existsSync(CATDESK_SOCK)) {
    throw new Error('CatDesk 未运行，请先启动 CatDesk 应用');
  }

  const conversationId = await getCatdeskConversationId();

  // 发送消息，获取 streamId
  const sendBody = JSON.stringify({
    message: prompt,
    dir: app.getPath('userData'),
    conversationId,
    files: [],
    wait: true,
    autoConfirm: true,
  });
  const sendRaw = await socketRequest('POST', '/cli/send', sendBody);
  console.log('[CatdeskAI] /cli/send raw:', sendRaw.slice(0, 300));
  const sendResp = safeParseJSON(sendRaw);
  if (!sendResp.success) throw new Error('发送消息失败: ' + sendResp.error);

  const streamId = sendResp.data?.streamId;
  if (!streamId) throw new Error('未获取到 streamId');

  // 读取流式响应
  const aiText = await readCatdeskStream(streamId);

  // 从 AI 回复中提取 JSON
  // 策略 1：优先剥离 Markdown 代码块 ```json ... ```
  let textToParse = aiText;
  const codeBlock = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) textToParse = codeBlock[1].trim();

  // 策略 2：贪婪提取最外层 JSON 对象（处理 AI 在 JSON 前后添加说明文字的情况）
  let parsed = null;
  const greedyMatch = textToParse.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    try { parsed = JSON.parse(greedyMatch[0]); } catch (_) {}
  }

  // 策略 3：逐段尝试（兼容 AI 返回多个 JSON 块的情况）
  if (!parsed) {
    const jsonMatches = [...aiText.matchAll(/\{[\s\S]*?\}/g)];
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      try {
        const candidate = JSON.parse(jsonMatches[i][0]);
        if (candidate && typeof candidate === 'object') { parsed = candidate; break; }
      } catch (_) {}
    }
  }

  if (!parsed) {
    throw new Error('AI 返回格式异常，未找到 JSON 块\n原始回复：' + aiText.slice(0, 300));
  }
  return parsed;
}

// ─── catdesk browser-action 封装 ────────────────────────────────────────────

// 查找 catdesk 可执行路径
function getCatdeskPath() {
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, '.catdesk', 'bin', 'catdesk'),   // CatDesk 标准安装路径
    path.join(home, '.catpaw',  'bin', 'catdesk'),   // 兼容旧路径
    '/Applications/CatDesk.app/Contents/Resources/bin/catdesk',
    '/usr/local/bin/catdesk',
    '/opt/homebrew/bin/catdesk',
    'catdesk',
  ];
  for (const p of candidates) {
    try {
      if (p === 'catdesk') return p; // 最后尝试 PATH
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return 'catdesk';
}

// 执行 catdesk browser-action 命令，返回解析后的 JSON 结果
function catdeskBrowserAction(actionJson) {
  return new Promise((resolve, reject) => {
    const catdesk = getCatdeskPath();
    // 把 script 字段压成单行（去除换行和多余空白），防止命令行参数被 shell 拆断
    let obj = typeof actionJson === 'string' ? (() => { try { return JSON.parse(actionJson); } catch(_) { return null; } })() : actionJson;
    if (obj && typeof obj === 'object' && typeof obj.script === 'string') {
      obj = Object.assign({}, obj, {
        script: obj.script.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim()
      });
    }
    const arg = JSON.stringify(obj || actionJson);
    execFile(catdesk, ['browser-action', arg], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`catdesk browser-action 失败: ${err.message}\n${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (_) {
        // 非 JSON 输出也算成功（某些命令不返回 JSON）
        resolve({ success: true, raw: stdout.trim() });
      }
    });
  });
}

// 将抓取结果格式化为纯文本供 AI 分析
function formatMessagesForAI(sessions) {
  if (!sessions || sessions.length === 0) return '';
  return sessions.map(s => {
    const header = `=== 会话：${s.sessionName} ===`;
    const msgs = s.messages.map(m => {
      const who = m.sender ? `${m.sender}：` : '';
      return `${who}${m.text}`;
    }).join('\n');
    return `${header}\n${msgs}`;
  }).join('\n\n');
}

// ─── 大象网页版 DOM 脚本 ──────────────────────────────────────────────────────

/**
 * 检查页面是否已完成加载（会话列表可见）
 * 返回 { loaded: bool, count: number, needLogin: bool, loading: bool }
 *
 * 状态优先级：
 *   1. loaded=true  → 会话列表已渲染，可以开始抓取
 *   2. needLogin=true → 明确看到登录 UI（二维码/密码框）
 *   3. loading=true → 正在跳转/加载，继续等待
 */
function buildCheckLoadedScript() {
  return `(function() {
  var url = location.href;
  var SESSION_SELS = ['li[class*="Session"]','li[class*="session"]','li[class*="conversation"]','[role="listitem"][class*="item"]','[data-testid*="session"]','div[class*="SessionItem"]','div[class*="sessionItem"]','ul[class*="sessionList"] > li','ul[class*="SessionList"] > li','div[class*="chatList"] li','div[class*="ChatList"] li'];
  var items = [];
  for (var i = 0; i < SESSION_SELS.length; i++) {
    items = Array.from(document.querySelectorAll(SESSION_SELS[i]));
    if (items.length > 1) break;
  }
  if (items.length > 1) return JSON.stringify({ loaded: true, count: items.length });
  var hasQr = !!document.querySelector('[class*="qrcode"],[class*="QrCode"],[class*="qrCode"],canvas[class*="qr"]');
  var hasPassword = !!document.querySelector('input[type="password"]');
  var hasLoginBtn = !!document.querySelector('button[class*="login"],button[class*="Login"]');
  var loginKeys = ['/login','/passport','/sso','account.meituan','login.meituan'];
  var isLoginUrl = loginKeys.some(function(k){ return url.indexOf(k) !== -1; });
  if (hasQr || hasPassword || (hasLoginBtn && isLoginUrl)) return JSON.stringify({ needLogin: true, url: url });
  return JSON.stringify({ loading: true, url: url, itemsFound: items.length });
})()`.trim();
}

/**
 * Get target session list: prefer unread, fallback to first N
 * DOM: li[class*="session"]
 * Returns { targets: [{index, name}], total, unreadCount }
 */
function buildGetSessionsScript(maxSessions) {
  return `(function() {
  var items = Array.from(document.querySelectorAll('li[class*="session"]'));
  if (items.length === 0) return JSON.stringify({ error: 'no sessions' });
  var unread = items.filter(function(el) { return el.classList.contains('unread'); });
  var unreadSet = new Set(unread);
  var sorted = unread.concat(items.filter(function(el){ return !unreadSet.has(el); }));
  var targets = sorted.slice(0, ${Number(maxSessions) || 20});
  var result = targets.map(function(el, idx) {
    var nameEl = el.querySelector('.wrapper-name, [class*="wrapper-name"], [class*="session-name"]');
    var name = nameEl ? nameEl.textContent.trim() : el.innerText.split('\n').filter(function(s){ return s.trim() && !/^\d+$/.test(s.trim()); })[0] || ('session' + idx);
    return { index: items.indexOf(el), name: name, unread: unreadSet.has(el) };
  });
  return JSON.stringify({ targets: result, total: items.length, unreadCount: unread.length });
})()`.trim();
}

/**
 * Click the session at given index
 */
function buildClickSessionScript(index) {
  return `(function() {
  var items = Array.from(document.querySelectorAll('li[class*="session"]'));
  var el = items[${Number(index)}];
  if (!el) return JSON.stringify({ error: 'not found' });
  el.click();
  return JSON.stringify({ ok: true, name: el.innerText.split('\n')[0] });
})()`.trim();
}

/**
 * Scroll up to load history, then fetch all messages within hoursBack
 * Returns { sessionName, messages: [{sender, text, isMe, time}], scrolled }
 */
function buildScrollToTopScript() {
  return `(function() {
  var container = document.querySelector('.bubble_list_message, .bubbleMessageListContainer, [class*="bubble_list"]');
  if (!container) return JSON.stringify({ ok: false, error: 'no container' });
  var before = container.scrollTop;
  container.scrollTop = 0;
  return JSON.stringify({ ok: true, before: before, after: container.scrollTop });
})()`.trim();
}

function buildFetchMessagesScript(hoursBack) {
  return `(function() {
  var hoursBack = ${Number(hoursBack) || 24};
  var now = Date.now();
  var cutoff = now - hoursBack * 3600 * 1000;
  var titleEl = document.querySelector('.wrapper-name, .group-title, .titlebar .title-content');
  var sessionName = titleEl ? titleEl.innerText.trim() : (document.title || 'session');
  var container = document.querySelector('.bubble_list_message, .bubbleMessageListContainer, [class*="bubble_list"]');
  if (!container) return JSON.stringify({ sessionName: sessionName, messages: [], error: 'no container' });
  function parseTime(str) {
    if (!str) return 0;
    str = str.trim();
    var now2 = new Date();
    if (/^\d{1,2}:\d{2}$/.test(str)) {
      var parts = str.split(':');
      return new Date(now2.getFullYear(), now2.getMonth(), now2.getDate(), +parts[0], +parts[1]).getTime();
    }
    var m1 = str.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (m1) return new Date(now2.getFullYear(), +m1[1]-1, +m1[2], +m1[3], +m1[4]).getTime();
    var m2 = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (m2) return new Date(str).getTime();
    return new Date(str).getTime() || 0;
  }
  var msgs = [];
  var lastTime = 0;
  var allNodes = Array.from(container.querySelectorAll('.bubble-item, [class*="bubble-item"], .time-line, [class*="timeLine"], [class*="time-line"]'));
  for (var i = 0; i < allNodes.length; i++) {
    var node = allNodes[i];
    if (node.classList.contains('time-line') || /time.?line/i.test(node.className)) {
      var t = parseTime(node.innerText.trim());
      if (t) lastTime = t;
      continue;
    }
    var timeSpan = node.querySelector('.bubble-item-time, [class*="bubble-item-time"]');
    if (timeSpan) { var tt = parseTime(timeSpan.innerText.trim()); if (tt) lastTime = tt; }
    if (lastTime > 0 && lastTime < cutoff) continue;
    var textEl = node.querySelector('span.dx-message-text, [class*="message-text"]');
    if (!textEl) continue;
    var text = textEl.innerText.trim();
    if (!text || text.length < 2 || text.length > 8000) continue;
    var isMe = node.classList.contains('me');
    var sender = isMe ? 'me' : '';
    if (!isMe) {
      var senderEl = node.querySelector('[class*="nickname"], [class*="sender"]');
      sender = senderEl ? senderEl.innerText.trim() : '';
      if (!sender) sender = node.getAttribute('data-sender') || '';
    }
    msgs.push({ sender: sender, text: text, isMe: isMe, time: lastTime });
  }
  return JSON.stringify({ sessionName: sessionName, messages: msgs });
})()`.trim();
}

// ─── 主抓取流程 ───────────────────────────────────────────────────────────────
let xxFetchAborted = false;

/** 解析 browser-action evaluate 结果为对象
 *  browser-action 实际返回结构：{ success, data: { result: "<JSON字符串>" } }
 */
function parseEvalResult(result) {
  try {
    // 优先取 data.result（browser-action evaluate 标准路径）
    const raw = result?.data?.result ?? result?.result ?? result?.raw ?? '';
    if (typeof raw === 'object' && raw !== null) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      return JSON.parse(raw);
    }
    return {};
  } catch (e) {
    console.warn('[parseEvalResult] parse failed:', e.message, '| raw:', JSON.stringify(result)?.slice(0, 200));
    return {};
  }
}

/** 截图并把路径写入 console，方便调试 */
async function debugScreenshot(label) {
  try {
    const r = await catdeskBrowserAction({ action: 'screenshot' });
    const p = r?.data?.path || r?.path || '(no path)';
    console.log(`[XX-DEBUG] screenshot [${label}]:`, p);
  } catch (e) {
    console.warn('[XX-DEBUG] screenshot failed:', e.message);
  }
}

async function fetchXiaoXiangMessages(hoursBack, onStatus) {
  const XX_URL = 'https://daxiang.sankuai.com';
  xxFetchAborted = false;

  onStatus({ stage: 'connecting', msg: '正在打开大象网页版…' });

  // 1. 导航（domcontentloaded 比 networkidle 快 2~3s）
  try {
    await catdeskBrowserAction({ action: 'navigate', url: XX_URL, waitUntil: 'domcontentloaded' });
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('ERR_NAME_NOT_RESOLVED') || msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ERR_NETWORK')) {
      throw new Error('DNS 解析失败：无法访问大象网页版\n\n请先连接公司内网或 VPN，然后重试。');
    }
    if (msg.includes('ERR_TIMED_OUT') || msg.includes('timeout')) {
      throw new Error('连接超时：大象网页版响应过慢\n\n请检查网络连接后重试。');
    }
    // 其他错误只取关键一行，不把完整 stderr 暴露给用户
    const firstLine = msg.split('\n')[0].replace(/catdesk browser-action 失败[:：]/i, '').trim();
    throw new Error('无法打开大象网页版：' + firstLine + '\n\n请确认已连接公司内网或 VPN。');
  }
  if (xxFetchAborted) throw new Error('cancelled');

  // 2. 等待页面稳定，最多轮询 20s
  onStatus({ stage: 'connecting', msg: '等待大象页面加载…' });
  let loaded = false;
  let needLogin = false;
  for (let i = 0; i < 20; i++) {
    if (xxFetchAborted) throw new Error('cancelled');
    await catdeskBrowserAction({ action: 'wait', timeout: 1000 });
    const checkResult = await catdeskBrowserAction({ action: 'evaluate', script: buildCheckLoadedScript() });
    const checkData = parseEvalResult(checkResult);
    console.log(`[XX] checkLoaded[${i}]:`, JSON.stringify(checkData));

    if (checkData.loaded)    { loaded = true;    break; }
    if (checkData.needLogin) { needLogin = true;  break; }
    // checkData.loading=true 或空对象 → 继续等待
  }
  if (xxFetchAborted) throw new Error('cancelled');

  // 3. 登录处理 —— 显示扫码提示，轮询等待登录完成（最多 2 分钟）
  if (needLogin) {
    onStatus({ stage: 'login', msg: '请在弹出的浏览器窗口中完成大象扫码登录…' });
    await debugScreenshot('login-page');

    for (let i = 0; i < 60; i++) {
      if (xxFetchAborted) throw new Error('cancelled');
      await catdeskBrowserAction({ action: 'wait', timeout: 2000 });
      const checkResult = await catdeskBrowserAction({ action: 'evaluate', script: buildCheckLoadedScript() });
      const checkData = parseEvalResult(checkResult);
      console.log(`[XX] waitLogin[${i}]:`, JSON.stringify(checkData));

      if (checkData.loaded) { loaded = true; break; }
      // needLogin=true → 还在扫码页，继续等；loading=true → 跳转中，继续等
    }
    if (!loaded) {
      await debugScreenshot('login-timeout');
      throw new Error('登录等待超时（120s），请重试');
    }
    onStatus({ stage: 'logged_in', msg: '登录成功，开始抓取…' });
  }

  if (!loaded) {
    await debugScreenshot('load-failed');
    throw new Error('大象页面加载失败（超时），请检查网络或 VPN 连接后重试');
  }

  onStatus({ stage: 'fetching', msg: '正在扫描会话列表…' });
  // 多等 1s，确保动态内容渲染完成
  await catdeskBrowserAction({ action: 'wait', timeout: 1200 });
  if (xxFetchAborted) throw new Error('cancelled');

  // 4. 获取目标会话列表
  const sessionsResult = await catdeskBrowserAction({ action: 'evaluate', script: buildGetSessionsScript(10) });
  const sessionsData = parseEvalResult(sessionsResult);
  console.log('[XX] sessionsData:', JSON.stringify(sessionsData)?.slice(0, 300));

  if (sessionsData.error) {
    await debugScreenshot('sessions-error');
    throw new Error(sessionsData.error);
  }

  const targets = sessionsData.targets || [];
  if (targets.length === 0) {
    await debugScreenshot('no-sessions');
    throw new Error('未找到任何会话，请确认大象已正常加载');
  }

  onStatus({ stage: 'fetching', msg: `发现 ${targets.length} 个有效会话，开始逐一读取…` });

  // 5. 逐个会话点击抓取
  const sessions = [];
  for (let i = 0; i < targets.length; i++) {
    if (xxFetchAborted) throw new Error('cancelled');
    const t = targets[i];
    onStatus({ stage: 'fetching', msg: `读取第 ${i + 1}/${targets.length} 个会话：${t.name}` });

    await catdeskBrowserAction({ action: 'evaluate', script: buildClickSessionScript(t.index) });
    await catdeskBrowserAction({ action: 'wait', timeout: 1000 });
    if (xxFetchAborted) throw new Error('cancelled');

    // scroll to top to load history messages (lazy-loaded), repeat until stable
    for (let s = 0; s < 8; s++) {
      if (xxFetchAborted) throw new Error('cancelled');
      const scrollRes = parseEvalResult(await catdeskBrowserAction({ action: 'evaluate', script: buildScrollToTopScript() }));
      await catdeskBrowserAction({ action: 'wait', timeout: 600 });
      if (scrollRes.after === 0) break; // already at top
    }
    if (xxFetchAborted) throw new Error('cancelled');

    const msgResult = await catdeskBrowserAction({ action: 'evaluate', script: buildFetchMessagesScript(hoursBack) });
    const msgData = parseEvalResult(msgResult);
    console.log(`[XX] session[${i}] "${t.name}": ${msgData.messages?.length || 0} msgs`);

    if (msgData.messages && msgData.messages.length > 0) {
      sessions.push({ sessionName: msgData.sessionName || t.name, messages: msgData.messages });
    }
  }

  if (sessions.length === 0) {
    await debugScreenshot('no-messages');
    throw new Error(`最近 ${hoursBack} 小时内未抓取到有效消息，可尝试扩大时间范围`);
  }

  const totalMsgs = sessions.reduce((n, s) => n + s.messages.length, 0);
  onStatus({ stage: 'analyzing', msg: `抓取到 ${totalMsgs} 条消息，AI 分析中…` });

  return sessions;
}

// ─── 全局状态 ────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let appData = loadData();
let isQuitting = false;

function bringToFront() {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(true, 'normal');
  mainWindow.focus();
}

function sendToBack() {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(false);
}

// ─── 创建主窗口 ──────────────────────────────────────────────────────────────
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const savedBounds = appData.windowBounds;
  const winWidth  = savedBounds?.width  || 380;
  const winHeight = savedBounds?.height || 580;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: savedBounds ? savedBounds.x : sw - winWidth - 20,
    y: savedBounds ? savedBounds.y : sh - winHeight - 20,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    resizable: true,
    minWidth: 280,
    minHeight: 320,
    skipTaskbar: true,
    hasShadow: false,
    vibrancy: null,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.platform === 'darwin') mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('focus', () => bringToFront());
  mainWindow.on('blur',  () => sendToBack());

  const saveBounds = () => {
    const bounds = mainWindow.getBounds();
    appData.windowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    saveData(appData);
  };
  mainWindow.on('moved', saveBounds);
  mainWindow.on('resized', saveBounds);
  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── 系统托盘 ────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : createFallbackIcon();
  if (process.platform === 'darwin') trayIcon = trayIcon.resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('Float Todo - 每日待办');
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示/隐藏', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => toggleWindow());
}

function createFallbackIcon() {
  const size = 16;
  const data = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        data[idx] = 102; data[idx+1] = 126; data[idx+2] = 234; data[idx+3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(data, { width: size, height: size });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ─── IPC 通信 ────────────────────────────────────────────────────────────────
ipcMain.handle('get-data', () => appData.todos || {});

ipcMain.handle('save-todos', (_, todos) => {
  appData.todos = todos;
  saveData(appData);
  return true;
});

ipcMain.on('window-drag', (_, { deltaX, deltaY }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const newX = x + deltaX, newY = y + deltaY;
  mainWindow.setPosition(newX, newY);
  appData.windowBounds = { x: newX, y: newY };
  saveData(appData);
});

ipcMain.on('window-hide', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('set-always-on-top', () => {});
ipcMain.on('bring-to-front', () => {});
ipcMain.on('send-to-back', () => {});

ipcMain.on('set-window-size', (_, { width, height }) => {
  if (!mainWindow) return;
  const [cw] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  if (width === 54 && height === 54) mainWindow.setBounds({ x, y, width: 54, height: 54 }, true);
  else mainWindow.setBounds({ x, y, width: cw, height }, true);
});

// ─── 大象待办提取 IPC（自动抓取 → CatDesk AI 分析） ───────────────────────
ipcMain.handle('fetch-xiaoxiang', async (event, { hoursBack = 24 } = {}) => {
  const onStatus = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('xx-fetch-status', status);
    }
  };

  try {
    // 1. 自动抓取大象消息
    const sessions = await fetchXiaoXiangMessages(hoursBack, onStatus);
    if (xxFetchAborted) return { cancelled: true };

    // 2. 格式化成 AI 可读文本
    const rawText = formatMessagesForAI(sessions);
    const totalMsgs = sessions.reduce((n, s) => n + s.messages.length, 0);

    onStatus({ stage: 'analyzing', msg: `已抓取 ${totalMsgs} 条消息，CatDesk AI 正在分析…` });

    // 3. 调用 CatDesk AI 提取待办
    const prompt = `你是一位高效的业务运营助理，请从以下大象聊天记录（含全量消息和会议纪要）中提取所有与"我"相关的待办事项。

识别规则（满足任意一条即提取）：
1. 含有明确行动意图的关键词：待办、todo、TODO、to-do、跟进、follow up、讨论、梳理、排期、计划、确认、需要、记得、别忘了、安排、帮忙、麻烦、请、尽快、ASAP、deadline、截止、提醒、action item、AI
2. 消息中出现 @我（@吴耿玥 或 @我 或 @wugengyue）的内容，无论是否含关键词，均视为需要我处理的事项
3. 别人在消息中明确提到让"你/你这边/你来/你负责/你帮"做某事
4. 消息中含有"？"且涉及需要我回复或确认的问题
5. 会议纪要/会议总结中分配给"吴耿玥"或"我"的行动项，包括：会议决议、分工事项、负责人为我的任务、"ACTION"/"行动项"/"跟进事项"列表中属于我的条目

状态判断：
- 进行中：已在推进，有明确负责人或已开始
- 被阻塞：依赖他人/等待资源/有障碍未解决
- 待确认：需要明确答复、审批、决策的事项

优先级判断：
- high：有明确截止日期/今明两天/ASAP/紧急
- medium：本周内需要处理/影响他人进度
- low：无明确时间/可推迟处理

约束：
- 严禁虚构，仅基于原文提取
- 已明确完成的事项不要输出
- 每条描述简洁，不超过30字
- 若消息来自会议纪要，project 字段填写会议名称

必须只输出以下 JSON 格式，不要有任何多余文字：
{"items":[{"text":"待办事项简洁描述","project":"所属项目/场景或会议名","priority":"high|medium|low","status":"进行中|被阻塞|待确认","context":"一句话背景说明"}]}

以下是大象聊天记录：

${rawText}`;

    const result = await callCatdeskAI(prompt);
    if (xxFetchAborted) return { cancelled: true };

    return {
      items: result.items || [],
      stats: { sessions: sessions.length, messages: totalMsgs, hoursBack },
    };
  } catch (e) {
    if (e.message === 'cancelled') return { cancelled: true };
    return { error: e.message };
  }
});

// 取消正在进行的抓取
ipcMain.handle('cancel-xx-fetch', () => {
  xxFetchAborted = true;
  return true;
});

// ─── App 生命周期 ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  createWindow();
  createTray();
  initAutoUpdater();
  globalShortcut.register('CommandOrControl+Shift+T', () => toggleWindow());
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', () => { if (mainWindow) mainWindow.show(); });
app.on('before-quit', () => { isQuitting = true; xxFetchAborted = true; globalShortcut.unregisterAll(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
