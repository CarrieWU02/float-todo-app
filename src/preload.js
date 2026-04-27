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
});
