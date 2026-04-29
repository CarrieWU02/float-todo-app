const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 数据读写
  getData: () => ipcRenderer.invoke('get-data'),
  saveTodos: (todos) => ipcRenderer.invoke('save-todos', todos),

  // 窗口控制
  dragWindow: (deltaX, deltaY) => ipcRenderer.send('window-drag', { deltaX, deltaY }),
  hideWindow: () => ipcRenderer.send('window-hide'),
  setAlwaysOnTop: (value) => ipcRenderer.send('set-always-on-top', value),
  setWindowSize: (width, height) => ipcRenderer.send('set-window-size', { width, height }),
  bringToFront: () => ipcRenderer.send('bring-to-front'),
  sendToBack: () => ipcRenderer.send('send-to-back'),

  // 大象自动抓取（主流程）
  fetchXiaoXiang: (opts) => ipcRenderer.invoke('fetch-xiaoxiang', opts),
  cancelXxFetch: () => ipcRenderer.invoke('cancel-xx-fetch'),

  // 监听主进程推送的抓取状态
  onXxFetchStatus: (cb) => {
    ipcRenderer.on('xx-fetch-status', (_, status) => cb(status));
  },
  offXxFetchStatus: () => {
    ipcRenderer.removeAllListeners('xx-fetch-status');
  },

});
