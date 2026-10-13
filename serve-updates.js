// 内网更新服务器（零依赖，仅在发布者电脑 192.168.3.92 上运行）
// 用法：node serve-updates.js            （默认端口 8088）
//      $env:UPD_PORT='9000'; node serve-updates.js
// 把 latest.yml 与 RemoteCommander-Setup-<ver>.exe 放进同目录的 updates/ 即可。
// 客户端更新源填：http://192.168.3.92:8088/
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.UPD_PORT || 8088;
const DIR = path.join(__dirname, 'updates');

const TYPES = {
    '.yml': 'text/yaml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.exe': 'application/octet-stream',
    '.json': 'application/json; charset=utf-8',
    '.sh': 'text/x-shellscript; charset=utf-8',
    '.blockmap': 'application/octet-stream'
};

http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/latest.yml';
    const fp = path.normalize(path.join(DIR, rel));
    if (!fp.startsWith(DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.statusCode = 404;
        res.end('not found: ' + rel);
        return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(fp).pipe(res);
}).listen(PORT, '0.0.0.0', () => {
    console.log('更新服务已启动: http://0.0.0.0:' + PORT + '/');
    console.log('更新目录: ' + DIR);
});
