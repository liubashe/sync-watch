const viewLobby = document.getElementById('view-lobby');
const viewRoom = document.getElementById('view-room');
const serverUrlInput = document.getElementById('server-url');
const roomCodeInput = document.getElementById('room-code');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const btnLeave = document.getElementById('btn-leave');
const roomIdEl = document.getElementById('room-id');
const roomRoleEl = document.getElementById('room-role');
const roomCountEl = document.getElementById('room-count');
const toastEl = document.getElementById('toast');
let connectTimeout = null;

function showView(view) {
  viewLobby.classList.remove('active');
  viewRoom.classList.remove('active');
  view.classList.add('active');
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function updateRoomView(roomId, count, isHost) {
  roomIdEl.textContent = roomId;
  roomCountEl.textContent = `${count} 人在线`;
  roomRoleEl.textContent = isHost ? '房主' : '观众';
  roomRoleEl.className = 'room-role ' + (isHost ? 'role-host' : 'role-guest');
  showView(viewRoom);
}

function startConnectTimeout() {
  clearConnectTimeout();
  connectTimeout = setTimeout(() => {
    resetButtons();
    showToast('连接超时，请检查服务器地址');
  }, 10000);
}

function clearConnectTimeout() {
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
}

chrome.runtime.sendMessage({ type: 'get_state' }, (state) => {
  if (chrome.runtime.lastError) return;
  if (state && state.roomId) {
    updateRoomView(state.roomId, '?', state.isHost);
  }
  if (state && state.serverUrl) {
    serverUrlInput.value = state.serverUrl;
  }
});

btnCreate.addEventListener('click', () => {
  const serverUrl = serverUrlInput.value.trim();
  if (!serverUrl) {
    showToast('请输入服务器地址');
    return;
  }
  btnCreate.disabled = true;
  btnCreate.textContent = '连接中...';
  startConnectTimeout();
  chrome.runtime.sendMessage({ type: 'create_room', serverUrl });
});

btnJoin.addEventListener('click', () => {
  const serverUrl = serverUrlInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!serverUrl) {
    showToast('请输入服务器地址');
    return;
  }
  if (!code || code.length < 4) {
    showToast('请输入有效的房间号');
    return;
  }
  btnJoin.disabled = true;
  btnJoin.textContent = '连接中...';
  startConnectTimeout();
  chrome.runtime.sendMessage({ type: 'join_room', serverUrl, roomId: code });
});

btnLeave.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'leave_room' });
  showView(viewLobby);
  resetButtons();
});

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

function resetButtons() {
  btnCreate.disabled = false;
  btnCreate.textContent = '创建房间';
  btnJoin.disabled = false;
  btnJoin.textContent = '加入房间';
  clearConnectTimeout();
}

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'room_created':
      resetButtons();
      updateRoomView(msg.roomId, msg.count, true);
      break;

    case 'room_joined':
      resetButtons();
      updateRoomView(msg.roomId, msg.count, false);
      break;

    case 'room_update':
      roomCountEl.textContent = `${msg.count} 人在线`;
      break;

    case 'promoted':
      roomRoleEl.textContent = '房主';
      roomRoleEl.className = 'room-role role-host';
      break;

    case 'room_left':
      showView(viewLobby);
      resetButtons();
      break;

    case 'error':
      resetButtons();
      showToast(msg.message || '发生错误');
      break;
  }
});
