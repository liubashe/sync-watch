(() => {
  let video = null;
  let isSyncing = false;
  let isHost = false;
  let heartbeatInterval = null;
  let ready = false;
  const SYNC_THRESHOLD = 0.5;
  const HARD_SYNC_THRESHOLD = 3.0;
  const LOG_PREFIX = '[SyncWatch]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function findVideo() {
    const selectors = [
      '#movie_player video',
      '.bpx-player-video-wrap video',
      '.bilibili-player-video video',
      'video',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.src) return el;
    }
    // Fallback: any video element
    const all = document.querySelectorAll('video');
    for (const v of all) {
      if (v.readyState > 0 || v.src || v.currentSrc) return v;
    }
    if (all.length > 0) return all[0];
    // Check shadow DOMs
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        const v = el.shadowRoot.querySelector('video');
        if (v) return v;
      }
    }
    return null;
  }

  function waitForVideo(callback, maxAttempts = 60) {
    let attempts = 0;
    const check = () => {
      const v = findVideo();
      if (v) {
        log('Video element found');
        callback(v);
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(check, 1000);
      } else {
        log('Video element not found after', maxAttempts, 'attempts');
      }
    };
    check();
  }

  function sendToBackground(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      log('Failed to send to background:', e.message);
    }
  }

  function onPlay() {
    if (isSyncing) return;
    log('Local play at', video.currentTime);
    sendToBackground({ type: 'sync_event', action: 'play', time: video.currentTime });
  }

  function onPause() {
    if (isSyncing) return;
    log('Local pause at', video.currentTime);
    sendToBackground({ type: 'sync_event', action: 'pause', time: video.currentTime });
  }

  function onSeeked() {
    if (isSyncing) return;
    log('Local seek to', video.currentTime);
    sendToBackground({ type: 'sync_event', action: 'seek', time: video.currentTime, paused: video.paused });
  }

  function attachVideoListeners(v) {
    if (video === v) return;
    detachVideoListeners();
    video = v;
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    log('Attached listeners to video element');
  }

  function detachVideoListeners() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('seeked', onSeeked);
  }

  function syncAction(action, time, paused) {
    if (!video) {
      log('syncAction: no video element');
      return;
    }
    isSyncing = true;
    log('Remote', action, 'to', time);

    if (action === 'play') {
      video.currentTime = time;
      video.play().catch(() => {});
    } else if (action === 'pause') {
      video.currentTime = time;
      video.pause();
    } else if (action === 'seek') {
      video.currentTime = time;
      if (paused) {
        video.pause();
      } else {
        video.play().catch(() => {});
      }
    }

    setTimeout(() => { isSyncing = false; }, 500);
  }

  function syncToTime(targetTime, paused) {
    if (!video) return;
    const drift = Math.abs(video.currentTime - targetTime);

    if (drift < SYNC_THRESHOLD) return;

    isSyncing = true;
    log('Correcting drift:', drift.toFixed(2), 's');
    video.currentTime = targetTime;

    if (paused && !video.paused) {
      video.pause();
    } else if (!paused && video.paused) {
      video.play().catch(() => {});
    }

    setTimeout(() => { isSyncing = false; }, 500);
  }

  function startHeartbeat() {
    stopHeartbeat();
    log('Starting heartbeat (host mode)');
    heartbeatInterval = setInterval(() => {
      if (video && isHost) {
        sendToBackground({ type: 'heartbeat', time: video.currentTime, paused: video.paused });
      }
    }, 3000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    log('Received message:', msg.type);

    if (msg.type === 'sync_event') {
      syncAction(msg.action, msg.time, msg.paused);
    } else if (msg.type === 'heartbeat') {
      if (!isHost) {
        syncToTime(msg.time, msg.paused);
      }
    } else if (msg.type === 'sync_state') {
      syncToTime(msg.time, msg.paused);
    } else if (msg.type === 'request_state') {
      if (video) {
        sendToBackground({ type: 'state_response', time: video.currentTime, paused: video.paused });
      }
    } else if (msg.type === 'role_update') {
      isHost = msg.isHost;
      log('Role updated: isHost =', isHost);
      if (isHost) {
        startHeartbeat();
      } else {
        stopHeartbeat();
      }
    } else if (msg.type === 'room_left') {
      isHost = false;
      stopHeartbeat();
      log('Left room');
    }
  });

  waitForVideo((v) => {
    attachVideoListeners(v);
    ready = true;
    sendToBackground({ type: 'content_ready' });
  });

  // Re-detect video on DOM changes (SPA navigation)
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const v = findVideo();
      if (v && v !== video) {
        attachVideoListeners(v);
        log('Video element changed, re-attached');
      }
    }, 500);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  log('Content script loaded on', window.location.hostname);
})();
