# Remote Commander — 发版流程（RELEASE）

本文档说明从「确认版本号」到「Linux deb 上架腾讯云 COS」的完整发版流程。

## 一、发版架构（为什么这样分）

- **deb 只能在 Linux 上打包**（Windows 本机装不了 fpm），所以打包必须由 CI（GitHub Actions，海外 runner）完成。
- CI 海外 runner **只负责打 deb + 传 GitHub Release**（这一步快，3–5 分钟）。
- **腾讯云 COS（公网更新源）由你本地上传**：用 `sync_cos.ps1` 从 GitHub Release 拉 deb → 本地直连上传 COS。中国网络下几十秒完成，**不需要代理**，也不再有跨洋 30 分钟的空等。

## 二、前置条件（发版机 = 你的 Windows 笔记本）

1. **gh CLI 已登录**：`gh auth status`
2. **coscmd 已安装**：
   ```powershell
   python -m pip install coscmd -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```
3. **腾讯云密钥**：见「三、密钥配置」。
4. **访问 GitHub**：推 workflow / 拉 Release 时，`github.com` 被墙需开代理；`api.github.com`（gh 命令）可直连。

## 三、密钥配置（勿提交到 GitHub）

项目根建一个 `cos_secret.txt`，脚本 `sync_cos.ps1` 会自动读取（也支持环境变量 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`）：

```
id=你的腾讯云SecretId
key=你的腾讯云SecretKey
```

> ⚠️ `cos_secret.txt` 含私密密钥：**绝不 push 到 GitHub**。如要提交项目，先把它加入 `.gitignore`。

## 四、发版步骤

### 第 1 步：确认版本号
例如本次要发 `1.14.6`。当前最新版号见 COS：`https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com/latest-deb-version`

### 第 2 步：触发 CI 打 deb（GitHub Actions）
```powershell
gh workflow run build-deb.yml --repo WilliAMXOx/remote-commander --ref main -f version=1.14.6
```
监控直到完成：
```powershell
gh run list --repo WilliAMXOx/remote-commander -w build-deb.yml --limit 1
```
CI 会自动：改 package.json 版本号 → 打包 `.deb` → 上传到 GitHub Release `v<版本号>`（同时上传 `DownloadToUbuntu.sh` 和 `latest-deb-version` 作为记录）。

### 第 3 步：本地同步到腾讯云 COS
```powershell
powershell -ExecutionPolicy Bypass -File sync_cos.ps1 -Version 1.14.6
```
脚本依次：
1. 从 GitHub Release 下载 `RemoteCommander-1.14.6.deb`（本地直连）
2. 上传 deb 到 COS
3. 更新 `latest-deb-version`（写为 `1.14.6`）
4. 上传 `DownloadToUbuntu.sh`（一键安装脚本，CI 每次会更新它）

## 五、验证

发版后用下面任一方式确认 COS 端已是最新版：

```powershell
# 版本号
curl.exe -s https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com/latest-deb-version
# deb 可访问（返回 206 表示存在）
curl.exe -s -o NUL -w "%{http_code}" -r 0-100 https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com/RemoteCommander-1.14.6.deb
```

在 Ubuntu 上做最终安装验证：
```bash
bash <(wget -qO- https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com/DownloadToUbuntu.sh)
```
它会读 COS 的 `latest-deb-version` → 下载对应 deb → 清理旧版 → `apt` 安装。

## 六、公网 / 内网更新源对照

| 源 | 地址 | 用途 |
|---|---|---|
| 腾讯云 COS（公网） | `https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com` | Linux 一键安装、Windows 在线更新检查 |
| 内网（本机） | `http://192.168.3.92:8088` | 局域网内 Windows 更新源 |

---

*更新记录：2026-10 切换为「CI 打 deb + 本地同步 COS」发版模式，消除跨洋上传慢的问题。*
