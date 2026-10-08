// Electron 主进程：在桌面窗口里跑 Remote Commander
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 告诉 server.js 不要去开系统浏览器（我们用桌面窗口加载）
process.env.OPEN_BROWSER = '0';
// 一次性随机令牌：只有本进程创建的窗口 URL 携带，
// 防止本机其他网页 / 进程偷偷连接本地终端服务
process.env.RC_TOKEN = crypto.randomBytes(24).toString('hex');

const { startServer } = require('./server.js');

let mainWindow = null;
let servicePort = null;

// ============ 自动更新（electron-updater，更新源可配置：公网 OSS / 内网） ============
const { autoUpdater } = require('electron-updater');
const { CancellationToken } = require('builder-util-runtime');
const updater = autoUpdater;
updater.autoDownload = false;          // 由用户在界面确认后再下载
updater.autoInstallOnAppQuit = true;

const configPath = () => path.join(app.getPath('userData'), 'update-config.json');
function readUpdateConfig() {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}; }
    catch (e) { return {}; }
}
function writeUpdateConfig(cfg) {
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8'); }
    catch (e) {}
}

// 把更新状态推给渲染进程
function pushState(state) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('upd:state', state);
    }
}

function applyFeedUrl() {
    const source = (readUpdateConfig().source || '').trim();
    if (source) {
        // generic provider：source 指向存放 latest.yml 与安装包的目录
        updater.setFeedURL({ provider: 'generic', url: source });
    }
    return source;
}

let latestVer = '';
let upCT = null;
updater.on('checking-for-update', () => pushState({ phase: 'checking' }));
updater.on('update-available', (info) => { latestVer = info.version; pushState({ phase: 'available', version: info.version, notes: info.releaseNotes || '' }); });
updater.on('update-not-available', () => pushState({ phase: 'not-available', version: app.getVersion() }));
updater.on('download-progress', (p) => pushState({
    phase: 'progress',
    version: latestVer,
    percent: Math.round(p.percent || 0),
    speed: Math.round((p.bytesPerSecond || 0) / 1024),
    transferred: Math.round((p.transferred || 0) / 1048576),
    total: Math.round((p.total || 0) / 1048576)
}));
updater.on('update-downloaded', (info) => pushState({ phase: 'downloaded', version: info.version }));
updater.on('error', (err) => {
    const msg = (err && err.message) ? err.message : String(err);
    if (/cancel|abort/i.test(msg)) { pushState({ phase: 'cancelled', version: latestVer }); return; }
    pushState({ phase: 'error', message: msg });
});

// IPC：渲染进程调用
ipcMain.handle('upd:get-config', () => readUpdateConfig());
ipcMain.handle('upd:set-source', (_e, url) => {
    const cfg = readUpdateConfig();
    cfg.source = (url || '').trim();
    writeUpdateConfig(cfg);
    applyFeedUrl();
    return cfg;
});
ipcMain.handle('upd:check', async () => {
    const source = applyFeedUrl();
    if (!source) return { skipped: true };
    try { await updater.checkForUpdates(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('upd:download', async () => {
    // 优先用系统浏览器直接打开下载链接（electron-updater 后台下载在部分网络下会静默挂起）
    try {
        const uip = updater.updateInfoAndProvider;
        let exeUrl = '';
        if (uip && uip.info && uip.info.files && uip.info.files[0]) {
            const file = uip.info.files[0];
            const base = (readUpdateConfig().source || '').replace(/\/$/, '');
            exeUrl = base + '/' + (file.url || file.path);
        }
        if (exeUrl) {
            shell.openExternal(exeUrl);
            pushState({ phase: 'downloaded', version: latestVer, external: true });
            return { ok: true, openedExternal: true };
        }
    } catch (e) { /* fall through to electron-updater */ }
    // 兜底：electron-updater 后台下载
    try {
        upCT = new CancellationToken();
        await updater.downloadUpdate(upCT);
        return { ok: true };
    }
    catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        if (!/cancel|abort/i.test(msg)) pushState({ phase: 'error', message: '下载失败: ' + msg });
        return { ok: false, error: msg };
    }
});
ipcMain.handle('upd:install', () => {
    // 退出当前应用并运行安装包（isSilent=false 显示安装向导，isForceRunAfter 安装后重启应用）
    updater.quitAndInstall(false, true);
    return { ok: true };
});
ipcMain.handle('upd:cancel', () => {
    try { if (upCT) upCT.cancel(); } catch (e) {}
    pushState({ phase: 'cancelled', version: latestVer });
    return { ok: true };
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1780,
        height: 1000,
        minWidth: 1200,
        minHeight: 700,
        backgroundColor: '#070707',
        autoHideMenuBar: true,
        title: 'Remote Commander',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL(`http://127.0.0.1:${servicePort}/?token=${process.env.RC_TOKEN}&appv=${app.getVersion()}`);

    // 外部链接交给系统浏览器，应用内只保留本机控制台
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(url)) {
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 单实例锁：重复启动时只聚焦已有窗口，避免多实例抢端口 / 连到旧服务
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        try {
            // 端口被占时 server 会自动顺延，等待它返回实际端口再加载页面
            servicePort = await startServer(process.env.PORT || 3000);
            createWindow();

            // 启动 3 秒后自动静默检查更新（仅在配置了更新源时）
            setTimeout(() => {
                if (applyFeedUrl()) {
                    updater.checkForUpdates().catch(() => {});
                }
            }, 3000);
        } catch (e) {
            dialog.showErrorBox(
                'Remote Commander 启动失败',
                '本地终端服务无法启动：\n\n' + ((e && e.message) ? e.message : String(e)) +
                '\n\n请关闭占用端口的程序（或旧版本实例）后重试。'
            );
            app.quit();
        }

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0 && servicePort) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
