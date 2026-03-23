# Sync Watch 开发文档

> 异地同步观影工具 —— Chrome 扩展 + WebSocket 服务器
>
> 仓库地址：`github.com/liubashe/sync-watch`
> 部署地址：`wss://sync-watch-022p.onrender.com`

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构设计](#2-架构设计)
3. [目录结构](#3-目录结构)
4. [服务端详解](#4-服务端详解)
5. [扩展端详解](#5-扩展端详解)
6. [通信协议](#6-通信协议)
7. [部署指南](#7-部署指南)
8. [本地开发](#8-本地开发)
9. [踩坑记录与解决方案](#9-踩坑记录与解决方案)
10. [后续开发方向](#10-后续开发方向)

---

## 1. 项目概述

### 功能

- 两人（或多人）在各自浏览器中打开同一视频（YouTube / Bilibili），通过创建/加入房间实现**播放、暂停、进度跳转**的实时同步。
- 房主（Host）的操作会广播给所有观众（Guest），观众操作也会反向同步。
- 房主每 3 秒发送心跳校准进度，防止长时间播放后出现偏移。

### 不包含

- 聊天、语音、弹幕、表情反应等社交功能。
- 视频源代理或转发（各端独立加载视频）。

---

## 2. 架构设计

```
┌──────────────────────────────────────────────────────┐
│                    Chrome 扩展                        │
│                                                      │
│  ┌─────────────┐  message  ┌──────────────────────┐  │
│  │  popup.html  │ ←------→ │  background.js (SW)  │  │
│  │  popup.js    │          │  状态持久化/消息中转    │  │
│  └─────────────┘          └─────────┬────────────┘  │
│                              ↕ message              │
│                    ┌────────────────────┐            │
│                    │    content.js       │            │
│                    │  视频检测/事件监听   │            │
│                    └────────────────────┘            │
└─────────────────────────┬────────────────────────────┘
                          │ WebSocket (wss://)
                          ↓
              ┌───────────────────────┐
              │     server.py          │
              │  aiohttp + WebSocket   │
              │  房间管理 / 事件广播    │
              └───────────────────────┘
```

### 数据流

1. **本地事件**：用户操作视频 → content.js 捕获 play/pause/seeked → 发送给 background.js → 通过 WebSocket 发送到 server.py
2. **远程同步**：server.py 广播给同房间其他客户端 → background.js 接收 → 转发给 content.js → 控制视频元素
3. **心跳校准**：房主 content.js 每 3 秒发送当前时间 → server 广播 → 观众端检查偏移并修正（阈值 0.5 秒）

---

## 3. 目录结构

```
sync-watch/
├── server/
│   ├── server.py            # WebSocket + HTTP 服务端
│   └── requirements.txt     # Python 依赖 (aiohttp>=3.9.0)
├── extension/
│   ├── manifest.json        # Chrome 扩展清单 (Manifest V3)
│   ├── background.js        # Service Worker：WS 连接、状态管理、消息中转
│   ├── content.js           # 注入视频页面：检测 <video>、监听/控制播放
│   ├── popup.html           # 弹出窗口 UI（HTML + CSS）
│   ├── popup.js             # 弹出窗口逻辑
│   └── icons/               # 扩展图标 (16/48/128px)
├── requirements.txt         # 根目录依赖副本（Render 部署需要）
├── .gitignore
├── README.md                # 用户文档
└── DEVELOPMENT.md           # 本文档
```

---

## 4. 服务端详解

**文件**：`server/server.py`
**框架**：Python 3 + aiohttp
**端口**：环境变量 `PORT`，默认 `8080`

### 核心数据结构

```python
rooms = {}  # roomId -> { "host": ws, "clients": set(ws) }
```

- `host`：房间创建者的 WebSocket 连接对象
- `clients`：房间内所有连接（包含 host）

### 关键逻辑

| 功能 | 说明 |
|------|------|
| **房间创建** | 生成 6 位随机房间号（大写字母+数字，排除易混淆字符 I/O/0/1），创建者自动成为 host |
| **加入房间** | 新客户端加入 clients 集合，服务器向 host 发送 `request_state` 请求当前状态 |
| **事件广播** | `sync_event`（play/pause/seek）广播给同房间所有人（排除发送者） |
| **心跳转发** | 仅当发送者是 host 时转发心跳 |
| **状态响应** | host 回复 `state_response` 后，服务器以 `sync_state` 广播给新加入者 |
| **断开处理** | host 断开后自动提升一个 client 为新 host，空房间自动销毁 |
| **健康检查** | `/health` 端点返回房间/客户端数量，同时处理 HEAD 请求（Render 需要） |

### 为什么选 aiohttp 而非 websockets

Render 等平台的健康检查会发送 HTTP HEAD 请求。`websockets` 库只接受 GET 升级请求，收到 HEAD 会抛异常导致服务不健康。`aiohttp` 可以在同一端口同时处理普通 HTTP 和 WebSocket。

---

## 5. 扩展端详解

### manifest.json

- **Manifest V3**：Chrome 要求的最新扩展规范
- **权限**：
  - `storage`：持久化房间状态（防 Service Worker 重启丢失）
  - `activeTab`：与当前标签页交互
  - `tabs`：查询所有标签页（用于自动发现视频页面）
- **host_permissions**：`youtube.com` 和 `bilibili.com`（content script 注入范围）
- **content_scripts**：在 `document_idle` 时注入 `content.js`

### background.js（Service Worker）

这是扩展的核心枢纽，负责：

#### 状态管理

```javascript
let serverUrl = 'wss://sync-watch-022p.onrender.com';
let roomId = null;
let isHost = false;
```

状态同时保存在内存和 `chrome.storage.local` 中。Service Worker 启动时从 storage 恢复，避免被浏览器回收后丢失。

#### 启动时序

```
SW 启动 → stateLoadPromise 加载 storage
          ├─ 有已保存的 roomId → 自动重连并重新加入
          └─ 在此期间收到的消息 → 放入 pendingMessages 队列
              → 加载完成后逐一处理
```

#### 消息队列机制

- **pendingMessages**：SW 启动时 storage 尚未加载完毕，此时收到的消息暂存于此
- **outboundQueue**：WebSocket 未就绪时，出站消息暂存（最多 5 条，超出丢弃最旧的）
- **flushOutboundQueue**：WebSocket 连接成功后立即发送积压消息

#### Tab 管理

```javascript
let contentTabIds = new Set();
```

- content script 发送消息时，通过 `sender.tab.id` 自动注册
- tab 关闭时通过 `chrome.tabs.onRemoved` 清理
- **关键修复**：SW 重启后 Set 清空，`discoverContentTabs()` 会主动查询所有 YouTube/Bilibili 标签页重新注册

#### 重连机制

WebSocket 断开后 3 秒自动重连，重连成功后自动重新加入之前的房间。

### content.js（内容脚本）

注入到每个 YouTube / Bilibili 页面，职责：

#### 视频检测

```javascript
function findVideo() {
  // 按优先级依次尝试：
  // 1. YouTube 播放器内的 <video>
  // 2. Bilibili 新/旧播放器内的 <video>
  // 3. 页面上任意 <video>
  // 4. Shadow DOM 内的 <video>
}
```

使用 `waitForVideo` 每秒轮询，最多等 60 秒。同时通过 `MutationObserver` 监听 DOM 变化，视频元素更换时自动重新绑定。

#### 事件同步

| 本地事件 | 处理 |
|----------|------|
| `play` | 发送 `sync_event { action: 'play', time }` |
| `pause` | 发送 `sync_event { action: 'pause', time }` |
| `seeked` | 发送 `sync_event { action: 'seek', time, paused }` |

所有事件都有 `isSyncing` 锁：远程操作触发的事件不会被再次发送，防止无限循环。锁在 500ms 后自动释放。

#### 心跳（仅 Host）

每 3 秒发送当前播放时间和暂停状态，供观众端校准。

#### Keep-Alive

每 20 秒向 background 发送 `keep_alive` 消息，防止 Service Worker 因无活动被浏览器杀死。Host 和 Guest 都会发送。

#### 上下文失效处理

扩展重新加载后，已注入的 content script 会与 background 断开连接。通过 `contextValid` 标志和 `cleanup()` 函数优雅处理，停止所有监听器和定时器，避免控制台报错。

### popup.html / popup.js

弹出窗口提供：
- 服务器地址输入（默认为 Render 部署地址）
- 创建房间按钮
- 加入房间（输入 6 位房间号）
- 房间状态显示（房间号、角色、在线人数）
- 离开房间按钮
- 连接超时处理（30 秒，适配 Render 冷启动）

---

## 6. 通信协议

所有消息均为 JSON 格式，通过 WebSocket 传输。

### 客户端 → 服务端

| type | 字段 | 说明 |
|------|------|------|
| `create_room` | — | 创建新房间 |
| `join_room` | `roomId` | 加入已有房间 |
| `sync_event` | `action`, `time`, `paused` | 播放事件（play/pause/seek） |
| `heartbeat` | `time`, `paused` | 房主心跳 |
| `state_response` | `time`, `paused` | 回复状态请求 |

### 服务端 → 客户端

| type | 字段 | 说明 |
|------|------|------|
| `room_created` | `roomId`, `count` | 房间创建成功 |
| `room_joined` | `roomId`, `count` | 加入房间成功 |
| `room_update` | `count`, `hostChanged?` | 房间人数变化 |
| `promoted` | `roomId` | 晋升为房主 |
| `sync_event` | `action`, `time`, `paused`, `timestamp` | 广播同步事件 |
| `heartbeat` | `time`, `paused`, `timestamp` | 广播心跳 |
| `sync_state` | `time`, `paused`, `timestamp` | 新加入者的初始状态 |
| `request_state` | — | 请求房主回报当前状态 |
| `error` | `message` | 错误消息 |

### 扩展内部消息（content ↔ background ↔ popup）

| type | 方向 | 说明 |
|------|------|------|
| `content_ready` | content → bg | content script 找到视频并准备就绪 |
| `keep_alive` | content → bg | 保持 Service Worker 存活 |
| `role_update` | bg → content | 通知角色（host/guest）和入房状态 |
| `room_left` | bg → content/popup | 通知已离开房间 |
| `get_state` | popup → bg | 查询当前状态（异步回复） |

---

## 7. 部署指南

### 服务端部署（Render）

1. **代码推送到 GitHub**
2. **Render 创建 Web Service**
   - 连接 GitHub 仓库
   - Environment: **Python 3**
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `python3 server/server.py`
   - 注意：`requirements.txt` 必须在仓库根目录（Render 默认从根目录读取）
3. **Health Check 配置**
   - Health Check Path: `/health`
   - 服务器已处理 HEAD 和 GET 请求
4. **环境变量**
   - Render 自动设置 `PORT`，无需手动配置

### 扩展分发

**开发者模式加载**：
1. Chrome 访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `extension/` 目录

**打包分发**：
```bash
cd sync-watch
zip -r sync-watch-extension.zip extension/
```
将 zip 发给朋友，解压后按上述步骤加载。

---

## 8. 本地开发

### 环境要求

- Python 3.8+
- pip
- Chrome 浏览器

### 启动服务端

```bash
cd server
pip install -r requirements.txt
python3 server.py
# 服务器运行在 ws://localhost:8080
```

### 调试扩展

1. 加载扩展后，在 popup 的服务器地址输入 `ws://localhost:8080`
2. **查看 background 日志**：`chrome://extensions/` → Sync Watch → 「检查视图: Service Worker」
3. **查看 content 日志**：视频页面的 DevTools Console，搜索 `[SyncWatch]`
4. **查看 popup 日志**：右键扩展图标 → 「审查弹出内容」

### 调试技巧

- 所有组件都带有日志前缀：
  - 服务端：`[Server]`
  - Background：`[SyncWatch BG]`
  - Content Script：`[SyncWatch]`
- 服务端日志使用 `flush=True` 确保在 Render 等环境中实时输出

---

## 9. 踩坑记录与解决方案

### 9.1 Render 健康检查导致服务不可用

**问题**：Render 发送 HTTP HEAD 请求做健康检查，`websockets` 库只接受 GET → 抛出 `InvalidMessage: expected GET; got HEAD`，Render 判定服务不健康。

**解决**：从 `websockets` 库迁移到 `aiohttp`，用 `web.Application` 同时注册 WebSocket 路由和 HTTP 路由，显式处理 HEAD 请求。

### 9.2 Service Worker 重启丢失状态

**问题**：Manifest V3 的 Service Worker 会在空闲约 30 秒后被浏览器终止。重启后内存中的 `roomId`、`isHost` 等全部丢失，WebSocket 连接断开。

**解决**：
- 使用 `chrome.storage.local` 持久化关键状态
- SW 启动时立即从 storage 恢复，并自动重连 + 重新加入房间
- 引入 `stateLoadPromise` + `pendingMessages` 队列，确保 storage 加载完成前不处理消息

### 9.3 Service Worker 被提前终止

**问题**：如果没有活跃的事件源，SW 很快就会被回收。

**解决**：content.js 每 20 秒发送 `keep_alive` 消息，保持 SW 活跃。Host 和 Guest 都需要。

### 9.4 消息发送失败（WebSocket 未就绪）

**问题**：SW 重启后 WebSocket 需要重新连接，此期间的消息会丢失。

**解决**：引入 `outboundQueue`，WebSocket 未 OPEN 时消息入队（上限 5 条），连接恢复后 `flushOutboundQueue` 批量发送。

### 9.5 Content Tab 注册丢失

**问题**：SW 重启后 `contentTabIds` Set 被清空，服务器发来的消息无法转发给 content script。日志表现为反复输出 `No content tabs registered`。

**解决**：`notifyContent()` 检测到 `contentTabIds` 为空时，调用 `discoverContentTabs()` 主动用 `chrome.tabs.query({ url })` 查询所有 YouTube/Bilibili 标签页，重新注册。

### 9.6 Extension Context Invalidated

**问题**：扩展重新加载/更新后，已注入页面中的旧 content script 仍在运行，但与新 background 的连接已断开。调用 `chrome.runtime.sendMessage` 会抛出 `Extension context invalidated`。

**解决**：content.js 中用 `contextValid` 标志位包裹所有 chrome API 调用。捕获到该异常后调用 `cleanup()` 停止所有监听器和定时器。

### 9.7 同步事件循环

**问题**：远程指令控制视频播放/暂停/跳转时，会触发本地的 play/pause/seeked 事件，导致事件无限循环。

**解决**：`isSyncing` 锁。执行远程操作前设为 `true`，500ms 后恢复 `false`。期间忽略所有本地事件。

### 9.8 Render 冷启动超时

**问题**：Render 免费实例长时间无请求后会休眠，首次连接需要约 30 秒冷启动。扩展 popup 之前设的 10 秒超时不够。

**解决**：将 popup.js 中的连接超时从 10 秒增加到 30 秒。

### 9.9 服务端发送消息到已断开的连接

**问题**：客户端断开时，如果 broadcast 或 send_str 目标的连接已关闭但未清理，会抛异常导致服务端崩溃。

**解决**：所有 `send_str` 调用都包裹在 `try-except` 中，捕获异常后记录日志继续运行。

---

## 10. 后续开发方向

### 功能增强

- **更多平台支持**：在 `manifest.json` 的 `content_scripts.matches` 和 `host_permissions` 中添加新域名即可
- **聊天功能**：在 WebSocket 协议中新增 `chat_message` 类型，popup 中添加聊天 UI
- **密码房间**：创建房间时设置密码，加入时需验证
- **播放列表同步**：同步播放列表中的视频切换
- **断线重连提示**：在 popup 中显示连接状态指示器

### 架构优化

- **Redis 房间存储**：当前房间数据存在内存中，服务器重启后丢失。可用 Redis 持久化
- **多服务器部署**：使用 Redis Pub/Sub 实现跨实例房间同步
- **心跳频率动态调整**：网络状况好时降低心跳频率，差时增加
- **WebRTC 信令**：利用现有 WebSocket 服务器做 WebRTC 信令，实现 P2P 直连（降低延迟）

### 代码质量

- **TypeScript 迁移**：将扩展 JS 迁移到 TypeScript 获得类型安全
- **单元测试**：为 server.py 的房间管理逻辑编写 pytest 测试
- **E2E 测试**：使用 Puppeteer 模拟两个浏览器窗口验证同步

---

## 附录：Git 提交历史

```
1a18de6 Fix: auto-discover content tabs when contentTabIds is empty after SW restart
f8a8818 Update default server URL to sync-watch-022p.onrender.com
e4d904c Change default server URL to Render deployment
385879b Increase popup connect timeout to 30s for Render cold starts
d99bf55 Fix: catch exceptions when sending to broken connections in server
0866673 Fix: track content tabs by ID instead of querying active tab, cap outbound queue
dadbae4 Fix critical sync bugs: message queue for reconnects, guest keep-alive, popup timeout
793bca8 Fix race condition on SW restart, add detailed logging on both sides
f8c9879 Fix: handle extension context invalidation gracefully, stop error spam
9439ba0 Fix sync: robust tab tracking, service worker state restore, debug logging
bc40ee4 Switch from websockets to aiohttp to handle Render HEAD health checks
4651cf6 Add HTTP health check endpoint for Render health probes
e69ec74 Fix: read PORT from environment variable for Render deployment
076cc9e Add requirements.txt to repo root for Render deployment
d5c191f Initial commit: sync-watch video synchronization tool
```
