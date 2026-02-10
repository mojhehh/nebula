(function() {
  'use strict';

  // === CONNECTING OVERLAY ===
  // Show a visible loading screen while WebRTC negotiates so the page
  // doesn't look frozen. Covers everything until video actually plays.
  var connectingOverlay = document.createElement('div');
  connectingOverlay.id = 'nebula-connecting';
  connectingOverlay.innerHTML =
    '<div style="text-align:center;">' +
      '<div style="width:60px;height:60px;border:4px solid rgba(147,51,234,0.3);border-top-color:#9333ea;border-radius:50%;animation:nbspin 0.8s linear infinite;margin:0 auto 24px;"></div>' +
      '<h2 style="margin:0 0 8px;font-size:1.3rem;color:#f3e8ff;font-family:system-ui,sans-serif;">Connecting to your browser...</h2>' +
      '<p id="nebula-connect-status" style="margin:0;color:#a78bfa;font-size:0.9rem;font-family:system-ui,sans-serif;">Establishing WebRTC session</p>' +
    '</div>';
  Object.assign(connectingOverlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '999999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#05010d',
    transition: 'opacity 0.5s'
  });
  var spinStyle = document.createElement('style');
  spinStyle.textContent = '@keyframes nbspin{to{transform:rotate(360deg)}}';
  document.head.appendChild(spinStyle);
  document.body.appendChild(connectingOverlay);

  var connectStatus = document.getElementById('nebula-connect-status');
  var connectingDismissed = false;

  function dismissConnecting() {
    if (connectingDismissed) return;
    connectingDismissed = true;
    connectingOverlay.style.opacity = '0';
    setTimeout(function() { connectingOverlay.remove(); }, 600);
  }

  // Update status text as we progress
  setTimeout(function() {
    if (!connectingDismissed && connectStatus) connectStatus.textContent = 'Negotiating media stream...';
  }, 3000);
  setTimeout(function() {
    if (!connectingDismissed && connectStatus) connectStatus.textContent = 'Waiting for video...';
  }, 8000);
  setTimeout(function() {
    if (!connectingDismissed && connectStatus) connectStatus.textContent = 'Still connecting — this may take a moment on mobile...';
  }, 15000);
  // Safety: dismiss after 60s no matter what
  setTimeout(dismissConnecting, 60000);

  // === 0. AUTO-LOGIN ===
  function setInputValue(input, value) {
    // Multiple approaches to ensure Vue/React picks up the value on Safari
    var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (nativeSet && nativeSet.set) {
      nativeSet.set.call(input, value);
    } else {
      input.value = value;
    }
    input.setAttribute('value', value);
    // Fire every event type that frameworks might listen to
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    // Also try InputEvent for newer frameworks
    try { input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value })); } catch(e) {}
  }

  var loginAttempts = 0;
  var maxLoginAttempts = 10;

  function attemptLogin() {
    loginAttempts++;
    var connectEl = document.querySelector('.connect');
    if (!connectEl) {
      // No login form = already logged in or not loaded yet
      if (loginAttempts < maxLoginAttempts) {
        setTimeout(attemptLogin, 500);
      }
      return;
    }

    var inputs = connectEl.querySelectorAll('input');
    var btn = connectEl.querySelector('button');
    if (inputs.length < 2 || !btn) {
      if (loginAttempts < maxLoginAttempts) setTimeout(attemptLogin, 500);
      return;
    }

    console.log('[Nebula] Auto-login attempt ' + loginAttempts);
    if (connectStatus) connectStatus.textContent = 'Logging in... (attempt ' + loginAttempts + ')';

    // Focus + set each input
    inputs[0].focus();
    setInputValue(inputs[0], 'Nebula');
    inputs[1].focus();
    setInputValue(inputs[1], 'nebula2026x');

    // Click connect after a delay so Vue processes the values
    setTimeout(function() {
      btn.click();
      // Also try dispatching pointer events for Safari
      try {
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      } catch(e) {}

      console.log('[Nebula] Login button clicked');

      // Check if login worked after 3 seconds — if form is still there, retry
      setTimeout(function() {
        var stillThere = document.querySelector('.connect');
        if (stillThere && loginAttempts < maxLoginAttempts) {
          console.log('[Nebula] Login form still visible, retrying...');
          attemptLogin();
        }
      }, 3000);
    }, 500);
  }

  // Start auto-login after a short delay to let Neko's Vue app mount
  setTimeout(attemptLogin, 800);

  // Pre-set localStorage so Neko initializes unmuted
  localStorage.setItem('muted', '0');
  localStorage.setItem('mute', '0');
  localStorage.setItem('volume', '100');

  // Wait for video to actually have frames playing
  function waitForVideo(cb) {
    var settled = false;
    function done(video, overlay) {
      if (settled) return;
      settled = true;
      dismissConnecting();
      cb(video, overlay);
    }

    var check = setInterval(function() {
      var video = document.querySelector('video');
      var overlay = document.querySelector('.overlay');
      if (!video || !overlay) return;

      // Method 1: standard readyState check
      if (video.readyState >= 2 && !video.paused && video.videoWidth > 0) {
        clearInterval(check);
        done(video, overlay);
        return;
      }

      // Method 2: video has srcObject with active tracks (WebRTC connected)
      if (video.srcObject) {
        var tracks = video.srcObject.getTracks();
        var hasActive = tracks.some(function(t) { return t.readyState === 'live'; });
        if (hasActive) {
          // WebRTC stream is live, video just might not have fired playing yet
          // Give it a moment then dismiss
          clearInterval(check);
          setTimeout(function() { done(video, overlay); }, 500);
          return;
        }
      }

      // Method 3: canvas pixel check — if we can draw a non-black frame
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        try {
          var c = document.createElement('canvas');
          c.width = 8; c.height = 8;
          var ctx = c.getContext('2d');
          ctx.drawImage(video, 0, 0, 8, 8);
          var px = ctx.getImageData(0, 0, 8, 8).data;
          var nonBlack = false;
          for (var i = 0; i < px.length; i += 4) {
            if (px[i] > 10 || px[i+1] > 10 || px[i+2] > 10) { nonBlack = true; break; }
          }
          if (nonBlack) {
            clearInterval(check);
            done(video, overlay);
            return;
          }
        } catch(e) {}
      }
    }, 300);

    // Also listen for multiple video events
    var videoEvents = ['playing', 'loadeddata', 'canplay'];
    videoEvents.forEach(function(evt) {
      document.addEventListener(evt, function handler(e) {
        if (e.target && e.target.tagName === 'VIDEO') {
          document.removeEventListener(evt, handler, true);
          var video = e.target;
          var overlay = document.querySelector('.overlay');
          if (overlay) {
            setTimeout(function() { done(video, overlay); }, 300);
          }
        }
      }, true);
    });

    // Fallback: if login form disappears and overlay exists, it's connected
    var loginGoneCheck = setInterval(function() {
      if (settled) { clearInterval(loginGoneCheck); return; }
      var connectEl = document.querySelector('.connect');
      var video = document.querySelector('video');
      var overlay = document.querySelector('.overlay');
      // Login form gone + overlay present = Neko is in session
      if (!connectEl && overlay && video) {
        clearInterval(loginGoneCheck);
        // Give WebRTC a few seconds to start streaming
        if (connectStatus) connectStatus.textContent = 'Connected! Loading video stream...';
        setTimeout(function() {
          if (!settled) done(video, overlay);
        }, 4000);
      }
    }, 500);
  }

  waitForVideo(function(video, overlay) {
    var container = overlay.parentElement || video.parentElement;

    // === 0.1 FORCE AUDIO ON ===
    var audioUnlocked = false;

    function tryUnmuteNeko() {
      if (video) {
        video.muted = false;
        video.volume = 1.0;
        if (video.srcObject) {
          video.srcObject.getAudioTracks().forEach(function(t) { t.enabled = true; });
        }
        video.play().catch(function() {});
      }
      var muteIcon = document.querySelector('.fa-volume-mute');
      if (muteIcon) {
        muteIcon.click();
        console.log('[Nebula] Clicked Neko mute icon to unmute');
      }
    }

    function onUserGesture() {
      if (audioUnlocked) return;
      audioUnlocked = true;
      console.log('[Nebula] User gesture detected, unlocking audio');
      tryUnmuteNeko();
      var attempts = 0;
      var iv = setInterval(function() {
        if (video && video.muted) tryUnmuteNeko();
        if (++attempts >= 10 || (video && !video.muted)) {
          clearInterval(iv);
        }
      }, 500);
    }

    document.addEventListener('touchend', onUserGesture, { once: true });
    document.addEventListener('click', onUserGesture, { once: true });
    setTimeout(tryUnmuteNeko, 1000);
    setTimeout(tryUnmuteNeko, 3000);

    // === 0.5 CONTROL INSTRUCTIONS TOOLTIP ===
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      var tooltip = document.createElement('div');
      tooltip.innerHTML = '\u{1F446} Tap to click<br>\u261D\uFE0F Swipe to scroll<br>\u2328\uFE0F Tap keyboard button to type';
      Object.assign(tooltip.style, {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(0,0,0,0.85)',
        color: '#fff',
        padding: '20px 28px',
        borderRadius: '16px',
        fontSize: '16px',
        lineHeight: '2',
        zIndex: '1000000',
        textAlign: 'center',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        maxWidth: '90vw',
        pointerEvents: 'none',
        transition: 'opacity 0.5s'
      });
      document.body.appendChild(tooltip);
      // Show for 8 seconds (was 5)
      setTimeout(function() {
        tooltip.style.opacity = '0';
        setTimeout(function() { tooltip.remove(); }, 600);
      }, 8000);
      document.addEventListener('touchstart', function dismissTip() {
        tooltip.style.opacity = '0';
        setTimeout(function() { tooltip.remove(); }, 600);
        document.removeEventListener('touchstart', dismissTip);
      }, { once: true });
    }

    // === 1. SINGLE-FINGER SCROLL OVERLAY ===
    var SCROLL_THRESHOLD = 10;
    var SCROLL_MULTIPLIER = 0.25;
    var isScrolling = false;
    var touchStartX = 0, touchStartY = 0;
    var lastScrollX = 0, lastScrollY = 0;
    var scrollVelY = 0, scrollVelX = 0;
    var momentumRaf = null;

    var noSelectCSS = document.createElement('style');
    noSelectCSS.textContent = '.neko-scrolling,.neko-scrolling *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important;}';
    document.head.appendChild(noSelectCSS);

    function sendWheel(clientX, clientY, deltaX, deltaY) {
      overlay.dispatchEvent(new WheelEvent('wheel', {
        deltaX: deltaX, deltaY: deltaY,
        clientX: clientX, clientY: clientY,
        bubbles: true, cancelable: true
      }));
    }

    function cancelMomentum() {
      if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
      scrollVelY = 0; scrollVelX = 0;
    }

    overlay.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) return;
      cancelMomentum();
      var t = e.touches[0];
      touchStartX = t.clientX; touchStartY = t.clientY;
      lastScrollX = t.clientX; lastScrollY = t.clientY;
      isScrolling = false;
    }, { passive: true, capture: true });

    overlay.addEventListener('touchmove', function(e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      if (!isScrolling) {
        var totalDx = t.clientX - touchStartX;
        var totalDy = t.clientY - touchStartY;
        if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > SCROLL_THRESHOLD) {
          isScrolling = true;
          document.body.classList.add('neko-scrolling');
          overlay.dispatchEvent(new MouseEvent('mouseup', {
            clientX: touchStartX, clientY: touchStartY,
            button: 0, bubbles: true
          }));
        }
      }
      if (isScrolling) {
        e.preventDefault();
        e.stopPropagation();
        var dx = t.clientX - lastScrollX;
        var dy = t.clientY - lastScrollY;
        scrollVelY = dy * SCROLL_MULTIPLIER;
        scrollVelX = dx * SCROLL_MULTIPLIER;
        sendWheel(touchStartX, touchStartY, scrollVelX, scrollVelY);
        lastScrollX = t.clientX; lastScrollY = t.clientY;
      }
    }, { passive: false, capture: true });

    overlay.addEventListener('touchend', function(e) {
      if (isScrolling) {
        e.preventDefault();
        e.stopPropagation();
        isScrolling = false;
        document.body.classList.remove('neko-scrolling');
        (function momentum() {
          if (Math.abs(scrollVelY) < 0.5 && Math.abs(scrollVelX) < 0.5) return;
          sendWheel(touchStartX, touchStartY, scrollVelX, scrollVelY);
          scrollVelY *= 0.92; scrollVelX *= 0.92;
          momentumRaf = requestAnimationFrame(momentum);
        })();
      }
    }, { passive: false, capture: true });

    overlay.addEventListener('touchcancel', function() {
      isScrolling = false;
      document.body.classList.remove('neko-scrolling');
    }, { passive: true, capture: true });

    // === 2. KEYBOARD BUTTON ===
    var kbBtn = document.createElement('div');
    kbBtn.innerHTML = '\u2328\uFE0F';
    kbBtn.title = 'Toggle Keyboard';
    kbBtn.setAttribute('data-nebula-ui', 'true');
    Object.assign(kbBtn.style, {
      position: 'fixed', bottom: '70px', right: '16px',
      width: '50px', height: '50px', borderRadius: '14px',
      background: 'linear-gradient(135deg, rgba(147,51,234,0.9), rgba(124,58,237,0.9))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '24px', zIndex: '999999', cursor: 'pointer',
      boxShadow: '0 4px 20px rgba(147,51,234,0.5)',
      border: '1px solid rgba(255,255,255,0.2)',
      userSelect: 'none', WebkitTapHighlightColor: 'transparent',
      transition: 'transform 0.2s, opacity 0.2s', opacity: '0.85'
    });

    var hiddenInput = document.createElement('textarea');
    Object.assign(hiddenInput.style, {
      position: 'fixed', bottom: '0', left: '0',
      width: '1px', height: '1px', opacity: '0.01',
      zIndex: '999998', fontSize: '16px'
    });
    hiddenInput.setAttribute('autocomplete', 'off');
    hiddenInput.setAttribute('autocorrect', 'off');
    hiddenInput.setAttribute('autocapitalize', 'off');
    hiddenInput.setAttribute('spellcheck', 'false');
    document.body.appendChild(hiddenInput);

    var kbOpen = false;
    kbBtn.addEventListener('touchstart', function(e) {
      e.preventDefault(); e.stopPropagation();
      kbOpen = !kbOpen;
      if (kbOpen) {
        hiddenInput.focus();
        kbBtn.style.background = 'linear-gradient(135deg, rgba(34,197,94,0.9), rgba(22,163,74,0.9))';
        kbBtn.style.transform = 'scale(1.1)';
      } else {
        hiddenInput.blur();
        kbBtn.style.background = 'linear-gradient(135deg, rgba(147,51,234,0.9), rgba(124,58,237,0.9))';
        kbBtn.style.transform = 'scale(1)';
      }
    }, { passive: false });

    function forwardKey(type, e) {
      overlay.dispatchEvent(new KeyboardEvent(type, {
        key: e.key, code: e.code, keyCode: e.keyCode, which: e.which,
        shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
        bubbles: true, cancelable: true
      }));
    }

    hiddenInput.addEventListener('keydown', function(e) {
      forwardKey('keydown', e);
      setTimeout(function() { hiddenInput.value = ''; }, 10);
    });
    hiddenInput.addEventListener('keyup', function(e) { forwardKey('keyup', e); });

    window.addEventListener('focusout', function() {
      if (kbOpen) {
        kbOpen = false;
        kbBtn.style.background = 'linear-gradient(135deg, rgba(147,51,234,0.9), rgba(124,58,237,0.9))';
        kbBtn.style.transform = 'scale(1)';
      }
    });

    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      document.body.appendChild(kbBtn);
    }

    console.log('[Nebula] iPad mode loaded: tap=click, swipe=scroll, keyboard');
  });
})();
