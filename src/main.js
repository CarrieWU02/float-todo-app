const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 忽略 EPIPE 错误（打包后无终端时 console.log 会触发）
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') return; });
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') return; });

// ─── 自动更新 ────────────────────────────────────────────────────────────────
let autoUpdater = null;
function initAutoUpdater() {
  // 开发模式下不检查更新
  if (!app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;        // 有新版自动后台下载
    autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装

    autoUpdater.on('update-available', (info) => {
      dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `FloatTodo ${info.version} 正在后台下载，完成后下次启动自动安装。`,
        buttons: ['好的'],
      });
    });

    autoUpdater.on('update-downloaded', () => {
      dialog.showMessageBox({
        type: 'info',
        title: '更新就绪',
        message: '新版本已下载完成，点击"立即重启"以完成更新。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });

    // 启动 5 秒后开始检查，避免影响启动速度
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  } catch (e) {
    // electron-updater 加载失败时静默忽略，不影响正常使用
  }
}

// ─── 数据路径 ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(app.getPath('userData'), 'float-todo');
const DATA_FILE = path.join(DATA_DIR, 'todos.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) { console.error('loadData error:', e); }
  return { todos: {}, windowBounds: null };
}

function saveData(data) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error('saveData error:', e); }
}

// ─── 全局状态 ────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let appData = loadData();
let isQuitting = false;

// ─── 点击聚焦时置顶，失焦时沉底 ────────────────────────────────────────────
function bringToFront() {
  if (!mainWindow) return;
  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating', 1);
  } else {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }
}

function sendToBack() {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(false);
}

// ─── 创建主窗口 ──────────────────────────────────────────────────────────────
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  const savedBounds = appData.windowBounds;
  const winWidth = 380;
  const winHeight = 580;
  const defaultX = sw - winWidth - 20;
  const defaultY = sh - winHeight - 20;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: savedBounds ? savedBounds.x : defaultX,
    y: savedBounds ? savedBounds.y : defaultY,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    vibrancy: null,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // macOS: 跨工作区可见
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 点击聚焦 → 置顶；失焦 → 沉底
  mainWindow.on('focus', () => bringToFront());
  mainWindow.on('blur',  () => sendToBack());

  // 保存窗口位置
  mainWindow.on('moved', () => {
    const bounds = mainWindow.getBounds();
    appData.windowBounds = { x: bounds.x, y: bounds.y };
    saveData(appData);
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── 系统托盘 ────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    trayIcon = createFallbackIcon();
  }

  if (process.platform === 'darwin') {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  }

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
        data[idx] = 102; data[idx + 1] = 126; data[idx + 2] = 234; data[idx + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(data, { width: size, height: size });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ─── IPC 通信 ────────────────────────────────────────────────────────────────
ipcMain.handle('get-data', () => {
  return appData.todos || {};
});

ipcMain.handle('save-todos', (_, todos) => {
  appData.todos = todos;
  saveData(appData);
  return true;
});

ipcMain.on('window-drag', (_, { deltaX, deltaY }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const newX = x + deltaX;
  const newY = y + deltaY;
  mainWindow.setPosition(newX, newY);
  appData.windowBounds = { x: newX, y: newY };
  saveData(appData);
});

ipcMain.on('window-hide', () => {
  if (mainWindow) mainWindow.hide();
});

// 兼容旧调用（渲染进程不再需要主动调用）
ipcMain.on('set-always-on-top', () => {});
ipcMain.on('bring-to-front', () => {});
ipcMain.on('send-to-back', () => {});

ipcMain.on('set-window-size', (_, { width, height }) => {
  if (mainWindow) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setBounds({ x, y, width, height }, true);
  }
});

// ─── App 生命周期 ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  createWindow();
  createTray();
  initAutoUpdater();

  globalShortcut.register('CommandOrControl+Shift+T', () => {
    toggleWindow();
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
