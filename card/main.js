// card/main.js — Electron 壳：托盘 + 无边框置顶悬浮窗 + 全局快捷键。
// 业务逻辑全部由内嵌 daemon（lib/server.js）承担，窗口只加载 http://127.0.0.1:<port>/ui/
import { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, nativeImage, dialog, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../lib/server.js';
import { defaultDataDir } from '../lib/store.js';
import { cardShortcut } from '../lib/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PACKAGED = app.isPackaged;
const UI_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'app.asar', 'ui')
  : path.join(__dirname, '..', 'ui');
const ICON_PATH = IS_PACKAGED
  ? path.join(process.resourcesPath, 'app.asar', 'build', 'icon.png')
  : path.join(__dirname, '..', 'build', 'icon.png');

const WIN_W = 400;
const WIN_H_EXPANDED = 580;
const WIN_H_COLLAPSED = 54;
const MARGIN = 14;

let win = null;
let tray = null;
let daemon = null;
let quitting = false;
const shortcut = cardShortcut(process.platform);

// An explicitly separate data directory also isolates the Electron single-instance lock.
if (process.env.TECHCOMPASS_HOME) app.setPath('userData', path.join(path.resolve(process.env.TECHCOMPASS_HOME), 'electron'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });

  app.whenReady().then(async () => {
    daemon = await startDaemon({ dataDir: defaultDataDir(), uiDir: UI_DIR, encryption: safeStorage.isEncryptionAvailable() ? safeStorage : undefined });
    createTray();
    createWindow();
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: '窗口', submenu: [{ label: '显示卡片', click: showWindow }] },
    ]));
    globalShortcut.register(shortcut, toggleWindow);
  });

  app.on('window-all-closed', (e) => { /* 托盘常驻 */ });
  app.on('activate', showWindow);

  app.on('before-quit', async () => {
    quitting = true;
    globalShortcut.unregisterAll();
    tray?.destroy();
    try { await daemon?.stop(); } catch { /* 尽力而为 */ }
  });
}

function bottomRightBounds(height) {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(wa.x + wa.width - WIN_W - MARGIN),
    y: Math.round(wa.y + wa.height - height - MARGIN),
    width: WIN_W,
    height,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...bottomRightBounds(WIN_H_EXPANDED),
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#15171c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${daemon.port}/ui/?token=${daemon.token}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) shell.openExternal(u.href); } catch { /* 拒绝无效来源地址 */ }
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  const icon = fs.existsSync(ICON_PATH)
    ? nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('TechCompass — 新技术 × 我的项目');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示 / 隐藏卡片（${shortcut}）`, click: toggleWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', toggleWindow);
}

function showWindow() {
  if (!win) return;
  win.setBounds(bottomRightBounds(win.getBounds().height < 100 ? WIN_H_EXPANDED : win.getBounds().height));
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

ipcMain.on('tc:set-collapsed', (_e, collapsed) => {
  if (!win) return;
  const cur = win.getBounds();
  const targetH = collapsed ? WIN_H_COLLAPSED : WIN_H_EXPANDED;
  const bottom = cur.y + cur.height;
  win.setBounds({ x: cur.x, y: Math.round(bottom - targetH), width: WIN_W, height: targetH });
});

// 原生目录选择器：项目关联用系统对话框选目录，不手写路径
ipcMain.handle('tc:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths?.length ? null : r.filePaths[0];
});
