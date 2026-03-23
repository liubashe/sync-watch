let ws = null;
let serverUrl = 'ws://localhost:8080';
let roomId = null;
let isHost = false;
let reconnectTimer = null;

async function getActiveVideoTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) return tab.id;
    const tabs = await chrome.tabs.query({ active: true });
    return tabs.length > 0 ? tabs[0].id : null;
  } catch {
    return null;
  }
}

async function notifyContent(msg) {
  const tabId = await getActiveVideoTab();
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function saveState() {
  chrome.storage.local.set({ roomId, isHost, serverUrl });
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  if (ws && ws.readyState === WebSocket.CONNECTING) return true;
  if (roomId) {
    connect(() => sendToServer({ type: 'join_room', roomId }));
  }
  return false;
}

function connect(onOpen) {
  disconnect();
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[SyncWatch] WebSocket connected');
    if (onOpen) onOpen();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    console.log('[SyncWatch] Received:', msg.type);

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
    console.log('[SyncWatch] WebSocket closed');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {};
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
    console.log('[SyncWatch] Reconnecting...');
    connect(() => {
      if (roomId) {
        sendToServer({ type: 'join_room', roomId });
      }
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
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function leaveRoom() {
  roomId = null;
  isHost = false;
  saveState();
  disconnect();
  notifyContent({ type: 'room_left' });
}

// Restore state on service worker startup
chrome.storage.local.get(['roomId', 'isHost', 'serverUrl'], (state) => {
  if (state.serverUrl) serverUrl = state.serverUrl;
  if (state.roomId) {
    roomId = state.roomId;
    isHost = state.isHost || false;
    console.log('[SyncWatch] Restoring room:', roomId);
    connect(() => sendToServer({ type: 'join_room', roomId }));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
      ensureConnected();
      sendToServer(msg);
      break;

    case 'get_state':
      sendResponse({ roomId, isHost, serverUrl, connected: ws && ws.readyState === WebSocket.OPEN });
      return true;

    case 'content_ready':
      console.log('[SyncWatch] Content script ready, tab:', sender.tab?.id);
      if (roomId) {
        notifyContent({ type: 'role_update', isHost });
        ensureConnected();
      }
      break;
  }
});
