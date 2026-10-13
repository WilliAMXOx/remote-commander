#!/usr/bin/env bash
# ============================================================
#  Remote Commander — Ubuntu 一键安装脚本 (AppImage)
#  用法：
#    bash <(wget -qO- https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com/DownloadToUbuntu.sh)
# ============================================================
set -e

COS_BASE="https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com"
APP_NAME="RemoteCommander"
INSTALL_DIR="$HOME/RemoteCommander"
ICON_DIR="$HOME/.local/share/icons"
APP_DIR="$HOME/.local/share/applications"

echo "== Remote Commander 一键安装 (AppImage) =="

# 0) 安装所有运行依赖
echo "[依赖] 检查并安装运行依赖 ..."
NEED=""
ldconfig -p | grep -q libfuse || NEED="$NEED libfuse2"
ldconfig -p | grep -q libnss3 || NEED="$NEED libnss3"
ldconfig -p | grep -q libgtk-3 || NEED="$NEED libgtk-3-0"
ldconfig -p | grep -q libasound || NEED="$NEED libasound2"
ldconfig -p | grep -q libXss || NEED="$NEED libxss1"
if [ -n "$NEED" ]; then
    echo "      需要安装:$NEED"
    sudo apt update -qq
    sudo apt install -y $NEED
fi

# 1) 从 latest.yml 获取最新版本号
echo "[1/4] 检查最新版本 ..."
VERSION=$(wget -qO- "$COS_BASE/latest.yml" | grep '^version:' | awk '{print $2}')
if [ -z "$VERSION" ]; then
    echo "错误：无法获取版本号"
    exit 1
fi
echo "      最新版本: v$VERSION"
APPIMAGE_FILE="${APP_NAME}-${VERSION}.AppImage"

# 2) 下载 AppImage
echo "[2/4] 下载 v$VERSION ..."
mkdir -p "$INSTALL_DIR"
wget -O "$INSTALL_DIR/$APPIMAGE_FILE" "$COS_BASE/$APPIMAGE_FILE"

if [ ! -f "$INSTALL_DIR/$APPIMAGE_FILE" ]; then
    echo "错误：下载失败"
    exit 1
fi

chmod +x "$INSTALL_DIR/$APPIMAGE_FILE"
find "$INSTALL_DIR" -name "${APP_NAME}-*.AppImage" ! -name "$APPIMAGE_FILE" -delete

# 3) 安装图标 + 桌面快捷方式
echo "[3/4] 安装图标和快捷方式 ..."
mkdir -p "$ICON_DIR" "$APP_DIR"
wget -O "$ICON_DIR/remote-commander.png" "$COS_BASE/icon.png"

cat > "$APP_DIR/remote-commander.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Remote Commander
Name[zh_CN]=远程终端控制台
Comment=SSH远程 / 本地Shell / 任务库
Exec=$INSTALL_DIR/$APPIMAGE_FILE
Icon=$ICON_DIR/remote-commander.png
Terminal=false
Categories=Development;Utility;
EOF
chmod +x "$APP_DIR/remote-commander.desktop"

echo "[4/4] 完成"
echo ""
echo "============================================================"
echo "  安装完成！v$VERSION"
echo "  应用位置: $INSTALL_DIR"
echo "  启动方式: 应用列表搜索 \"Remote Commander\""
echo "            或运行 $INSTALL_DIR/$APPIMAGE_FILE"
echo "============================================================"
