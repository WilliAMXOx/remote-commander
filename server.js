const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const os = require('os');
const path = require('path');
const fs = require('fs');

let pty;
try {
    pty = require('node-pty');
} catch (e) {
    pty = null;
}

// ===== 安全配置 =====
// Electron 主进程启动时通过 RC_TOKEN 注入一次性随机令牌；直接 node server.js 的开发模式无令牌。
// 默认只绑定回环地址，局域网其他主机不可见。
const AUTH_TOKEN = process.env.RC_TOKEN || '';
const BIND_HOST = process.env.RC_HOST || '127.0.0.1';

const app = express();
const server = http.createServer(app);
// 手动接管 upgrade，在 WebSocket 握手阶段就完成 Host / token 校验
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

function hostAllowed(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const hostname = host.split(':')[0].replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// 所有 HTTP 请求：Host 白名单（防 DNS rebinding）
app.use((req, res, next) => {
    if (!hostAllowed(req)) return res.status(403).end('Forbidden');
    next();
});

// token 校验仅保护 /api/*：页面与 /vendor 静态资源必须放行，
// 因为 <script>/<link> 标签无法携带 query token，否则 Electron 下页面脚本全部 401 白屏。
// 真正的命令通道（/ssh、/local-shell 的 WebSocket 握手）在 upgrade 事件中强制校验 token，
// 未持有 token 者只能看到随安装包分发的公开静态文件，无法建立任何终端会话；
// 且服务仅绑定回环地址，局域网设备本就不可达。
app.use((req, res, next) => {
    if (AUTH_TOKEN && req.path.startsWith('/api/')) {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            if (u.searchParams.get('token') !== AUTH_TOKEN) return res.status(401).end('Unauthorized');
        } catch (e) {
            return res.status(400).end('Bad Request');
        }
    }
    next();
});

app.use(express.static(path.join(__dirname)));

// 检测 Windows 系统代理设置
function getSystemProxy() {
    try {
        const { execSync } = require('child_process');
        const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf8', timeout: 3000 });
        if (/REG_DWORD\s+0x1/i.test(out)) {
            const out2 = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8', timeout: 3000 });
            const m = out2.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
            if (m) return m[1];
        }
    } catch (e) { /* 非 Windows 或读取失败，忽略 */ }
    return null;
}

// 通过 HTTP 代理发送 HTTPS 请求（CONNECT 隧道）
function httpsGetViaProxy(urlStr, proxyStr, options, callback) {
    const http = require('http');
    const tls = require('tls');
    const u = new URL(urlStr);
    const proxyUrl = new URL('http://' + proxyStr);
    const connectReq = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: 'CONNECT',
        path: u.hostname + ':' + (u.port || 443),
        timeout: 15000
    });
    connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return callback(new Error('代理 CONNECT 失败: HTTP ' + res.statusCode)); }
        const tlsSocket = tls.connect({ socket, servername: u.hostname, timeout: 60000 }, () => {
            const req = require('https').get({
                host: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                headers: options.headers,
                timeout: 60000,
                socket: tlsSocket,
                agent: false
            }, callback);
            req.on('error', e => callback(e));
            req.on('timeout', () => req.destroy());
        });
        tlsSocket.on('error', e => callback(e));
    });
    connectReq.on('error', e => callback(e));
    connectReq.on('timeout', () => connectReq.destroy());
    connectReq.end();
}

// 版本检查代理：渲染进程直接 fetch 跨源更新源（内网主机 / NAS）会被 CORS 拦截，
// 由仅绑定回环、带 token 校验的本机后端转发；自动检测系统代理，60s 超时。
app.get('/api/check-update', (req, res) => {
    const target = String(req.query.url || '');
    if (!/^https?:\/\/[^\s]+$/i.test(target)) {
        return res.status(400).json({ error: '更新源地址无效' });
    }
    const sysProxy = getSystemProxy();
    const doReq = (urlStr, redirects, useProxy) => {
        const u = new URL(urlStr);
        const headers = { 'User-Agent': 'RemoteCommander/1.11' };
        const handleResponse = (rRes) => {
            if (rRes.statusCode >= 300 && rRes.statusCode < 400 && rRes.headers.location && redirects < 5) {
                rRes.resume();
                return doReq(new URL(rRes.headers.location, urlStr).toString(), redirects + 1, useProxy);
            }
            let body = '';
            rRes.on('data', c => body += c);
            rRes.on('end', () => {
                if (rRes.statusCode !== 200) return res.status(502).json({ error: '更新源返回 HTTP ' + rRes.statusCode });
                try { res.json(JSON.parse(body)); }
                catch (e) { res.status(502).json({ error: '更新源内容不是有效的 JSON' }); }
            });
        };
        const handleError = (e) => {
            // 代理失败时回退直连；直连失败时如果有代理则尝试代理
            if (useProxy && sysProxy) {
                return doReq(urlStr, redirects, false);
            } else if (!useProxy && sysProxy) {
                return doReq(urlStr, redirects, true);
            }
            res.status(502).json({ error: '无法访问更新源：' + e.message });
        };
        if (u.protocol === 'https:' && useProxy && sysProxy) {
            httpsGetViaProxy(urlStr, sysProxy, { headers }, handleResponse);
        } else {
            const lib = u.protocol === 'https:' ? require('https') : require('http');
            const r = lib.get(urlStr, { timeout: 60000, headers }, handleResponse);
            r.on('error', handleError);
            r.on('timeout', () => { r.destroy(); handleError(new Error('访问超时（60s）')); });
        }
    };
    // 优先用系统代理（如果开着），失败自动回退直连
    doReq(target, 0, !!sysProxy);
});

