#!/usr/bin/env bash
# Remote Commander 一键安装/更新（deb 版）
# 用法： bash <(wget -qO- https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com/DownloadToUbuntu.sh)
set -e

BASE="https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com"
PKG_NAME="remote-commander"

echo "== Remote Commander 一键安装 (deb) =="

echo "[1/4] 检查最新版本 ..."
VERSION=$(curl -fsSL "$BASE/latest-deb-version" 2>/dev/null || true)
if [ -z "$VERSION" ]; then
  echo "无法获取版本号，请检查网络或更新源。"
  exit 1
fi
echo "最新版本: v$VERSION"

DEB="RemoteCommander-$VERSION.deb"
echo "[2/4] 下载 v$VERSION ..."
curl -fL "$BASE/$DEB" -o "/tmp/$DEB"

echo "[3/4] 清理旧版本 ..."
if dpkg -l | grep -q "^ii  $PKG_NAME"; then
  sudo apt-get remove -y "$PKG_NAME" || true
fi

echo "[4/4] 安装 v$VERSION ..."
sudo apt-get install -y "/tmp/$DEB"
rm -f "/tmp/$DEB"

echo ""
echo "完成！可在应用菜单中点击 “Remote Commander” 图标启动。"
