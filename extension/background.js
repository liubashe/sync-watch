let ws = null;
let serverUrl = 'wss://sync-watch-022p.onrender.com';
let roomId = null;
let isHost = false;
let reconnectTimer = null;
let stateReady = false;
let pendingMessages = [];
let outboundQueue = [];
let contentTabIds = new Set();

const MAX_QUEUE_SIZE = 5;

const stateLoadPromise = new Promise((resolve) => {
  chrome.storage.local.get(['roomId', 'isHost', 'serverUrl'], (state) => {
    if (state.serverUrl) serverUrl = state.serverUrl;
    if (state.roomId) {
      roomId = state.roomId;
      isHost = state.isHost || false;
      console.log('[SyncWatch BG] Restored state: room=' + roomId + ' isHost=' + isHost + ' server=' + serverUrl);
      connect(() => {
        console.log('[SyncWatch BG] Reconnected, rejoining room', roomId);
        sendToServer({ type: 'join_room', roomId });
      });
    } else {
      console.log('[SyncWatch BG] No saved room state');
    }
    stateReady = true;
    for (const pm of pendingMessages) {
      processMessage(pm.msg, pm.sender, pm.sendResponse);
    }
    pendingMessages = [];
    resolve();
  });
});

async function notifyContent(msg) {
  if (contentTabIds.size === 0) {
    console.log('[SyncWatch BG] No content tabs registered');
    return;
  }
  const label = msg.type + ' ' + (msg.action || '');
  for (const tabId of contentTabIds) {
    console.log('[SyncWatch BG] -> content tab(' + tabId + '):', label);
    try {
      await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      console.log('[SyncWatch BG] Failed tab(' + tabId + '):', e.message);
      contentTabIds.delete(tabId);
    }
  }
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function saveState() {
  chrome.storage.local.set({ roomId, isHost, serverUrl });
}

function connect(onOpen) {
  disconnect();
  console.log('[SyncWatch BG] Connecting to', serverUrl);
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    console.log('[SyncWatch BG] WebSocket creation failed:', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[SyncWatch BG] WebSocket OPEN');
    if (onOpen) onOpen();
    flushOutboundQueue();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    console.log('[SyncWatch BG] <- server:', msg.type, msg.action || '');

    switch (msg.type) {
      case 'room_created':
        roomId = msg.roomId;
        isHost = true;
        saveState();
        notifyPopup({ type: 'room_created', roomId: msg.roomId, count: msg.count, isHost: true });
        await notifyContent({ type: 'role_update', isHost: true });
        break;

      case 'room_joined':
        roomId = msg.roomId;
        isHost = false;
        saveState();
        notifyPopup({ type: 'room_joined', roomId: msg.roomId, count: msg.count, isHost: false });
        await notifyContent({ type: 'role_update', isHost: false });
        break;

      case 'room_update':
        notifyPopup({ type: 'room_update', count: msg.count });
        break;

      case 'promoted':
        isHost = true;
        saveState();
        notifyPopup({ type: 'promoted', roomId: msg.roomId });
        await notifyContent({ type: 'role_update', isHost: true });
        break;

      case 'sync_event':
      case 'heartbeat':
      case 'sync_state':
      case 'request_state':
        await notifyContent(msg);
        break;

      case 'error':
        notifyPopup({ type: 'error', message: msg.message });
        break;
    }
  };

  ws.onclose = () => {
    console.log('[SyncWatch BG] WebSocket CLOSED');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    console.log('[SyncWatch BG] WebSocket ERROR');
  };
}

function disconnect() {
  clearReconnect();
  if (ws) {
    ws.close();
    ws = null;
  }
}

function scheduleReconnect() {
  if (!roomId) return;
  clearReconnect();
  reconnectTimer = setTimeout(() => {
    console.log('[SyncWatch BG] Reconnecting...');
    connect(() => {
      if (roomId) sendToServer({ type: 'join_room', roomId });
    });
  }, 3000);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[SyncWatch BG] -> server:', msg.type, msg.action || '');
    ws.send(JSON.stringify(msg));
    return true;
  }
  console.log('[SyncWatch BG] Cannot send, ws state:', ws ? ws.readyState : 'null');
  return false;
}

function flushOutboundQueue() {
  if (outboundQueue.length === 0) return;
  console.log('[SyncWatch BG] Flushing', outboundQueue.length, 'queued messages');
  const queue = outboundQueue.slice();
  outboundQueue = [];
  for (const msg of queue) {
    sendToServer(msg);
  }
}

function sendOrQueue(msg) {
  if (!sendToServer(msg)) {
    if (outboundQueue.length >= MAX_QUEUE_SIZE) {
      outboundQueue.shift();
    }
    outboundQueue.push(msg);
    ensureConnected();
  }
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  if (ws && ws.readyState === WebSocket.CONNECTING) return true;
  if (roomId && serverUrl) {
    console.log('[SyncWatch BG] Reconnecting (ensureConnected)');
    connect(() => {
      if (roomId) sendToServer({ type: 'join_room', roomId });
    });
  }
  return false;
}

function leaveRoom() {
  roomId = null;
  isHost = false;
  outboundQueue = [];
  saveState();
  disconnect();
  notifyContent({ type: 'room_left' });
}

function processMessage(msg, sender, sendResponse) {
  if (sender && sender.tab) {
    contentTabIds.add(sender.tab.id);
  }

  switch (msg.type) {
    case 'create_room':
      if (msg.serverUrl) serverUrl = msg.serverUrl;
      connect(() => sendToServer({ type: 'create_room' }));
      break;

    case 'join_room':
      if (msg.serverUrl) serverUrl = msg.serverUrl;
      connect(() => sendToServer({ type: 'join_room', roomId: msg.roomId }));
      break;

    case 'leave_room':
      leaveRoom();
      notifyPopup({ type: 'room_left' });
      break;

    case 'sync_event':
    case 'heartbeat':
    case 'state_response':
      sendOrQueue(msg);
      break;

    case 'get_state':
      if (sendResponse) {
        sendResponse({ roomId, isHost, serverUrl, connected: ws && ws.readyState === WebSocket.OPEN });
      }
      break;

    case 'keep_alive':
      ensureConnected();
      break;

    case 'content_ready':
      console.log('[SyncWatch BG] Content script ready, tab:', sender?.tab?.id);
      if (roomId) {
        ensureConnected();
        notifyContent({ type: 'role_update', isHost });
      }
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!stateReady) {
    console.log('[SyncWatch BG] State not ready, queuing:', msg.type);
    pendingMessages.push({ msg, sender, sendResponse });
    return true;
  }
  processMessage(msg, sender, sendResponse);
  if (msg.type === 'get_state') return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contentTabIds.delete(tabId);
});