app.get('/api/default-tasks', (req, res) => {
    const file = path.join(__dirname, 'ssh_tasks.json');
    fs.readFile(file, 'utf8', (err, data) => {
        if (err) {
            console.error('读取预置任务库失败:', err.message);
            return res.status(500).json({ error: '读取预置任务库失败' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(data);
    });
});

// 校验任务库数据结构，防止写入损坏文件
function validateTasks(data) {
    if (!Array.isArray(data)) return '数据必须是数组';
    for (const lib of data) {
        if (!lib || typeof lib !== 'object') return '每个库必须是对象';
        if (typeof lib.name !== 'string' || !lib.name.trim()) return '库名称无效';
        if (!Array.isArray(lib.tasks)) return 'tasks 必须是数组';
        for (const task of lib.tasks) {
            if (!task || typeof task !== 'object') return '每个任务必须是对象';
            if (typeof task.label !== 'string') return '任务 label 必须是字符串';
            if (typeof task.command !== 'string') return '任务 command 必须是字符串';
        }
    }
    return null;
}

app.post('/api/save-tasks', (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const err = validateTasks(data);
            if (err) return res.status(400).json({ error: '数据校验失败: ' + err });
            const file = path.join(__dirname, 'ssh_tasks.json');
            // 先备份再写入，防止写入中途崩溃损坏原文件
            const bak = file + '.bak';
            fs.copyFile(file, bak, (copyErr) => {
                fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8', (writeErr) => {
                    if (writeErr) {
                        console.error('保存任务库失败:', writeErr.message);
                        // 写入失败时恢复备份
                        fs.copyFile(bak, file, () => {});
                        return res.status(500).json({ error: '保存失败' });
                    }
                    res.json({ ok: true });
                });
            });
        } catch (e) {
            res.status(400).json({ error: 'JSON parse failed' });
        }
    });
});

function base64ToUtf8(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
}

