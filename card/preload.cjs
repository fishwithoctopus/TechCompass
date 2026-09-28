// card/preload.cjs — 桌面能力桥（保持 CommonJS，兼容 sandbox 预加载）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  setTheme: mode => ipcRenderer.send('tc:set-theme', mode),
  isElectron: true,
  setCollapsed: (collapsed) => ipcRenderer.send('tc:set-collapsed', collapsed),
  onCollapseToggle: (cb) => ipcRenderer.on('tc:toggle-collapse', () => cb()),
  onCollapseState: (cb) => ipcRenderer.on('tc:collapse-state', (_event, collapsed) => cb(collapsed)),
  hideWindow: () => ipcRenderer.send('tc:hide'),
  // 原生目录选择器（v0.2.0）：项目关联不再要求手写绝对路径
  pickFolder: () => ipcRenderer.invoke('tc:pick-folder'),
});
