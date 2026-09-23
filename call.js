// =====================================================================
//  APPELS VOCAUX — WebRTC, signalisation via le canal temps réel existant
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

    let channel = null, pc = null, localStream = null, remoteAudio = null;
    let currentCallId = null, pendingOffer = null, pendingCandidates = [];
    let callState = 'idle';   // idle | calling | ringing | connected
    let isCaller = false;
    let ringTimer = null, durationTimer = null, callStartedAt = 0;
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
        .call-round.mute { background:rgba(255,255,255,.14); color:#fff; }
        .call-round.mute.on { background:#fff; color:#111; }
        @keyframes callFadeIn { from{opacity:0} to{opacity:1} }
        @keyframes callRing { 0%{transform:scale(1);opacity:.7} 100%{transform:scale(1.18);opacity:0} }
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
            btn.addEventListener('click', startOutgoingCall);
            const meBtnEl = document.getElementById('meBtn');
            if (meBtnEl && meBtnEl.parentNode) meBtnEl.parentNode.insertBefore(btn, meBtnEl);
            else header.appendChild(btn);
        }

        const overlay = document.createElement('div');
        overlay.className = 'call-overlay';
        overlay.innerHTML =
            '<div class="call-avatar-wrap"><span class="call-ring"></span><img id="callAvatarImg" alt=""></div>' +
            '<h2 class="call-name" id="callName"></h2>' +
            '<p class="call-status" id="callStatus"></p>' +
            '<div class="call-controls call-actions-two">' +
            '<button type="button" class="call-round decline" id="callDeclineBtn">' + PHONE_ICON + '</button>' +
            '<button type="button" class="call-round accept" id="callAcceptBtn">' + PHONE_ICON + '</button>' +
            '</div>' +
            '<div class="call-controls call-actions-one">' +
            '<button type="button" class="call-round mute" id="callMuteBtn">' + MIC_ICON + '</button>' +
            '<button type="button" class="call-round hangup" id="callHangupBtn">' + PHONE_ICON + '</button>' +
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
            muteBtn: overlay.querySelector('#callMuteBtn')
        };
        els.acceptBtn.addEventListener('click', acceptIncomingCall);
        els.declineBtn.addEventListener('click', () => endCall('declined'));
        els.hangupBtn.addEventListener('click', () => endCall('hangup'));
        els.muteBtn.addEventListener('click', toggleMute);

        remoteAudio = document.createElement('audio');
        remoteAudio.autoplay = true;
        remoteAudio.style.display = 'none';
        document.body.appendChild(remoteAudio);
    }

    function showOverlay(state) {
        els.overlay.dataset.state = state;
        els.overlay.classList.add('open');
        els.name.textContent = partnerName();
        els.status.textContent = state === 'calling' ? 'Appel en cours…' : state === 'ringing' ? 'Appel entrant…' : '00:00';
        els.avatarImg.src = fallbackAvatarSrc();
        partnerAvatarUrl((url) => { if (url) els.avatarImg.src = url; });
    }
    function hideOverlay() { els.overlay.classList.remove('open'); }

    function startDurationTimer() {
        callStartedAt = Date.now();
        durationTimer = setInterval(() => {
            const s = Math.floor((Date.now() - callStartedAt) / 1000);
            els.status.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
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

    /* ---------- Sonnerie discrète pour un appel entrant ---------- */
    let ringAudioCtx = null, ringInterval = null;
    function playRingSound() {
        try {
            ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const beep = () => {
                const osc = ringAudioCtx.createOscillator();
                const gain = ringAudioCtx.createGain();
                osc.frequency.value = 740;
                gain.gain.setValueAtTime(0.001, ringAudioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.2, ringAudioCtx.currentTime + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, ringAudioCtx.currentTime + 0.4);
                osc.connect(gain); gain.connect(ringAudioCtx.destination);
                osc.start(); osc.stop(ringAudioCtx.currentTime + 0.4);
            };
            beep();
            ringInterval = setInterval(beep, 1500);
            if (navigator.vibrate) navigator.vibrate([300, 200, 300, 200, 300]);
        } catch (e) { /* pas grave */ }
    }
    function stopRingSound() {
        clearInterval(ringInterval);
        if (ringAudioCtx) { try { ringAudioCtx.close(); } catch (e) { /* ignoré */ } ringAudioCtx = null; }
    }
    function notifyIncomingLocally() {
        try {
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                const n = new Notification(partnerName() + ' t\'appelle', { body: 'Appel entrant — Mon Chat Privé', tag: 'call-incoming' });
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
    async function startOutgoingCall() {
        if (!myUserId() || callState !== 'idle') { if (callState !== 'idle') showToastSafe('Un appel est déjà en cours'); return; }
        if (!getPartnerId()) { showToastSafe("Ta moitié n'est pas encore connue de l'application"); return; }

        try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { showToastSafe('Micro refusé ou indisponible'); return; }

        currentCallId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
        isCaller = true;
        callState = 'calling';
        pc = createPeerConnection();
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        showOverlay('calling');

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send('call-offer', { callId: currentCallId, sdp: offer });

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
        callState = 'ringing';
        showOverlay('ringing');
        playRingSound();
        notifyIncomingLocally();
        ringTimer = setTimeout(() => { if (callState === 'ringing') endCall('missed'); }, RING_TIMEOUT_MS);
    }

    async function acceptIncomingCall() {
        clearTimeout(ringTimer);
        stopRingSound();
        try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { showToastSafe('Micro refusé ou indisponible'); endCall('error'); return; }

        pc = createPeerConnection();
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
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
        const content = JSON.stringify({ status: status, duration: duration });
        supabaseClient.from('messages')
            .insert([{ content: content, type: 'call', sender_id: myUserId(), client_id: newClientId() }])
            .select()
            .then(({ data, error }) => { if (!error && data && data[0]) notifyPartner(data[0]); });
    }

    function endCall(reason, silent) {
        logCallResult(reason);
        clearTimeout(ringTimer);
        stopRingSound();
        clearInterval(durationTimer);
        if (!silent && callState !== 'idle' && currentCallId) send('call-hangup', { callId: currentCallId, reason: reason });
        if (pc) { try { pc.close(); } catch (e) { /* ignoré */ } pc = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
        if (remoteAudio) remoteAudio.srcObject = null;
        if (els.muteBtn) { els.muteBtn.classList.remove('on'); els.muteBtn.innerHTML = MIC_ICON; }
        pendingCandidates = [];
        pendingOffer = null;
        currentCallId = null;
        callState = 'idle';
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

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();