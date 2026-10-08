// preload：在 contextIsolation 下安全暴露自动更新能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
    // 读取更新配置（更新源地址等）
    getConfig: () => ipcRenderer.invoke('upd:get-config'),
    // 保存更新源地址（generic provider 的 URL，指向放 latest.yml 的目录）
    setSource: (url) => ipcRenderer.invoke('upd:set-source', url),
    // 手动检查更新
    check: () => ipcRenderer.invoke('upd:check'),
    // 开始下载
    download: () => ipcRenderer.invoke('upd:download'),
    // 下载完成后退出并安装
    install: () => ipcRenderer.invoke('upd:install'),
    // 取消正在进行的下载
    cancel: () => ipcRenderer.invoke('upd:cancel'),
    // 订阅主进程推送的更新状态（checking / available / not-available / progress / downloaded / error）
    onState: (cb) => {
        const handler = (_e, state) => cb(state);
        ipcRenderer.on('upd:state', handler);
        return () => ipcRenderer.removeListener('upd:state', handler);
    }
});