server.on('upgrade', (req, socket, head) => {
    if (!hostAllowed(req)) {
        try { socket.destroy(); } catch (e) {}
        return;
    }
    let u;
    try {
        u = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        try { socket.destroy(); } catch (e2) {}
        return;
    }
    if (AUTH_TOKEN && u.searchParams.get('token') !== AUTH_TOKEN) {
        try {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
        } catch (e) {}
        return;
    }
    if (u.pathname !== '/local-shell' && u.pathname !== '/ssh') {
        try { socket.destroy(); } catch (e) {}
        return;
    }
    try { socket.setNoDelay(true); } catch (e) {}
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
    ws._msgBuffer = '';
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const urlPath = parsedUrl.pathname;

    // ===== WebSocket 层探活：15s 一次 ping，连续 3 次无 pong（约 45s）判定链路死亡 =====
    // 浏览器会自动应答协议级 ping；网络静默断开（拔线/休眠/NAT 超时）时 TCP 不一定立刻通知，
    // 靠主动探活把“看起来还连着、实际已死”的连接在 ~45s 内 terminate，前端随即收到 close 并重连。
    ws._missPong = 0;
    const pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws._missPong >= 3) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws._missPong += 1;
        try { ws.ping(); } catch (e) {}
    }, 15000);
    ws.on('pong', () => { ws._missPong = 0; });
    ws.on('close', () => clearInterval(pingTimer));

    // 本地 Shell 统一控制帧（\0 分包 JSON）：
    //   {type:'raw', payload:base64}  键盘/粘贴输入
    //   {type:'resize', cols, rows}   终端尺寸同步（真 PTY 生效）
    function handleLocalFrames(msg, onRaw, onResize) {
        ws._msgBuffer += Buffer.isBuffer(msg) ? msg.toString('utf8') : String(msg);
        let idx;
        while ((idx = ws._msgBuffer.indexOf('\0')) !== -1) {
            const frame = ws._msgBuffer.slice(0, idx);
            ws._msgBuffer = ws._msgBuffer.slice(idx + 1);
            if (!frame) continue;
            let parsed;
            try {
                parsed = JSON.parse(frame);
            } catch (e) {
                continue;
            }
            if (parsed.type === 'raw') {
                try { onRaw(base64ToUtf8(parsed.payload || '')); } catch (e) {}
            } else if (parsed.type === 'resize' && onResize) {
                try { onResize(Number(parsed.cols) || 80, Number(parsed.rows) || 30); } catch (e) {}
            }
        }
    }

    // 本地 Shell 逻辑
    if (urlPath === '/local-shell') {
        const isWin = os.platform() === 'win32';
        let localProcess;

        if (pty) {
          try {
            // ===== 真 PTY（node-pty）：完整终端能力（Tab 补全 / 全屏程序 / Ctrl+C）=====
            const shell = isWin ? 'cmd.exe' : (process.env.SHELL || 'bash');
            localProcess = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: 80,
                rows: 30,
                cwd: os.homedir(),
                env: process.env,
                useConpty: false
            });
            if (isWin) {
                try { localProcess.write('chcp 65001\r'); } catch (e) {}
            }
            localProcess.onData((data) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
            });
            const onPtyExit = () => { try { ws.close(); } catch (e) {} };
            if (typeof localProcess.onExit === 'function') localProcess.onExit(onPtyExit);
            else localProcess.on('exit', onPtyExit);

            ws.on('message', (msg) => handleLocalFrames(msg,
                (data) => localProcess.write(data),
                (cols, rows) => { try { localProcess.resize(cols, rows); } catch (e) {} }
            ));
            ws.on('close', () => { try { localProcess.kill(); } catch (e) {} });
            ws.send('\x1b[32m[本地 PTY 模式] 完整终端就绪（支持 Tab 补全 / 全屏程序 / Ctrl+C）\x1b[0m\r\n');
            return;
          } catch (ptyErr) {
            try { if (localProcess) localProcess.kill(); } catch (e2) {}
            console.error('[local-shell] PTY 启动失败，回退兼容模式:', ptyErr && ptyErr.message);
          }
        }

        // ===== 兼容模式（无 node-pty 时的伪终端兜底）=====
        const homeDir = os.homedir() || process.env.HOME || process.env.USERPROFILE || '';
        const cpMod = require('child_process');
        const spawn = cpMod.spawn;
        let iconv = null;
        try { iconv = require('iconv-lite'); } catch (e) { iconv = null; }
        // cmd 管道按系统控制台代码页解析字节；探测活动代码页（中文系统为 936/GBK）
        let winCp = 'cp936';
        if (isWin) {
            try {
                const chcpOut = cpMod.execSync('chcp', { encoding: 'utf8', timeout: 2000 });
                const m = String(chcpOut).match(/(\d{3,5})/);
                const cpMap = { '65001': 'utf8', '936': 'cp936', '950': 'big5', '932': 'cp932', '949': 'cp949', '437': 'cp437', '850': 'cp850', '852': 'cp852', '1252': 'win1252' };
                if (m && cpMap[m[1]]) winCp = cpMap[m[1]];
            } catch (e) {}
        }
        const decodeOut = (buf) => (isWin && iconv) ? iconv.decode(buf, winCp) : buf.toString('utf8');
        const encodeIn = (str) => (isWin && iconv) ? iconv.encode(str, winCp) : Buffer.from(str, 'utf8');
        if (isWin) {
            localProcess = spawn('cmd.exe', ['/Q', '/K'], { windowsHide: true, cwd: homeDir });
        } else {
            localProcess = spawn('bash', [], { env: Object.assign({}, process.env, { TERM: 'dumb' }), cwd: homeDir });
        }

        let lineBuf = '';
        let escSkip = 0;
        let promptTimer = null;

        function drawPrompt() {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!isWin) ws.send('\r\n' + (process.env.USER || 'user') + '@local:~$ ');
        }
        function schedulePrompt(delay) {
            clearTimeout(promptTimer);
            promptTimer = setTimeout(drawPrompt, delay);
        }
        function submitLine() {
            const line = lineBuf;
            lineBuf = '';
            ws.send('\r\n');
            try {
                if (line.trim()) {
                    if (isWin) localProcess.stdin.write(encodeIn(line + '\r\n'));
                    else { localProcess.stdin.write(encodeIn(line + '\n')); schedulePrompt(450); }
                } else if (isWin) {
                    localProcess.stdin.write(encodeIn('\r\n'));
                } else {
                    schedulePrompt(20);
                }
            } catch (e) {}
        }
        // 逐字符喂入伪终端（V1.8.9 行为）
        function feedChars(s2) {
            for (const ch of s2) {
                if (escSkip > 0) { escSkip--; continue; }
                if (ch === '\x1b') { escSkip = 4; continue; }
                if (ch === '\r' || ch === '\n') { submitLine(); continue; }
                if (ch === '\x7f' || ch === '\b') {
                    if (lineBuf.length) { lineBuf = lineBuf.slice(0, -1); ws.send('\b \b'); }
                    continue;
                }
                if (ch === '\x03') {
                    lineBuf = '';
                    ws.send('^C');
                    if (isWin) { try { localProcess.stdin.write(encodeIn('\r\n')); } catch (e) {} }
                    else schedulePrompt(30);
                    continue;
                }
                if (ch === '\x0c') { ws.send('\x1b[2J\x1b[H'); continue; }
                if (ch === '\x04') {
                    try { localProcess.stdin.end(); } catch (e) {}
                    continue;
                }
                if (ch === '\t') continue;
                if (ch.charCodeAt(0) >= 0x20) { lineBuf += ch; ws.send(ch); }
            }
        }

        localProcess.stdout.on('data', (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(decodeOut(data));
            if (!isWin) schedulePrompt(450);
        });
        localProcess.stderr.on('data', (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(decodeOut(data));
            if (!isWin) schedulePrompt(450);
        });
        localProcess.on('error', (err) => {
            if (ws.readyState === WebSocket.OPEN) ws.send('\r\n[shell 启动失败] ' + err.message + '\r\n');
        });

        ws.on('message', (msg) => handleLocalFrames(msg, (data) => feedChars(data), null));
        localProcess.on('exit', () => {
            try { ws.close(); } catch (e) {}
        });

        ws.send('\x1b[32m[本地 Shell 兼容模式] 输入命令后回车执行（支持退格/Ctrl+L，不支持全屏程序）\x1b[0m\r\n');
        if (!isWin) schedulePrompt(500);

        ws.on('close', () => {
            try { localProcess.kill(); } catch (e) {}
        });
        return;
    }

    // SSH 远程模式逻辑
    if (urlPath === '/ssh') {
        let sshClient = null;
        let sshStream = null;
        let sftp = null;
        let sftpOrin = null;
        let targetClient = null;
        let targetSftp = null;
        let jumpClient = null;

        ws.on('message', (message) => {
            let rawMsg = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
            ws._msgBuffer += rawMsg;

            let idx;
            while ((idx = ws._msgBuffer.indexOf('\0')) !== -1) {
                const oneCompleteMessage = ws._msgBuffer.slice(0, idx);
                ws._msgBuffer = ws._msgBuffer.slice(idx + 1);

                let parsed;
                try {
                    parsed = JSON.parse(oneCompleteMessage);
                } catch (e) {
                    console.error('JSON解析失败，丢弃消息:', oneCompleteMessage, e.message);
                    continue;
                }

                if (parsed.type === 'auth') {
                    if (sshClient) { try { sshClient.end(); } catch(e) {} }
                    if (jumpClient) { try { jumpClient.end(); } catch(e) {} }
                    let sshReady = false;
                    let closeNotified = false;
                    const notifyClosed = (reason) => {
                        if (closeNotified) return;
                        closeNotified = true;
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'closed', reason }) + '\0');
                        }
                    };

                    const openOnReady = () => {
                        try { sshClient.setNoDelay(true); } catch (e) {}
                        sshClient.shell({
                            term: 'xterm-256color',
                            cols: parsed.cols || 80,
                            rows: parsed.rows || 24,
                        }, (err, stream) => {
                            if (err) {
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'error', message: 'SSH 开启 Shell 失败: ' + err.message }) + '\0');
                                }
                                return;
                            }
                            sshStream = stream;
                            sshReady = true;

                            sshClient.sftp((sftpErr, sftpObj) => {
                                if (sftpErr) {
                                    console.error('SFTP 通道打开失败:', sftpErr.message);
                                } else {
                                    sftpOrin = sftpObj;
                                    sftp = sftpObj;
                                    sftpObj.realpath('.', (e, homePath) => {
                                        if (!e && ws.readyState === WebSocket.OPEN) {
                                            ws.send(JSON.stringify({ type: 'sftp-ready', home: homePath, target: 'orin' }) + '\0');
                                        }
                                    });
                                }
                            });

                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'ready' }) + '\0');
                            }

                            stream.on('data', (chunk) => {
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'term', data: chunk.toString('utf8') }) + '\0');
                                }
                            }).on('close', () => {
                                try { sshClient.end(); } catch (e) {}
                            });
                        });
                    };

                    const establishTarget = (sock) => {
                        sshClient = new Client();
                        const connOpts = {
                            host: parsed.host,
                            port: parsed.port || 22,
                            username: parsed.username,
                            password: parsed.password,
                            readyTimeout: 12000,
                            keepaliveInterval: 15000,
                            keepaliveCountMax: 3
                        };
                        if (sock) connOpts.sock = sock;
                        sshClient.on('ready', openOnReady)
                        .on('error', (err) => {
                            console.error('SSH 连接错误:', err.message);
                            if (ws.readyState === WebSocket.OPEN) {
                                if (sshReady) notifyClosed('SSH 连接异常中断: ' + err.message);
                                else ws.send(JSON.stringify({ type: 'error', message: 'SSH 连接失败: ' + err.message }) + '\0');
                            }
                        }).on('close', () => {
                            if (sshReady) notifyClosed('SSH 连接已关闭（网络中断或对端登出）');
                        }).on('end', () => {
                            if (sshReady) notifyClosed('SSH 连接被对端结束');
                        }).connect(connOpts);
                    };

                    establishTarget();
                }
                else if (parsed.type === 'execute' && sshStream) {
                    const commandToRun = parsed.command.endsWith('\n') ? parsed.command : parsed.command + '\n';
                    sshStream.write(commandToRun);
                }
                else if (parsed.type === 'raw' && sshStream) {
                    try {
                        const decoded = base64ToUtf8(parsed.payload);
                        sshStream.write(decoded);
                    } catch(err) {
                        console.error("raw payload decode error", err);
                    }
                }
                else if (parsed.type === 'resize' && sshStream) {
                    try {
                        sshStream.setWindow(parsed.rows, parsed.cols, 0, 0);
                    } catch(err) {}
                }
                // ===== SFTP 文件操作 =====
                else if (parsed.type === 'sftp-ls' && sftp) {
                    const dirPath = parsed.path || '.';
                    sftp.readdir(dirPath, (err, list) => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'sftp-error', action: 'ls', message: err.message }) + '\0');
                            return;
                        }
                        // 立即构造并返回，不被符号链接的 stat 阻塞（防止某个软链接卡死导致整个列表不显示）
                        const items = list.map(item => ({
                            name: item.filename,
                            isDir: item.longname.startsWith('d'),
                            isLink: item.longname.startsWith('l'),
                            size: item.attrs.size,
                            mode: item.attrs.mode,
                            mtime: item.attrs.mtime,
                            rights: item.longname.substring(1, 10)
                        })).sort((a, b) => {
                            const rank = i => i.isDir ? 0 : (i.isLink ? 1 : 2);
                            if (rank(a) !== rank(b)) return rank(a) - rank(b);
                            return a.name.localeCompare(b.name);
                        });
                        ws.send(JSON.stringify({ type: 'sftp-ls', path: dirPath, items }) + '\0');
                    });
                }
                // 单独查询某个路径（用于双击软链接时判断目标是目录还是文件）
                else if (parsed.type === 'sftp-stat' && sftp) {
                    sftp.stat(parsed.path, (statErr, statAttrs) => {
                        if (statErr) {
                            ws.send(JSON.stringify({ type: 'sftp-stat-result', path: parsed.path, error: statErr.message }) + '\0');
                            return;
                        }
                        ws.send(JSON.stringify({
                            type: 'sftp-stat-result',
                            path: parsed.path,
                            isDir: (statAttrs.mode & 0xF000) === 0x4000,
                            size: statAttrs.size
                        }) + '\0');
                    });
                }
                // 双击软链接：直接尝试 readdir 浏览（OPENDIR 会跟随链接），
                // 能浏览 → 目录，返回列表；不能浏览 → 当作文件，通知前端下载。
                // 用实际可浏览性判断，比 stat 更可靠（某些软链接 stat 会失败但实际可进入）。
                // 经当前主连接(ORIN)附加到内网目标(RK)的 SFTP；自动检测终端 ssh 跳转时触发
                else if (parsed.type === 'sftp-attach') {
                    if (!sshClient || !sftpOrin) {
                        ws.send(JSON.stringify({ type: 'sftp-attach-error', message: '主连接未就绪，无法附加目标' }) + '\0');
                    } else {
                        if (targetClient) { try { targetClient.end(); } catch (e) {} targetClient = null; targetSftp = null; }
                        const tHost = parsed.host, tPort = parsed.port || 22;
                        sshClient.forwardOut('127.0.0.1', 50000 + Math.floor(Math.random()*10000), tHost, tPort, (ferr, fstream) => {
                            if (ferr) {
                                ws.send(JSON.stringify({ type: 'sftp-attach-error', message: '无法经主连接到达 ' + tHost + ': ' + ferr.message }) + '\0');
                                return;
                            }
                            targetClient = new Client();
                            targetClient.on('ready', () => {
                                try { targetClient.setNoDelay(true); } catch (e) {}
                                targetClient.sftp((se, ts) => {
                                    if (se) { ws.send(JSON.stringify({ type: 'sftp-attach-error', message: '目标 SFTP 打开失败: ' + se.message }) + '\0'); return; }
                                    targetSftp = ts;
                                    sftp = ts;
                                    ts.realpath('.', (e, home) => {
                                        ws.send(JSON.stringify({ type: 'sftp-ready', home: home, target: 'rk', host: tHost, username: parsed.username }) + '\0');
                                    });
                                });
                            }).on('error', e => {
                                ws.send(JSON.stringify({ type: 'sftp-attach-error', message: '目标连接失败: ' + e.message }) + '\0');
                            }).on('close', () => {
                                targetSftp = null; targetClient = null;
                                if (sftpOrin) {
                                    sftp = sftpOrin;
                                    sftpOrin.realpath('.', (e, home) => {
                                        ws.send(JSON.stringify({ type: 'sftp-ready', home: home, target: 'orin', auto: true }) + '\0');
                                    });
                                }
                            }).connect({
                                sock: fstream,
                                host: tHost, port: tPort,
                                username: parsed.username,
                                password: parsed.password,
                                readyTimeout: 12000,
                                keepaliveInterval: 15000,
                                keepaliveCountMax: 3
                            });
                        });
                    }
                }
                else if (parsed.type === 'sftp-detach') {
                    if (targetClient) { try { targetClient.end(); } catch (e) {} }
                    targetSftp = null; targetClient = null;
                    sftp = sftpOrin;
                    if (sftpOrin) sftpOrin.realpath('.', (e, home) => {
                        ws.send(JSON.stringify({ type: 'sftp-ready', home: home, target: 'orin' }) + '\0');
                    });
                }
                else if (parsed.type === 'sftp-open-link' && sftp) {
                    const linkPath = parsed.path;
                    sftp.readdir(linkPath, (rdErr, rdList) => {
                        if (!rdErr) {
                            const items = rdList.map(item => ({
                                name: item.filename,
                                isDir: item.longname.startsWith('d'),
                                isLink: item.longname.startsWith('l'),
                                size: item.attrs.size,
                                mode: item.attrs.mode,
                                mtime: item.attrs.mtime,
                                rights: item.longname.substring(1, 10)
                            })).sort((a, b) => {
                                const rank = i => i.isDir ? 0 : (i.isLink ? 1 : 2);
                                if (rank(a) !== rank(b)) return rank(a) - rank(b);
                                return a.name.localeCompare(b.name);
                            });
                            ws.send(JSON.stringify({ type: 'sftp-ls', path: linkPath, items }) + '\0');
                        } else {
                            // 无法作为目录浏览 → 当作文件下载
                            ws.send(JSON.stringify({
                                type: 'sftp-link-download',
                                path: linkPath,
                                name: linkPath.split('/').pop()
                            }) + '\0');
                        }
                    });
                }
                else if (parsed.type === 'sftp-tar' && sftp) {
                    const cwd = parsed.cwd || '.';
                    const names = Array.isArray(parsed.names) ? parsed.names.filter(n => n && typeof n === 'string') : [];
                    const execClient = targetClient || sshClient;
                    if (names.length === 0) {
                        ws.send(JSON.stringify({ type: 'sftp-error', action: 'tar', message: '未选择任何文件' }) + '\0');
                    } else if (!execClient) {
                        ws.send(JSON.stringify({ type: 'sftp-error', action: 'tar', message: '当前连接不可执行远程命令' }) + '\0');
                    } else {
                        const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
                        const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
                        const remoteOut = '/tmp/rc-bundle-' + stamp + '.tar.gz';
                        const dlName = (names.length === 1 ? names[0] : 'rc-bundle-' + stamp) + '.tar.gz';
                        const tarCmd = 'tar -czf ' + shq(remoteOut) + ' -C ' + shq(cwd) + ' -- ' + names.map(shq).join(' ');
                        const cleanup = () => { try { execClient.exec('rm -f ' + shq(remoteOut), () => {}); } catch (e) {} };
                        ws._sftpReadStream = null;
                        execClient.exec(tarCmd, (eErr, estream) => {
                            if (eErr) { ws.send(JSON.stringify({ type: 'sftp-error', action: 'tar', message: eErr.message }) + '\0'); return; }
                            let eout = '';
                            estream.on('data', d => { eout += d.toString(); });
                            estream.stderr.on('data', d => { eout += d.toString(); });
                            estream.on('close', code => {
                                if (code !== 0) {
                                    ws.send(JSON.stringify({ type: 'sftp-error', action: 'tar', message: '远程打包失败: ' + eout.trim() }) + '\0');
                                    return;
                                }
                                sftp.stat(remoteOut, (sErr, stats) => {
                                    if (sErr) { ws.send(JSON.stringify({ type: 'sftp-error', action: 'tar', message: sErr.message }) + '\0'); cleanup(); return; }
                                    const total = stats ? stats.size : 0;
                                    const stream = sftp.createReadStream(remoteOut);
                                    ws._sftpReadStream = stream;
                                    const chunks = []; let transferred = 0, lastPush = 0;
                                    ws.send(JSON.stringify({ type: 'sftp-progress', dir: 'down', path: remoteOut, name: dlName, transferred: 0, total }) + '\0');
                                    stream.on('data', c => {
                                        chunks.push(c); transferred += c.length;
                                        if (transferred - lastPush >= 262144 || transferred === total) {
                                            lastPush = transferred;
                                            ws.send(JSON.stringify({ type: 'sftp-progress', dir: 'down', path: remoteOut, transferred, total }) + '\0');
                                        }
                                    });
                                    stream.on('end', () => {
                                        ws._sftpReadStream = null;
                                        const buf = Buffer.concat(chunks);
                                        ws.send(JSON.stringify({ type: 'sftp-read', path: remoteOut, name: dlName, data: buf.toString('base64'), size: buf.length }) + '\0');
                                        cleanup();
                                    });
                                    stream.on('error', err => {
                                        ws._sftpReadStream = null;
                                        ws.send(JSON.stringify({ type: 'sftp-error', action: 'tar', message: err.message }) + '\0');
                                        cleanup();
                                    });
                                });
                            });
                        });
                    }
                }
                else if (parsed.type === 'sftp-read' && sftp) {
                    const filePath = parsed.path;
                    const chunks = [];
                    let transferred = 0, total = 0, lastPush = 0;
                    let aborted = false;
                    ws._sftpReadStream = null;
                    sftp.stat(filePath, (stErr, stats) => {
                        if (stErr) {
                            ws.send(JSON.stringify({ type: 'sftp-error', action: 'read', message: stErr.message }) + '\0');
                            return;
                        }
                        total = stats ? stats.size : 0;
                        const stream = sftp.createReadStream(filePath);
                        ws._sftpReadStream = stream;
                        ws.send(JSON.stringify({ type: 'sftp-progress', dir: 'down', path: filePath, name: filePath.split('/').pop(), transferred: 0, total }) + '\0');
                        stream.on('data', chunk => {
                            chunks.push(chunk);
                            transferred += chunk.length;
                            if (transferred - lastPush >= 262144 || transferred === total) {
                                lastPush = transferred;
                                ws.send(JSON.stringify({ type: 'sftp-progress', dir: 'down', path: filePath, transferred, total }) + '\0');
                            }
                        });
                        stream.on('end', () => {
                            ws._sftpReadStream = null;
                            const buf = Buffer.concat(chunks);
                            ws.send(JSON.stringify({
                                type: 'sftp-read',
                                path: filePath,
                                name: filePath.split('/').pop(),
                                data: buf.toString('base64'),
                                size: buf.length
                            }) + '\0');
                        });
                        stream.on('error', err => {
                            ws._sftpReadStream = null;
                            if (!aborted) ws.send(JSON.stringify({ type: 'sftp-error', action: 'read', message: err.message }) + '\0');
                        });
                    });
                }
                else if (parsed.type === 'sftp-abort' && sftp) {
                    if (ws._sftpReadStream) { try { ws._sftpReadStream.destroy(); } catch (e) {} ws._sftpReadStream = null; }
                    const ap = parsed.path || '';
                    const ec = targetClient || sshClient;
                    if (ec && ap.indexOf('/tmp/rc-bundle-') === 0) {
                        const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
                        try { ec.exec('rm -f ' + shq(ap), () => {}); } catch (e) {}
                    }
                    ws.send(JSON.stringify({ type: 'sftp-aborted', path: ap }) + '\0');
                }
                else if (parsed.type === 'sftp-write' && sftp) {
                    // 兼容旧的一次性整块上传
                    const filePath = parsed.path;
                    const buf = Buffer.from(parsed.data, 'base64');
                    const writeStream = sftp.createWriteStream(filePath);
                    writeStream.on('close', () => {
                        ws.send(JSON.stringify({ type: 'sftp-write-done', path: filePath }) + '\0');
                    });
                    writeStream.on('error', err => {
                        ws.send(JSON.stringify({ type: 'sftp-error', action: 'write', message: err.message }) + '\0');
                    });
                    writeStream.end(buf);
                }
                else if (parsed.type === 'sftp-write-start' && sftp) {
                    const filePath = parsed.path;
                    try { if (ws._sftpWriteStream) ws._sftpWriteStream.end(); } catch (e) {}
                    const ws2 = sftp.createWriteStream(filePath);
                    ws2.on('close', () => {
                        ws._sftpWriteStream = null;
                        ws.send(JSON.stringify({ type: 'sftp-write-done', path: filePath }) + '\0');
                    });
                    ws2.on('error', err => {
                        ws._sftpWriteStream = null;
                        ws.send(JSON.stringify({ type: 'sftp-error', action: 'write', message: err.message }) + '\0');
                    });
                    ws._sftpWriteStream = ws2;
                    ws.send(JSON.stringify({ type: 'sftp-write-started', path: filePath }) + '\0');
                }
                else if (parsed.type === 'sftp-write-chunk' && sftp) {
                    if (ws._sftpWriteStream) {
                        ws._sftpWriteStream.write(Buffer.from(parsed.data, 'base64'));
                        ws.send(JSON.stringify({ type: 'sftp-write-ack', path: parsed.path || '' }) + '\0');
                    }
                }
                else if (parsed.type === 'sftp-write-end' && sftp) {
                    if (ws._sftpWriteStream) { ws._sftpWriteStream.end(); }
                }
                else if (parsed.type === 'sftp-mkdir' && sftp) {
                    sftp.mkdir(parsed.path, err => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'sftp-error', action: 'mkdir', message: err.message }) + '\0');
                        } else {
                            ws.send(JSON.stringify({ type: 'sftp-mkdir-done', path: parsed.path }) + '\0');
                        }
                    });
                }
                else if (parsed.type === 'sftp-delete' && sftp) {
                    const target = parsed.path;
                    const cb = err => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'sftp-error', action: 'delete', message: err.message }) + '\0');
                        } else {
                            ws.send(JSON.stringify({ type: 'sftp-delete-done', path: target }) + '\0');
                        }
                    };
                    if (parsed.isDir) {
                        // 递归删除目录
                        const rmdir = (p, cb2) => {
                            sftp.readdir(p, (err, list) => {
                                if (err) return cb2(err);
                                let pending = list.length;
                                if (pending === 0) return sftp.rmdir(p, cb2);
                                list.forEach(item => {
                                    const full = p.replace(/\/$/, '') + '/' + item.filename;
                                    if (item.longname.startsWith('d')) {
                                        rmdir(full, () => { if (--pending === 0) sftp.rmdir(p, cb2); });
                                    } else {
                                        sftp.unlink(full, () => { if (--pending === 0) sftp.rmdir(p, cb2); });
                                    }
                                });
                            });
                        };
                        rmdir(target, cb);
                    } else {
                        sftp.unlink(target, cb);
                    }
                }
                else if (parsed.type === 'sftp-rename' && sftp) {
                    sftp.rename(parsed.oldPath, parsed.newPath, err => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'sftp-error', action: 'rename', message: err.message }) + '\0');
                        } else {
                            ws.send(JSON.stringify({ type: 'sftp-rename-done' }) + '\0');
                        }
                    });
                }
            }
        });

        ws.on('close', () => {
            ws._msgBuffer = '';
            if (targetClient) { try { targetClient.end(); } catch (e) {} }
            if (sftpOrin) { try { sftpOrin.end(); } catch (e) {} }
            if (sshStream) { try { sshStream.close(); } catch (e) {} }
            if (sshClient) { try { sshClient.end(); } catch (e) {} }
            targetSftp = null; targetClient = null;
            sftp = null; sftpOrin = null;
            sshStream = null;
            sshClient = null;
        });
        return;
    }
});

