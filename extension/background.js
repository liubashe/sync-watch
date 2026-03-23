let ws = null;
let serverUrl = 'ws://localhost:8080';
let roomId = null;
let isHost = false;
let reconnectTimer = null;
let activeTabId = null;

function connect(onOpen) {
  disconnect();

  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    if (onOpen) onOpen();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'room_created':
        roomId = msg.roomId;
        isHost = true;
        saveState();
        notifyPopup({ type: 'room_created', roomId: msg.roomId, count: msg.count, isHost: true });
        notifyContent({ type: 'role_update', isHost: true });
        break;

      case 'room_joined':
        roomId = msg.roomId;
        isHost = false;
        saveState();
        notifyPopup({ type: 'room_joined', roomId: msg.roomId, count: msg.count, isHost: false });
        notifyContent({ type: 'role_update', isHost: false });
        break;

      case 'room_update':
        if (msg.hostChanged) {
          // Someone else might have been promoted, but if we get promoted, it comes separately
        }
        notifyPopup({ type: 'room_update', count: msg.count });
        break;

      case 'promoted':
        isHost = true;
        saveState();
        notifyPopup({ type: 'promoted', roomId: msg.roomId });
        notifyContent({ type: 'role_update', isHost: true });
        break;

      case 'sync_event':
        notifyContent(msg);
        break;

      case 'heartbeat':
        notifyContent(msg);
        break;

      case 'sync_state':
        notifyContent(msg);
        break;

      case 'request_state':
        notifyContent(msg);
        break;

      case 'error':
        notifyPopup({ type: 'error', message: msg.message });
        break;
    }
  };

  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
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
  }
}

function notifyContent(msg) {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
  }
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function saveState() {
  chrome.storage.local.set({ roomId, isHost, serverUrl });
}

function loadState() {
  return chrome.storage.local.get(['roomId', 'isHost', 'serverUrl']);
}

function leaveRoom() {
  roomId = null;
  isHost = false;
  saveState();
  disconnect();
  notifyContent({ type: 'room_left' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from content script have sender.tab
  if (sender.tab) {
    activeTabId = sender.tab.id;
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
      sendToServer(msg);
      break;

    case 'heartbeat':
      sendToServer(msg);
      break;

    case 'state_response':
      sendToServer(msg);
      break;

    case 'get_state':
      sendResponse({ roomId, isHost, serverUrl, connected: ws && ws.readyState === WebSocket.OPEN });
      return true;

    case 'content_ready':
      if (sender.tab) {
        activeTabId = sender.tab.id;
        if (roomId) {
          chrome.tabs.sendMessage(activeTabId, { type: 'role_update', isHost }).catch(() => {});
        }
      }
      break;
  }
});

// Track active tab changes
chrome.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
});
