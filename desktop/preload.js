// AgentXRay 桌面宠物壳 —— preload（contextBridge 桥）。
//
// 只暴露最小面：渲染层只能「表达意图」与「订阅推送」，**无 Node、无任意 IPC、无任意 URL**。
// 主进程不接受 renderer 传入的任意 URL/命令（open-session 只接受 {platform,sessionId,agent}）。
//
// 暴露面（window.pet）：
//   getInfo()                  → Promise<{host,port,geom,grid,states,skin,debug}>
//   openSession({platform,sessionId,agent}) → Promise<OpenSessionResult>   // N1：只跳转，永不回复
//   setInteractive(bool)       → Promise<true>                             // pointer 是否在热区
//   drag({phase:'start'|'end'})→ Promise<true>                             // ⌘/右键拖动移动窗口
//   onState(cb)                → off()   // 主进程推送 pet:state
//   onStatus(cb)               → off()   // pet:status {connected}
//   onFullscreen(cb)           → off()   // pet:fullscreen {hidden}
//   onOpenResult(cb)           → off()   // pet:open-result（短暂气泡反馈）

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_PUSH = new Set(['pet:state', 'pet:status', 'pet:fullscreen', 'pet:open-result', 'pet:geom', 'pet:drag-cancel']);

function subscribe(channel, cb) {
  if (!ALLOWED_PUSH.has(channel) || typeof cb !== 'function') return () => {};
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pet', {
  getInfo: () => ipcRenderer.invoke('pet:get-info'),
  openSession: (payload) => ipcRenderer.invoke('pet:open-session', payload),
  setInteractive: (value) => ipcRenderer.invoke('pet:set-interactive', !!value),
  drag: (payload) => ipcRenderer.invoke('pet:drag', payload),
  setExpanded: (value) => ipcRenderer.invoke('pet:set-expanded', !!value),
  onState: (cb) => subscribe('pet:state', cb),
  onGeom: (cb) => subscribe('pet:geom', cb),
  onDragCancel: (cb) => subscribe('pet:drag-cancel', cb),
  onStatus: (cb) => subscribe('pet:status', cb),
  onFullscreen: (cb) => subscribe('pet:fullscreen', cb),
  onOpenResult: (cb) => subscribe('pet:open-result', cb),
});