// ===== 启动逻辑：端口被占自动顺延，返回实际端口；供 Electron 主进程等待 =====
function startServer(preferredPort) {
    return new Promise((resolve, reject) => {
        let port = Number(preferredPort) || 3000;
        const maxPort = port + 20;
        const attempt = () => {
            const onError = (err) => {
                server.removeListener('listening', onListening);
                // EADDRINUSE=端口被占；EACCES=端口落在系统保留区间（Windows Hyper-V/WSL 常预留），
                // 两种情况都自动顺延到下一个端口
                if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES') && port < maxPort) {
                    port += 1;
                    attempt();
                } else {
                    reject(err);
                }
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve(port);
            };
            server.once('error', onError);
            server.once('listening', onListening);
            try {
                server.listen(port, BIND_HOST);
            } catch (e) {
                onError(e);
            }
        };
        attempt();
    });
}

function openBrowser(url) {
    const { exec } = require('child_process');
    const opener = process.platform === 'win32' ? `start "" "${url}"`
                : process.platform === 'darwin' ? `open "${url}"`
                : `xdg-open "${url}"`;
    try { exec(opener); } catch (e) {}
}

module.exports = { startServer, isPtyAvailable: !!pty };

// 直接运行（node server.js）时自动启动；被 Electron require 时不自动监听
if (require.main === module) {
    startServer(process.env.PORT || 3000).then((port) => {
        const url = `http://localhost:${port}`;
        console.log(`=================================================`);
        console.log(`  🚀 Remote Commander 服务端已启动成功！`);
        console.log(`  🔗 本地访问地址: ${url}`);
        console.log(`  🔒 监听: ${BIND_HOST}（仅本机可访问）${AUTH_TOKEN ? '，token 鉴权已启用' : '，开发模式（无 token）'}`);
        console.log(`=================================================`);
        if (process.env.OPEN_BROWSER !== '0') openBrowser(url);
    }).catch((err) => {
        console.error('服务启动失败:', err.message);
        process.exit(1);
    });
}
