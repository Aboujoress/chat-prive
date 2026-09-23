// =====================================================================
//  APPELS VOCAUX ET VIDÉO — WebRTC, signalisation via le canal temps réel existant
//  Se charge APRÈS chat.js : réutilise myId, getPartnerId(), profiles,
//  mediaUrl(), showToast(), initialAvatar() déjà définis là-bas.
//  Ne touche à aucune table Supabase : tout passe par un simple broadcast.
// =====================================================================
(function () {
    if (window.__callModuleLoaded) return;
    window.__callModuleLoaded = true;

    const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const RING_TIMEOUT_MS = 40000;

    const PHONE_ICON = '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    const MIC_ICON = '<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    const MIC_OFF_ICON = '<svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2M19 10v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    const SPEAKER_ICON = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
    const CAM_ICON = '<svg viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
    const CAM_OFF_ICON = '<svg viewBox="0 0 24 24"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const FLIP_ICON = '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

    let channel = null, pc = null, localStream = null, remoteAudio = null;
    let currentCallId = null, pendingOffer = null, pendingCandidates = [];
    let callState = 'idle';   // idle | calling | ringing | connected
    let minimized = false;
    let isCaller = false;
    let isVideoCall = false;  // vrai pour un appel vidéo (appelant comme appelé)
    let facing = 'user';      // caméra avant ('user') ou arrière ('environment')
    let ringTimer = null, durationTimer = null, callStartedAt = 0;
    let speakerOn = false;
    let els = {};

    function myUserId() { return (typeof myId !== 'undefined' && myId) || (window.chatAuth && window.chatAuth.userId); }
    function partnerName() { try { return partnerDisplayName(getPartnerId()); } catch (e) { return 'Mon Amour'; } }
    function showToastSafe(msg) { if (typeof showToast === 'function') showToast(msg); else alert(msg); }
    function fallbackAvatarSrc() { try { return initialAvatar(partnerName()); } catch (e) { return ''; } }

    function partnerAvatarUrl(done) {
        try {
            const pid = getPartnerId();
            const p = pid ? profiles[pid] : null;
            if (p && p.avatar_url) mediaUrl(p.avatar_url).then(done);
            else done(null);
        } catch (e) { done(null); }
    }

    /* ---------- Micro et caméra ---------- */

    function mediaConstraints(wantVideo) {
        return {
            audio: true,
            video: wantVideo ? { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } } : false
        };
    }

    // Si la caméra est refusée ou absente, on continue en audio seulement
    async function getLocalMedia(wantVideo) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(wantVideo));
            return { stream: stream, video: wantVideo };
        } catch (e) {
            if (!wantVideo) throw e;
            const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(false));
            showToastSafe('Caméra indisponible : appel en audio seulement');
            return { stream: stream, video: false };
        }
    }

    function attachLocalPreview() {
        if (!els.localVideo) return;
        const hasVideo = !!(localStream && localStream.getVideoTracks().length > 0);
        els.localVideo.srcObject = hasVideo ? localStream : null;
        els.localVideo.classList.toggle('show', hasVideo);
        els.localVideo.classList.remove('back');
        if (hasVideo) {
            const p = els.localVideo.play();
            if (p && p.catch) p.catch(() => { /* ignoré */ });
        }
    }

    /* ---------- Interface (injectée, ne dépend pas du HTML existant) ---------- */

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
        .call-btn { flex:none; width:40px; height:40px; display:grid; place-items:center; border:0; border-radius:50%; color:var(--muted); background:transparent; cursor:pointer; transition:color .15s, background .15s, transform .15s; }
        .call-btn:hover { color:var(--a-text); background:var(--surface-2); }
        .call-btn:active { transform:scale(.88); }
        .call-btn svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
        .call-overlay { display:none; position:fixed; inset:0; z-index:4000; align-items:center; justify-content:center; flex-direction:column; padding:32px 24px; color:#fff; text-align:center; background: radial-gradient(120% 100% at 50% 0%, rgba(162,28,174,.35), transparent 60%), var(--bg,#110c24); }
        .call-overlay.open { display:flex; animation:callFadeIn .25s ease-out; }
        .call-avatar-wrap { position:relative; width:132px; height:132px; margin-bottom:18px; }
        .call-avatar-wrap img { width:100%; height:100%; border-radius:50%; object-fit:cover; background:#2a2050; box-shadow:0 20px 50px -18px rgba(162,28,174,.6); }
        .call-ring { position:absolute; inset:-14px; border-radius:50%; border:2px solid rgba(255,255,255,.35); opacity:0; }
        .call-overlay[data-state="calling"] .call-ring, .call-overlay[data-state="ringing"] .call-ring { opacity:1; animation:callRing 1.6s ease-out infinite; }
        .call-name { font-family:var(--font-display,serif); font-size:1.5rem; font-weight:600; margin:0 0 6px; }
        .call-status { font-size:.95rem; opacity:.75; margin:0 0 40px; min-height:1.3em; }
        .call-controls { display:none; align-items:center; gap:26px; }
        .call-overlay[data-state="ringing"] .call-actions-two { display:flex; }
        .call-overlay[data-state="calling"] .call-actions-one, .call-overlay[data-state="connected"] .call-actions-one { display:flex; }
        .call-round { width:64px; height:64px; border-radius:50%; border:0; display:grid; place-items:center; cursor:pointer; transition:transform .15s cubic-bezier(.34,1.56,.64,1); }
        .call-round:active { transform:scale(.92); }
        .call-round svg { width:26px; height:26px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
        .call-round.accept { background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff; }
        .call-round.decline, .call-round.hangup { background:linear-gradient(135deg,#ef4444,#dc2626); color:#fff; }
        .call-round.hangup svg, .call-round.decline svg { transform:rotate(135deg); }
        .call-round.mute, .call-round.cam, .call-round.flip, .call-round.speaker { background:rgba(255,255,255,.14); color:#fff; }
        .call-round.mute.on, .call-round.cam.on, .call-round.speaker.on { background:#fff; color:#111; }
        .call-round.video-only { display:none; }
        @keyframes callFadeIn { from{opacity:0} to{opacity:1} }
        @keyframes callRing { 0%{transform:scale(1);opacity:.7} 100%{transform:scale(1.18);opacity:0} }

        /* --- Appel vidéo --- */
        .call-video-remote, .call-video-local { display:none; position:absolute; object-fit:cover; background:#000; }
        .call-video-remote { inset:0; width:100%; height:100%; z-index:0; }
        .call-video-local { top:calc(14px + env(safe-area-inset-top, 0px)); right:14px; width:96px; height:128px; border-radius:14px; z-index:3; box-shadow:0 8px 24px rgba(0,0,0,.45); transform:scaleX(-1); }
        .call-video-local.show { display:block; }
        .call-video-local.back { transform:none; }
        .call-overlay.video-on .call-video-remote { display:block; }
        .call-overlay .call-avatar-wrap, .call-overlay .call-name, .call-overlay .call-status, .call-overlay .call-controls { position:relative; z-index:2; }
        .call-overlay .call-minimize { position:absolute; top:calc(14px + env(safe-area-inset-top, 0px)); left:14px; z-index:5; }
        .call-overlay.video-on .call-avatar-wrap { display:none; }
        .call-overlay.video-on .call-name, .call-overlay.video-on .call-status { position:absolute; left:0; right:0; margin:0; text-shadow:0 1px 6px rgba(0,0,0,.7); }
        .call-overlay.video-on .call-name { top:calc(14px + env(safe-area-inset-top, 0px)); font-size:1.1rem; }
        .call-overlay.video-on .call-status { top:calc(42px + env(safe-area-inset-top, 0px)); font-size:.85rem; min-height:0; opacity:.9; }
        .call-overlay.video-on .call-controls { position:absolute; left:0; right:0; bottom:calc(28px + env(safe-area-inset-bottom, 0px)); justify-content:center; }
        .call-overlay[data-video="1"] .call-actions-one { gap:14px; }
        .call-overlay[data-video="1"] .call-round { width:56px; height:56px; }
        .call-overlay[data-video="1"] .call-round svg { width:24px; height:24px; }
        .call-overlay[data-video="1"] .call-round.video-only { display:grid; }

        /* --- Choix vocal / vidéo --- */
        .call-choice { display:none; position:fixed; inset:0; z-index:4500; align-items:flex-end; justify-content:center; padding:16px; background:rgba(0,0,0,.55); }
        .call-choice.open { display:flex; animation:callFadeIn .2s ease-out; }
        .call-choice-box { width:min(100%, 360px); display:flex; flex-direction:column; gap:10px; padding:18px; border-radius:22px; background:#1a1433; color:#fff; text-align:center; margin-bottom:env(safe-area-inset-bottom, 0px); }
        .call-choice-title { margin:0 0 4px; opacity:.8; font-size:.95rem; }
        .call-choice-box button { display:flex; align-items:center; justify-content:center; gap:10px; border:0; border-radius:14px; padding:14px; font:inherit; font-weight:600; color:#fff; background:#2a2050; cursor:pointer; }
        .call-choice-box button.video { background:linear-gradient(135deg, var(--a1,#e11d48), var(--a2,#a21cae)); }
        .call-choice-box button.cancel { background:transparent; opacity:.7; font-weight:500; }
        .call-choice-box svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
        `;
        document.head.appendChild(style);
    }

    function buildUI() {
        const header = document.querySelector('.chat-header');
        if (header) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'call-btn';
            btn.title = 'Appeler';
            btn.innerHTML = PHONE_ICON;
            btn.addEventListener('click', openCallChoice);
            const meBtnEl = document.getElementById('meBtn');
            if (meBtnEl && meBtnEl.parentNode) meBtnEl.parentNode.insertBefore(btn, meBtnEl);
            else header.appendChild(btn);
        }

        const overlay = document.createElement('div');
        overlay.className = 'call-overlay';
        overlay.dataset.video = '0';
        overlay.innerHTML =
            '<video class="call-video-remote" id="callRemoteVideo" autoplay playsinline muted></video>' +
            '<video class="call-video-local" id="callLocalVideo" autoplay playsinline muted></video>' +
            '<button type="button" class="call-minimize" id="callMinimizeBtn" aria-label="Réduire"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></button>' +
            '<div class="call-avatar-wrap"><span class="call-ring"></span><img id="callAvatarImg" alt=""></div>' +
            '<h2 class="call-name" id="callName"></h2>' +
            '<p class="call-status" id="callStatus"></p>' +
            '<div class="call-controls call-actions-two">' +
            '<button type="button" class="call-round decline" id="callDeclineBtn">' + PHONE_ICON + '</button>' +
            '<button type="button" class="call-round accept" id="callAcceptBtn">' + PHONE_ICON + '</button>' +
            '</div>' +
            '<div class="call-controls call-actions-one">' +
            '<button type="button" class="call-round mute" id="callMuteBtn">' + MIC_ICON + '</button>' +
            '<button type="button" class="call-round cam video-only" id="callCamBtn" aria-label="Caméra">' + CAM_ICON + '</button>' +
            '<button type="button" class="call-round hangup" id="callHangupBtn">' + PHONE_ICON + '</button>' +
            '<button type="button" class="call-round flip video-only" id="callFlipBtn" aria-label="Changer de caméra">' + FLIP_ICON + '</button>' +
            '<button type="button" class="call-round speaker" id="callSpeakerBtn">' + SPEAKER_ICON + '</button>' +
            '</div>';
        document.body.appendChild(overlay);

        els = {
            overlay: overlay,
            avatarImg: overlay.querySelector('#callAvatarImg'),
            name: overlay.querySelector('#callName'),
            status: overlay.querySelector('#callStatus'),
            acceptBtn: overlay.querySelector('#callAcceptBtn'),
            declineBtn: overlay.querySelector('#callDeclineBtn'),
            hangupBtn: overlay.querySelector('#callHangupBtn'),
            muteBtn: overlay.querySelector('#callMuteBtn'),
            camBtn: overlay.querySelector('#callCamBtn'),
            flipBtn: overlay.querySelector('#callFlipBtn'),
            speakerBtn: overlay.querySelector('#callSpeakerBtn'),
            remoteVideo: overlay.querySelector('#callRemoteVideo'),
            localVideo: overlay.querySelector('#callLocalVideo')
        };
        els.minimizeBtn = overlay.querySelector('#callMinimizeBtn');
        els.acceptBtn.addEventListener('click', acceptIncomingCall);
        els.declineBtn.addEventListener('click', () => endCall('declined'));
        els.hangupBtn.addEventListener('click', () => endCall('hangup'));
        els.muteBtn.addEventListener('click', toggleMute);
        els.camBtn.addEventListener('click', toggleCamera);
        els.flipBtn.addEventListener('click', flipCamera);
        els.speakerBtn.addEventListener('click', toggleSpeaker);
        els.minimizeBtn.addEventListener('click', minimizeCall);

        // Fenêtre de choix : appel vocal ou appel vidéo
        const choice = document.createElement('div');
        choice.className = 'call-choice';
        choice.innerHTML =
            '<div class="call-choice-box">' +
            '<p class="call-choice-title" id="callChoiceTitle">Appeler</p>' +
            '<button type="button" data-mode="voice">' + PHONE_ICON + ' Appel vocal</button>' +
            '<button type="button" class="video" data-mode="video">' + CAM_ICON + ' Appel vidéo</button>' +
            '<button type="button" class="cancel" data-mode="cancel">Annuler</button>' +
            '</div>';
        document.body.appendChild(choice);
        els.choice = choice;
        els.choiceTitle = choice.querySelector('#callChoiceTitle');
        choice.addEventListener('click', (e) => {
            const btn = e.target.closest && e.target.closest('button[data-mode]');
            if (btn) {
                const mode = btn.dataset.mode;
                closeCallChoice();
                if (mode === 'voice') startOutgoingCall(false);
                else if (mode === 'video') startOutgoingCall(true);
                return;
            }
            if (e.target === choice) closeCallChoice();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCallChoice(); });

        const bar = document.createElement('div');
        bar.className = 'call-bar';
        bar.innerHTML = '<span class="call-bar-dot"></span><span id="callBarText">Appel en cours</span>';
        bar.addEventListener('click', restoreCall);
        document.body.appendChild(bar);
        els.bar = bar;
        els.barTime = bar.querySelector('#callBarText');

        remoteAudio = document.createElement('audio');
        remoteAudio.autoplay = true;
        remoteAudio.style.display = 'none';
        document.body.appendChild(remoteAudio);
    }

    function openCallChoice() {
        if (callState !== 'idle') { showToastSafe('Un appel est déjà en cours'); return; }
        if (!myUserId()) return;
        if (!getPartnerId()) { showToastSafe("Ta moitié n'est pas encore connue de l'application"); return; }
        els.choiceTitle.textContent = 'Appeler ' + partnerName();
        els.choice.classList.add('open');
    }
    function closeCallChoice() {
        if (els.choice) els.choice.classList.remove('open');
    }

    function showOverlay(state) {
        els.overlay.dataset.state = state;
        els.overlay.dataset.video = isVideoCall ? '1' : '0';
        if (!minimized) els.overlay.classList.add('open');
        els.name.textContent = partnerName();
        updateCallBarLabel();
        els.status.textContent = state === 'calling' ? (isVideoCall ? 'Appel vidéo en cours…' : 'Appel en cours…')
            : state === 'ringing' ? (isVideoCall ? 'Appel vidéo entrant…' : 'Appel entrant…')
            : '00:00';
        els.avatarImg.src = fallbackAvatarSrc();
        partnerAvatarUrl((url) => { if (url) els.avatarImg.src = url; });
    }
    function hideOverlay() { els.overlay.classList.remove('open'); }

    function minimizeCall() {
        minimized = true;
        hideOverlay();
        els.bar.classList.add('show');
        updateCallBarLabel();
    }
    function restoreCall() {
        minimized = false;
        els.bar.classList.remove('show');
        els.overlay.classList.add('open');
    }
    function updateCallBarLabel() {
        if (!els.barTime) return;
        if (callState === 'calling') els.barTime.textContent = 'Appel vers ' + partnerName() + '…';
        else if (callState === 'connected') els.barTime.textContent = partnerName();
    }

    function startDurationTimer() {
        callStartedAt = Date.now();
        durationTimer = setInterval(() => {
            const s = Math.floor((Date.now() - callStartedAt) / 1000);
            const t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
            els.status.textContent = t;
            if (els.barTime) els.barTime.textContent = t;
        }, 1000);
    }

    function toggleMute() {
        if (!localStream) return;
        const track = localStream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        const muted = !track.enabled;
        els.muteBtn.classList.toggle('on', muted);
        els.muteBtn.innerHTML = muted ? MIC_OFF_ICON : MIC_ICON;
    }

    function toggleCamera() {
        if (!localStream) return;
        const track = localStream.getVideoTracks()[0];
        if (!track) { showToastSafe('Aucune caméra active'); return; }
        track.enabled = !track.enabled;
        const off = !track.enabled;
        els.camBtn.classList.toggle('on', off);
        els.camBtn.innerHTML = off ? CAM_OFF_ICON : CAM_ICON;
        els.localVideo.classList.toggle('show', !off);
    }

    // Passe de la caméra avant à l'arrière (et inversement) sans couper l'appel
    async function flipCamera() {
        if (!localStream || !pc) return;
        const old = localStream.getVideoTracks()[0];
        if (!old) { showToastSafe('Aucune caméra active'); return; }
        const next = facing === 'user' ? 'environment' : 'user';
        try {
            const s = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: next, width: { ideal: 640 }, height: { ideal: 480 } }
            });
            const newTrack = s.getVideoTracks()[0];
            newTrack.enabled = old.enabled;
            const sender = pc.getSenders().find(x => x.track && x.track.kind === 'video');
            if (sender) await sender.replaceTrack(newTrack);
            localStream.removeTrack(old);
            old.stop();
            localStream.addTrack(newTrack);
            facing = next;
            els.localVideo.srcObject = localStream;
            els.localVideo.classList.toggle('back', facing === 'environment');
        } catch (e) {
            showToastSafe('Impossible de changer de caméra');
        }
    }

    async function toggleSpeaker() {
        if (!remoteAudio || typeof remoteAudio.setSinkId !== 'function') {
            showToastSafe('Ton navigateur ne permet pas de changer la sortie audio ici.');
            return;
        }
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const speaker = devices.find(d => d.kind === 'audiooutput' && /speaker|haut/i.test(d.label));
            await remoteAudio.setSinkId(speakerOn ? 'default' : (speaker ? speaker.deviceId : 'default'));
            speakerOn = !speakerOn;
            els.speakerBtn.classList.toggle('on', speakerOn);
        } catch (e) {
            showToastSafe('Changement de sortie audio indisponible sur cet appareil.');
        }
    }

    /* ---------- Sonnerie discrète pour un appel entrant ---------- */
    let ringAudioCtx = null, ringInterval = null;
    function playRingSound() {
        try {
            ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // Deux notes qui s'enchaînent, comme une vraie sonnerie de téléphone
            const playNote = (freq, startAt, duration, peak) => {
                const osc = ringAudioCtx.createOscillator();
                const gain = ringAudioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const t0 = ringAudioCtx.currentTime + startAt;
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.03);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
                osc.connect(gain);
                gain.connect(ringAudioCtx.destination);
                osc.start(t0);
                osc.stop(t0 + duration + 0.05);
            };

            const ringPattern = () => {
                // "dring-dring" : deux notes rapprochées, deux fois, avec une pause
                playNote(1000, 0.00, 0.35, 0.5);
                playNote(1000, 0.40, 0.35, 0.5);
                playNote(1000, 1.00, 0.35, 0.5);
                playNote(1000, 1.40, 0.35, 0.5);
            };

            ringPattern();
            ringInterval = setInterval(ringPattern, 2600);
            if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400, 800]);
        } catch (e) { /* pas grave */ }
    }
    function stopRingSound() {
        clearInterval(ringInterval);
        if (ringAudioCtx) { try { ringAudioCtx.close(); } catch (e) { /* ignoré */ } ringAudioCtx = null; }
    }
    function notifyIncomingLocally() {
        try {
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                const n = new Notification(partnerName() + ' t\'appelle', { body: (isVideoCall ? 'Appel vidéo entrant' : 'Appel entrant') + ' — Mon Chat Privé', tag: 'call-incoming' });
                n.onclick = () => { window.focus(); n.close(); };
            }
        } catch (e) { /* ignoré */ }
    }

    /* ---------- Signalisation : réutilise le canal temps réel du chat ---------- */

    function ensureChannel() {
        if (channel) return channel;
        channel = supabaseClient.channel('chat-prive');
        channel.on('broadcast', { event: 'call-offer' }, ({ payload }) => onOffer(payload));
        channel.on('broadcast', { event: 'call-answer' }, ({ payload }) => onAnswer(payload));
        channel.on('broadcast', { event: 'call-ice' }, ({ payload }) => onRemoteIce(payload));
        channel.on('broadcast', { event: 'call-hangup' }, ({ payload }) => onRemoteHangup(payload));
        channel.on('broadcast', { event: 'call-busy' }, ({ payload }) => onBusy(payload));
        return channel;
    }
    function send(event, payload) {
        ensureChannel().send({ type: 'broadcast', event: event, payload: Object.assign({ from: myUserId() }, payload) });
    }

    function createPeerConnection() {
        const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        conn.onicecandidate = (e) => { if (e.candidate) send('call-ice', { callId: currentCallId, candidate: e.candidate.toJSON() }); };
        conn.ontrack = (e) => {
            remoteAudio.srcObject = e.streams[0];
            const p = remoteAudio.play();
            if (p && p.catch) {
                p.catch(() => {
                    showToastSafe("Touche l'écran pour activer le son");
                    const retry = () => { remoteAudio.play().catch(() => { /* ignoré */ }); els.overlay.removeEventListener('click', retry); };
                    els.overlay.addEventListener('click', retry, { once: true });
                });
            }
            // L'image de l'autre : la vidéo est muette, le son passe par remoteAudio
            if (e.track && e.track.kind === 'video') {
                els.remoteVideo.srcObject = e.streams[0];
                els.overlay.classList.add('video-on');
                const vp = els.remoteVideo.play();
                if (vp && vp.catch) vp.catch(() => { /* ignoré */ });
            }
        };
        conn.onconnectionstatechange = () => {
            if ((conn.connectionState === 'failed' || conn.connectionState === 'closed') && callState !== 'idle') endCall('failed');
        };
        return conn;
    }

    function flushPendingCandidates() {
        pendingCandidates.forEach(c => pc.addIceCandidate(c).catch(() => { /* ignoré */ }));
        pendingCandidates = [];
    }

    /* ---------- Appel sortant ---------- */
    async function startOutgoingCall(video) {
        if (!myUserId() || callState !== 'idle') { if (callState !== 'idle') showToastSafe('Un appel est déjà en cours'); return; }
        if (!getPartnerId()) { showToastSafe("Ta moitié n'est pas encore connue de l'application"); return; }

        let media;
        try { media = await getLocalMedia(!!video); }
        catch (e) { showToastSafe('Micro refusé ou indisponible'); return; }
        localStream = media.stream;
        isVideoCall = media.video;

        currentCallId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
        isCaller = true;
        callState = 'calling';
        pc = createPeerConnection();
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        attachLocalPreview();
        showOverlay('calling');

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send('call-offer', { callId: currentCallId, sdp: offer, video: isVideoCall });

        ringTimer = setTimeout(() => {
            if (callState === 'calling') { send('call-hangup', { callId: currentCallId, reason: 'timeout' }); endCall('timeout'); }
        }, RING_TIMEOUT_MS);
    }

    /* ---------- Appel entrant ---------- */
    function onOffer(payload) {
        if (!payload || payload.from === myUserId()) return;
        if (callState === 'calling') {
            // Les deux appellent en même temps : celui dont l'identifiant est le plus grand cède.
            if (myUserId() > payload.from) return;
            endCall('glare', true);
        } else if (callState !== 'idle') {
            send('call-busy', { callId: payload.callId });
            return;
        }
        currentCallId = payload.callId;
        pendingOffer = payload.sdp;
        isCaller = false;
        isVideoCall = !!payload.video;
        callState = 'ringing';
        showOverlay('ringing');
        playRingSound();
        notifyIncomingLocally();
        ringTimer = setTimeout(() => { if (callState === 'ringing') endCall('missed'); }, RING_TIMEOUT_MS);
    }

    async function acceptIncomingCall() {
        clearTimeout(ringTimer);
        stopRingSound();
        try {
            const media = await getLocalMedia(isVideoCall);
            localStream = media.stream;
        } catch (e) { showToastSafe('Micro refusé ou indisponible'); endCall('error'); return; }

        pc = createPeerConnection();
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        attachLocalPreview();
        await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
        flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send('call-answer', { callId: currentCallId, sdp: answer });
        callState = 'connected';
        showOverlay('connected');
        startDurationTimer();
    }

    async function onAnswer(payload) {
        if (!payload || payload.callId !== currentCallId || payload.from === myUserId() || !pc) return;
        clearTimeout(ringTimer);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        flushPendingCandidates();
        callState = 'connected';
        showOverlay('connected');
        startDurationTimer();
    }

    function onRemoteIce(payload) {
        if (!payload || payload.callId !== currentCallId || payload.from === myUserId()) return;
        const candidate = new RTCIceCandidate(payload.candidate);
        if (pc && pc.remoteDescription) pc.addIceCandidate(candidate).catch(() => { /* ignoré */ });
        else pendingCandidates.push(candidate);
    }

    function onRemoteHangup(payload) {
        if (!payload || payload.callId !== currentCallId) return;
        endCall(payload.reason === 'timeout' ? 'missed' : 'hangup', true);
    }
    function onBusy(payload) {
        if (!payload || payload.callId !== currentCallId) return;
        showToastSafe('Occupé(e)');
        endCall('busy', true);
    }
    function logCallResult(reason) {
        if (!isCaller || !currentCallId || reason === 'glare') return;
        const duration = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;
        const status = duration > 0 ? 'ended' : (reason === 'declined' ? 'declined' : 'missed');
        const content = JSON.stringify({ status: status, duration: duration, video: isVideoCall });
        supabaseClient.from('messages')
            .insert([{ content: content, type: 'call', sender_id: myUserId(), client_id: newClientId() }])
            .select()
            .then(({ data, error }) => { if (!error && data && data[0]) notifyPartner(data[0]); });
    }

    function endCall(reason, silent) {
        logCallResult(reason);
        callStartedAt = 0;   // sinon un appel sans réponse hériterait de la durée du précédent
        clearTimeout(ringTimer);
        stopRingSound();
        clearInterval(durationTimer);
        if (!silent && callState !== 'idle' && currentCallId) send('call-hangup', { callId: currentCallId, reason: reason });
        if (pc) { try { pc.close(); } catch (e) { /* ignoré */ } pc = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
        if (remoteAudio) remoteAudio.srcObject = null;
        if (els.remoteVideo) els.remoteVideo.srcObject = null;
        if (els.localVideo) { els.localVideo.srcObject = null; els.localVideo.classList.remove('show', 'back'); }
        if (els.muteBtn) { els.muteBtn.classList.remove('on'); els.muteBtn.innerHTML = MIC_ICON; }
        if (els.camBtn) { els.camBtn.classList.remove('on'); els.camBtn.innerHTML = CAM_ICON; }
        if (els.speakerBtn) els.speakerBtn.classList.remove('on');
        speakerOn = false;
        pendingCandidates = [];
        pendingOffer = null;
        currentCallId = null;
        callState = 'idle';
        isVideoCall = false;
        facing = 'user';
        minimized = false;
        els.bar.classList.remove('show');
        els.overlay.classList.remove('video-on');
        els.overlay.dataset.video = '0';
        hideOverlay();
    }

    window.addEventListener('beforeunload', () => {
        if (callState !== 'idle' && currentCallId) { try { send('call-hangup', { callId: currentCallId, reason: 'left' }); } catch (e) { /* ignoré */ } }
    });

    function init() {
        injectStyles();
        buildUI();
        ensureChannel();
    }

    window.chatCall = { start: openCallChoice };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();