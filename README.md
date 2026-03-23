# Sync Watch - 异地同步观影工具

与朋友在 YouTube / Bilibili 等视频平台上同步观看视频。

## 快速开始

### 1. 启动同步服务器

```bash
cd server
pip install -r requirements.txt
python3 server.py
```

服务器默认运行在 `ws://localhost:8080`。

### 2. 安装浏览器扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/` 目录

### 3. 使用

1. 房主：打开视频页面 → 点击扩展图标 → 「创建房间」→ 将 6 位房间号分享给朋友
2. 朋友：打开同一视频页面 → 点击扩展图标 → 输入房间号 → 「加入房间」
3. 房主播放/暂停/拖动进度条时，所有人自动同步

## 支持的平台

- YouTube (`youtube.com`)
- Bilibili (`bilibili.com`)
- 理论上支持所有使用 HTML5 `<video>` 元素的网站（需在 manifest.json 中添加对应域名）

## 架构

```
浏览器扩展 (Content Script + Background SW + Popup)
        ↕ WebSocket
   Python 同步服务器 (房间管理 + 事件中转)
```

## 远程部署

如需多人远程使用，将 `server.py` 部署到公网服务器，修改扩展中的服务器地址即可。
