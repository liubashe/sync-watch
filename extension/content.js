(() => {
  let video = null;
  let isSyncing = false;
  let isHost = false;
  let heartbeatInterval = null;
  const SYNC_THRESHOLD = 0.5;
  const HARD_SYNC_THRESHOLD = 3.0;

  function findVideo() {
    // Try common selectors first, then fallback to generic
    const selectors = [
      'video',
      '#movie_player video',
      '.bpx-player-video-wrap video',
      '.bilibili-player-video video',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
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

  function waitForVideo(callback, maxAttempts = 30) {
    let attempts = 0;
    const check = () => {
      const v = findVideo();
      if (v) {
        callback(v);
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(check, 1000);
      }
    };
    check();
  }

  function sendToBackground(msg) {
    chrome.runtime.sendMessage(msg);
  }

  function onPlay() {
    if (isSyncing) return;
    sendToBackground({ type: 'sync_event', action: 'play', time: video.currentTime });
  }

  function onPause() {
    if (isSyncing) return;
    sendToBackground({ type: 'sync_event', action: 'pause', time: video.currentTime });
  }

  function onSeeked() {
    if (isSyncing) return;
    sendToBackground({ type: 'sync_event', action: 'seek', time: video.currentTime, paused: video.paused });
  }

  function attachVideoListeners(v) {
    video = v;
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
  }

  function detachVideoListeners() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('seeked', onSeeked);
  }

  function syncAction(action, time, paused) {
    if (!video) return;
    isSyncing = true;

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

    setTimeout(() => { isSyncing = false; }, 300);
  }

  function syncToTime(targetTime, paused) {
    if (!video) return;
    const drift = Math.abs(video.currentTime - targetTime);

    if (drift < SYNC_THRESHOLD) return;

    isSyncing = true;
    if (drift > HARD_SYNC_THRESHOLD) {
      video.currentTime = targetTime;
    } else {
      // Smooth adjustment via playback rate
      video.currentTime = targetTime;
    }

    if (paused && !video.paused) {
      video.pause();
    } else if (!paused && video.paused) {
      video.play().catch(() => {});
    }

    setTimeout(() => { isSyncing = false; }, 300);
  }

  function startHeartbeat() {
    stopHeartbeat();
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
      if (isHost) {
        startHeartbeat();
      } else {
        stopHeartbeat();
      }
    } else if (msg.type === 'room_left') {
      isHost = false;
      stopHeartbeat();
    }
  });

  // Detect video element on page load / SPA navigation
  waitForVideo((v) => {
    attachVideoListeners(v);
    sendToBackground({ type: 'content_ready' });
  });

  // Re-detect video on DOM changes (SPA navigation)
  const observer = new MutationObserver(() => {
    const v = findVideo();
    if (v && v !== video) {
      detachVideoListeners();
      attachVideoListeners(v);
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
