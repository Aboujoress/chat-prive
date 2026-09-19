// =====================================================================
//  MON CHAT PRIVÉ — logique de la messagerie
//  Ce fichier suppose que auth.js a déjà créé window.supabaseClient
//  et rempli window.chatAuth. Il ne démarre rien avant window.startChat().
// =====================================================================

const supabaseClient = window.supabaseClient;

const BASE_TITLE = document.title;
const MAX_RECORD_SECONDS = 300;      // un vocal s'arrête et s'envoie seul après 5 min
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const HISTORY_LIMIT = 300;           // messages chargés depuis Supabase
const CACHE_LIMIT = 200;             // messages gardés pour le mode hors ligne
const SIGNED_URL_SECONDS = 3600;     // durée de vie d'une adresse de fichier
const CACHE_KEY = 'chatCache';
const OUTBOX_KEY = 'chatOutbox';
const PROFILES_KEY = 'chatProfiles';
const MEDIA_URL_KEY = 'chatMediaUrls';

// Mon identifiant de compte. Renseigné par startChat().
let myId = null;

// Ciblages DOM
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const chatMessages = document.getElementById('chatMessages');
const emojiToggleBtn = document.getElementById('emojiToggleBtn');
const emojiPicker = document.getElementById('emojiPicker');
const activityBar = document.getElementById('activityBar');
const recordingTimer = document.getElementById('recordingTimer');
const cancelRecBtn = document.getElementById('cancelRecBtn');
const imageBtn = document.getElementById('imageBtn');
const imageInput = document.getElementById('imageInput');
const recordBtn = document.getElementById('recordBtn');
const statusText = document.getElementById('statusText');
const offlineBanner = document.getElementById('offlineBanner');
const canvas = document.getElementById('audioVisualizer');
const canvasCtx = canvas ? canvas.getContext('2d') : null;

// Variables globales audio
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let timerInterval = null;
let recordStartedAt = 0;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let microphoneSource = null;
let animFrameId = null;

// État du chat en direct
let realtimeChannel = null;
let channelReady = false;
let historyLoaded = false;
let loadingHistory = false;
const pendingIncoming = [];
let lastDateKey = null;
let lastRenderedTime = 0;   // sert à détecter un message arrivé dans le désordre
let unreadCount = 0;
let partnerOnline = false;
let partnerTyping = false;
let partnerTypingTimeout = null;
let lastTypingSent = 0;
let flushing = false;

/* ---------- Stockage local (mode hors ligne) ---------- */

function readJSON(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value === null || value === undefined ? fallback : value;
    } catch (e) {
        return fallback;
    }
}

function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.warn('Stockage local impossible :', e);
    }
}

// Copie locale des derniers messages : affiche l'historique sans connexion
let messageCache = readJSON(CACHE_KEY, []);

function saveCache() {
    writeJSON(CACHE_KEY, messageCache.slice(-CACHE_LIMIT));
}

function cacheAdd(msg) {
    if (!msg || messageCache.some(m => m.id === msg.id)) return;
    messageCache.push(msg);
    if (messageCache.length > CACHE_LIMIT) messageCache = messageCache.slice(-CACHE_LIMIT);
    saveCache();
}

function cacheRemove(id) {
    messageCache = messageCache.filter(m => m.id !== id);
    saveCache();
}

function cacheFind(id) {
    return messageCache.find(m => m.id === id) || null;
}

// Messages écrits sans connexion, en attente d'envoi
function getOutbox() { return readJSON(OUTBOX_KEY, []); }
function setOutbox(list) { writeJSON(OUTBOX_KEY, list); }

/* ---------- Utilitaires ---------- */

// Identifiant unique généré par le navigateur : la base refuse deux fois
// le même, ce qui empêche tout doublon lors d'un réessai.
function newClientId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(dateString) {
    const date = dateString ? new Date(dateString) : new Date();
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dateLabel(d) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
    if (d.toDateString() === yesterday.toDateString()) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Vrai si l'erreur vient d'un problème de connexion (et non d'une règle refusée)
function isNetworkError(error) {
    if (!navigator.onLine) return true;
    const msg = String((error && (error.message || error)) || '').toLowerCase();
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed/.test(msg);
}

// Code 23505 = la base a refusé un doublon : le message était déjà passé.
function isDuplicateError(error) {
    return !!error && (error.code === '23505' || /duplicate key/i.test(error.message || ''));
}

function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
        osc.onended = () => ctx.close();
    } catch (e) { /* pas de son, ce n'est pas grave */ }
}

function updateStatus() {
    if (!statusText) return;
    let text;
    let cls;
    if (!navigator.onLine) {
        text = '⚠️ Pas de connexion';
        cls = 'offline';
    } else if (!channelReady) {
        text = '⏳ Connexion…';
        cls = 'offline';
    } else if (partnerTyping) {
        text = '✍️ écrit…';
        cls = 'typing';
    } else if (partnerOnline) {
        text = '● En ligne';
        cls = 'online';
    } else {
        text = '○ Hors ligne';
        cls = 'offline';
    }
    statusText.textContent = text;
    statusText.className = `status ${cls}`;
}

function refreshConnectionUI() {
    if (offlineBanner) offlineBanner.classList.toggle('show', !navigator.onLine);
    updateStatus();
}

/* ---------- Fichiers privés : adresses signées ---------- */
// Le bucket "media" est privé. On ne stocke plus d'URL publique dans la
// base, seulement le chemin du fichier. L'adresse est demandée au serveur
// à l'affichage, et reste valable une heure.

let signedUrls = readJSON(MEDIA_URL_KEY, {});   // chemin -> { url, exp }
const localMedia = new Map();                   // chemin -> copie locale (envoi en cours)

function saveSignedUrls() {
    // On ne garde que les 150 plus récentes pour ne pas saturer localStorage
    const entries = Object.entries(signedUrls).sort((a, b) => b[1].exp - a[1].exp).slice(0, 150);
    signedUrls = Object.fromEntries(entries);
    writeJSON(MEDIA_URL_KEY, signedUrls);
}

async function mediaUrl(path) {
    if (!path) return null;

    const local = localMedia.get(path);
    if (local) return local;

    const now = Date.now();
    const hit = signedUrls[path];
    if (hit && hit.exp > now) return hit.url;

    // Hors ligne : on retourne l'adresse périmée, le service worker a
    // peut-être gardé une copie de l'image.
    if (!navigator.onLine) return hit ? hit.url : null;

    try {
        const { data, error } = await supabaseClient.storage
            .from('media')
            .createSignedUrl(path, SIGNED_URL_SECONDS);

        if (error || !data) {
            console.warn('Adresse de fichier indisponible :', error && error.message);
            return hit ? hit.url : null;
        }
        signedUrls[path] = { url: data.signedUrl, exp: now + (SIGNED_URL_SECONDS - 300) * 1000 };
        saveSignedUrls();
        return data.signedUrl;
    } catch (e) {
        return hit ? hit.url : null;
    }
}

// Remplit le src d'une image ou d'un lecteur audio, sans bloquer l'affichage
function applyMediaSrc(el, path) {
    const local = localMedia.get(path);
    if (local) {
        el.src = local;
        return;
    }
    mediaUrl(path).then(url => { if (url) el.src = url; });
}

/* ---------- Affichage des messages ---------- */

function resetChatView() {
    chatMessages.innerHTML = '';
    lastDateKey = null;
    lastRenderedTime = 0;
}

function ensureDateSeparator(date) {
    const key = date.toDateString();
    if (key !== lastDateKey) {
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.textContent = dateLabel(date);
        chatMessages.appendChild(sep);
        lastDateKey = key;
    }
}

// Le texte n'est jamais interprété comme du HTML (sécurité)
function renderMessage(msg, replaceEl) {
    if (!msg || document.getElementById(`msg-${msg.id}`)) return;

    const created = msg.created_at ? new Date(msg.created_at) : new Date();
    const isMine = msg.sender_id === myId;

    // Message qu'on vient d'envoyer : il prend la place de la bulle "en cours d'envoi"
    let target = replaceEl || null;
    if (!target && isMine && msg.client_id) {
        const rec = takeSendingMatch(msg.client_id);
        if (rec) target = rec.el;
    }
    const replacing = !!(target && target.parentNode);
    if (!replacing) ensureDateSeparator(created);

    const div = document.createElement('div');
    div.id = `msg-${msg.id}`;
    div.className = `message ${isMine ? 'sent' : 'received'}`;

    // Bouton supprimer : uniquement sur mes propres messages
    if (isMine) {
        const del = document.createElement('button');
        del.className = 'delete-msg-btn';
        del.title = 'Supprimer';
        del.textContent = '✕';
        del.addEventListener('click', () => {
            if (confirm('Supprimer ce message ?')) window.deleteMessageFromDB(msg.id);
        });
        div.appendChild(del);

        // Sur téléphone : toucher le message fait apparaître le bouton ✕
        div.addEventListener('click', (e) => {
            if (['AUDIO', 'IMG', 'BUTTON'].includes(e.target.tagName)) return;
            div.classList.toggle('show-actions');
        });
    }

    if (msg.type === 'image') {
        const img = document.createElement('img');
        img.className = 'message-img';
        img.alt = 'Photo';
        img.addEventListener('click', () => { if (img.src) openModal(img.src); });
        applyMediaSrc(img, msg.content);
        div.appendChild(img);
    } else if (msg.type === 'audio') {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        // Un seul vocal à la fois
        audio.addEventListener('play', () => {
            document.querySelectorAll('audio').forEach(a => { if (a !== audio) a.pause(); });
        });
        applyMediaSrc(audio, msg.content);
        div.appendChild(audio);
    } else {
        const p = document.createElement('p');
        p.textContent = msg.content;
        div.appendChild(p);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(msg.created_at);
    div.appendChild(time);

    if (replacing) {
        target.replaceWith(div);
    } else {
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    lastRenderedTime = Math.max(lastRenderedTime, created.getTime());
}

// Message écrit hors ligne : affiché avec une horloge 🕓 en attendant l'envoi
function renderPending(item) {
    if (document.getElementById(`pending-${item.clientId}`)) return;

    ensureDateSeparator(new Date(item.created_at));

    const div = document.createElement('div');
    div.id = `pending-${item.clientId}`;
    div.className = 'message sent pending';

    const p = document.createElement('p');
    p.textContent = item.content;
    div.appendChild(p);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${formatTime(item.created_at)} 🕓`;
    div.appendChild(time);

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removePending(clientId) {
    const el = document.getElementById(`pending-${clientId}`);
    if (el) el.remove();
}

/* ---------- Envoi instantané : la bulle apparaît tout de suite ---------- */

const sending = new Map();   // clientId -> { el, type }

function addSending(clientId, type, opts) {
    const now = new Date();
    ensureDateSeparator(now);

    const div = document.createElement('div');
    div.className = 'message sent pending sending';

    if (type === 'image') {
        const img = document.createElement('img');
        img.src = opts.previewSrc;
        img.className = 'message-img';
        img.alt = "Photo en cours d'envoi";
        div.appendChild(img);
    } else {
        const p = document.createElement('p');
        p.textContent = type === 'audio'
            ? `🎙️ Vocal (${formatDuration(opts.seconds)}) — envoi…`
            : opts.text;
        div.appendChild(p);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${formatTime(now.toISOString())} 🕓`;
    div.appendChild(time);

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    sending.set(clientId, { el: div, type: type });
}

function setSendingPreview(clientId, src) {
    const rec = sending.get(clientId);
    const img = rec && rec.el.querySelector('img');
    if (img) img.src = src;
}

function failSending(clientId) {
    const rec = sending.get(clientId);
    if (rec) rec.el.remove();
    sending.delete(clientId);
}

// Le temps réel peut annoncer notre propre message avant la réponse
// d'envoi : on retrouve la bulle grâce au client_id, sans ambiguïté.
function takeSendingMatch(clientId) {
    const rec = sending.get(clientId);
    if (rec) sending.delete(clientId);
    return rec || null;
}

// Le serveur a confirmé : la bulle devient le vrai message
function finishSending(clientId, saved) {
    cacheAdd(saved);
    const rec = sending.get(clientId);
    if (rec) sending.delete(clientId);

    if (document.getElementById(`msg-${saved.id}`)) {   // déjà affiché par le temps réel
        if (rec) rec.el.remove();
        return;
    }
    renderMessage(saved, rec ? rec.el : null);
}

// Message reçu en temps réel
function handleIncoming(msg) {
    cacheAdd(msg);

    if (!historyLoaded) {          // on attend la fin du chargement de l'historique
        pendingIncoming.push(msg);
        return;
    }

    // Message plus ancien que le dernier affiché (il arrive en retard) :
    // on recharge pour que l'ordre chronologique reste juste.
    const t = new Date(msg.created_at).getTime();
    if (lastRenderedTime && t < lastRenderedTime - 1000 && !sending.has(msg.client_id)) {
        loadHistory();
        return;
    }

    renderMessage(msg);

    if (msg.sender_id !== myId) {
        partnerTyping = false;
        updateStatus();
        refreshProfileUI();
        playBeep();
        if (document.hidden) {
            unreadCount++;
            document.title = `(${unreadCount}) ${BASE_TITLE}`;
        }
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && myId) {
        unreadCount = 0;
        document.title = BASE_TITLE;
        flushOutbox();
        loadProfiles();
    }
});

/* ---------- Supabase : envoi ---------- */

// Retourne { status: 'ok' | 'network' | 'error', error }
async function insertMessage(content, type, clientId) {
    const { data, error } = await supabaseClient
        .from('messages')
        .insert([{ content: content, type: type, sender_id: myId, client_id: clientId }])
        .select();

    if (error) {
        if (isDuplicateError(error)) {
            // Le message était déjà arrivé : rien à faire, le temps réel l'affichera.
            failSending(clientId);
            return { status: 'ok' };
        }
        console.error("Erreur d'envoi :", error);
        return { status: isNetworkError(error) ? 'network' : 'error', error: error };
    }
    if (data && data[0]) {
        finishSending(clientId, data[0]);
    } else {
        failSending(clientId);
    }
    return { status: 'ok' };
}

function alertUploadError(label, error) {
    if (isNetworkError(error)) {
        alert(`Pas de connexion : ${label} n'a pas pu être envoyé. Réessaie quand tu seras en ligne.`);
    } else {
        alert(`${label} non envoyé : ` + ((error && error.message) || 'erreur inconnue'));
    }
}

/* ---------- Messages en attente (envoi au retour de la connexion) ---------- */

function queueText(text) {
    const item = {
        clientId: newClientId(),
        content: text,
        type: 'text',
        created_at: new Date().toISOString()
    };
    const outbox = getOutbox();
    outbox.push(item);
    setOutbox(outbox);
    renderPending(item);
}

async function flushOutbox() {
    if (flushing || !myId || !navigator.onLine || getOutbox().length === 0) return;
    flushing = true;
    let sentSomething = false;

    try {
        while (true) {
            const outbox = getOutbox();
            if (outbox.length === 0) break;
            const item = outbox[0];

            const { data, error } = await supabaseClient
                .from('messages')
                .insert([{
                    content: item.content,
                    type: item.type,
                    sender_id: myId,
                    client_id: item.clientId,
                    created_at: item.created_at
                }])
                .select();

            if (error && !isDuplicateError(error)) {
                if (isNetworkError(error)) break;   // on réessaiera plus tard
                console.error('Message en attente refusé :', error);
                alert("Un message en attente n'a pas pu être envoyé : " + error.message);
                setOutbox(getOutbox().filter(i => i.clientId !== item.clientId));
                removePending(item.clientId);
                continue;
            }

            setOutbox(getOutbox().filter(i => i.clientId !== item.clientId));
            removePending(item.clientId);
            if (data && data[0]) cacheAdd(data[0]);
            sentSomething = true;
        }
    } finally {
        flushing = false;
    }

    // On recharge pour remettre tous les messages dans le bon ordre
    if (sentSomething) loadHistory();
}

/* ---------- Supabase : historique + temps réel ---------- */

async function loadHistory() {
    if (loadingHistory) return;
    loadingHistory = true;
    historyLoaded = false;   // les messages qui arrivent pendant sont mis de côté

    try {
        const { data, error } = await supabaseClient
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(HISTORY_LIMIT);

        if (error) {
            console.error('Erreur de chargement :', error);
            if (!isNetworkError(error)) {
                alert('Impossible de charger les messages : ' + error.message);
            }
            return;   // hors ligne : on garde l'affichage venant de la copie locale
        }

        const messages = data.reverse();
        messageCache = messages.slice(-CACHE_LIMIT);
        saveCache();

        resetChatView();
        messages.forEach(m => renderMessage(m));
        getOutbox().forEach(renderPending);
        sending.forEach(rec => chatMessages.appendChild(rec.el));
    } finally {
        historyLoaded = true;
        loadingHistory = false;
        pendingIncoming.splice(0).forEach(m => renderMessage(m));
        refreshProfileUI();
    }
}

function initChat() {
    realtimeChannel = supabaseClient.channel('chat-prive', {
        config: {
            presence: { key: myId },
            broadcast: { self: false }
        }
    });

    realtimeChannel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
            handleIncoming(payload.new);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, payload => {
            cacheRemove(payload.old.id);
            const el = document.getElementById(`msg-${payload.old.id}`);
            if (el) el.remove();
        })
        // Qui est en ligne ?
        .on('presence', { event: 'sync' }, () => {
            const others = Object.keys(realtimeChannel.presenceState()).filter(k => k !== myId);
            partnerOnline = others.length > 0;
            updateStatus();
        })
        // L'autre est en train d'écrire
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
            if (!payload || payload.id === myId) return;
            partnerTyping = true;
            updateStatus();
            clearTimeout(partnerTypingTimeout);
            partnerTypingTimeout = setTimeout(() => {
                partnerTyping = false;
                updateStatus();
            }, 3000);
        })
        .subscribe(async (status) => {
            console.log('Temps réel :', status);   // doit afficher SUBSCRIBED
            if (status === 'SUBSCRIBED') {
                channelReady = true;
                updateStatus();
                try { await realtimeChannel.track({ id: myId }); } catch (e) { /* ignoré */ }
                await loadHistory();
                loadProfiles();
                flushOutbox();
            } else {
                channelReady = false;
                updateStatus();
            }
        });
}

/* ---------- Profils : photo, nom affiché, statut ---------- */
// Chaque personne est identifiée par l'UUID de son compte.

let profiles = readJSON(PROFILES_KEY, {});   // uuid -> profil
let avatarDraft = { blob: null, previewUrl: null, removed: false };
let savingProfile = false;

const partnerInfoEl = document.getElementById('partnerInfo');
const partnerAvatarEl = document.getElementById('partnerAvatar');
const partnerNameEl = document.getElementById('partnerName');
const meBtn = document.getElementById('meBtn');
const meAvatarEl = document.getElementById('meAvatar');

const profileModal = document.getElementById('profileModal');
const profileClose = document.getElementById('profileClose');
const profileAvatarPreview = document.getElementById('profileAvatarPreview');
const profileAvatarBtn = document.getElementById('profileAvatarBtn');
const profileAvatarInput = document.getElementById('profileAvatarInput');
const profileRemoveBtn = document.getElementById('profileRemoveBtn');
const profileNameInput = document.getElementById('profileNameInput');
const profileBioInput = document.getElementById('profileBioInput');
const profileSaveBtn = document.getElementById('profileSaveBtn');
const profileSignOutBtn = document.getElementById('profileSignOutBtn');

const partnerModal = document.getElementById('partnerModal');
const partnerModalClose = document.getElementById('partnerModalClose');
const partnerModalAvatar = document.getElementById('partnerModalAvatar');
const partnerModalName = document.getElementById('partnerModalName');
const partnerModalBio = document.getElementById('partnerModalBio');

function saveProfiles() {
    writeJSON(PROFILES_KEY, profiles);
}

function escapeXml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Avatar de secours (initiale sur fond coloré) : fonctionne sans Internet
function initialAvatar(name, glyph) {
    const text = String(name || '?').trim();
    const first = glyph || Array.from(text)[0] || '?';
    const label = escapeXml(first.toUpperCase());
    let hue = 0;
    for (const ch of text) hue = (hue * 31 + ch.codePointAt(0)) % 360;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
        `<rect width="128" height="128" fill="hsl(${hue},60%,48%)"/>` +
        `<text x="64" y="64" dy=".35em" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="600" fill="#ffffff">${label}</text>` +
        '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Affiche la photo du profil, ou l'initiale si pas de photo
function setAvatarImg(img, profile, name, glyph) {
    if (!img) return;
    const fallback = initialAvatar(name, glyph);
    img.onerror = () => { img.onerror = null; img.src = fallback; };
    img.src = fallback;

    const path = profile && profile.avatar_url;
    if (path) {
        mediaUrl(path).then(url => { if (url) img.src = url; });
    }
}

// L'autre personne : le seul autre profil connu, sinon le dernier expéditeur
function getPartnerId() {
    const others = Object.keys(profiles).filter(k => k !== myId);
    if (others.length) {
        others.sort((a, b) => String(profiles[b].updated_at || '')
            .localeCompare(String(profiles[a].updated_at || '')));
        return others[0];
    }
    for (let i = messageCache.length - 1; i >= 0; i--) {
        if (messageCache[i].sender_id && messageCache[i].sender_id !== myId) {
            return messageCache[i].sender_id;
        }
    }
    return null;
}

function partnerDisplayName(partnerId) {
    const partner = partnerId ? profiles[partnerId] : null;
    return (partner && partner.display_name) || 'Mon Amour';
}

function refreshProfileUI() {
    const partnerId = getPartnerId();
    const partner = partnerId ? profiles[partnerId] : null;
    const partnerName = partnerDisplayName(partnerId);

    if (partnerNameEl) partnerNameEl.textContent = partnerName;
    setAvatarImg(partnerAvatarEl, partner, partnerName, partner && partner.display_name ? null : '❤️');

    const me = profiles[myId];
    const myName = (me && me.display_name) || (window.chatAuth.email || 'Moi');
    setAvatarImg(meAvatarEl, me, myName);
}

async function loadProfiles() {
    try {
        const { data, error } = await supabaseClient.from('profiles').select('*');
        if (error) {
            console.warn('Profils non chargés :', error.message);
            return;   // hors ligne : on garde la copie locale
        }
        const map = {};
        data.forEach(p => { map[p.id] = p; });
        profiles = map;
        saveProfiles();
        refreshProfileUI();
    } catch (e) {
        console.warn('Profils non chargés :', e);
    }
}

// Canal séparé : si la table "profiles" n'est pas prête, la messagerie continue
function initProfilesChannel() {
    supabaseClient
        .channel('chat-prive-profiles')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, payload => {
            const row = payload.new;
            if (row && row.id) {
                profiles[row.id] = row;
                saveProfiles();
                refreshProfileUI();
            }
        })
        .subscribe();
}

// Photo de profil : carré centré, 256 x 256 pixels, léger
async function makeAvatarBlob(file, size = 256) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.getContext('2d').drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    if (bitmap.close) bitmap.close();

    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Conversion impossible');
    return blob;
}

// Supprime l'ancienne photo du stockage
async function deleteAvatarFile(path) {
    if (!path || !path.startsWith(`${myId}/avatars/`)) return;
    try {
        await supabaseClient.storage.from('media').remove([path]);
    } catch (e) { /* pas grave */ }
}

function clearAvatarPreview() {
    if (avatarDraft.previewUrl) URL.revokeObjectURL(avatarDraft.previewUrl);
}

function updateRemoveBtn() {
    const me = profiles[myId];
    const hasPhoto = avatarDraft.blob || (!avatarDraft.removed && me && me.avatar_url);
    if (profileRemoveBtn) profileRemoveBtn.style.display = hasPhoto ? 'inline-block' : 'none';
}

function openProfileModal() {
    const me = profiles[myId] || {};
    clearAvatarPreview();
    avatarDraft = { blob: null, previewUrl: null, removed: false };

    profileNameInput.value = me.display_name || '';
    profileBioInput.value = me.bio || '';
    setAvatarImg(profileAvatarPreview, me, me.display_name || 'Moi');
    updateRemoveBtn();
    profileModal.classList.add('open');
}

function closeProfileModal() {
    clearAvatarPreview();
    avatarDraft = { blob: null, previewUrl: null, removed: false };
    profileModal.classList.remove('open');
}

function openPartnerModal() {
    const partnerId = getPartnerId();
    const partner = partnerId ? profiles[partnerId] : null;
    const name = partnerDisplayName(partnerId);
    const bio = (partner && partner.bio) || '';

    partnerModalName.textContent = name;
    partnerModalBio.textContent = bio;
    partnerModalBio.style.display = bio ? 'block' : 'none';
    setAvatarImg(partnerModalAvatar, partner, name, partner && partner.display_name ? null : '❤️');
    partnerModal.classList.add('open');
}

function closePartnerModal() {
    partnerModal.classList.remove('open');
}

async function saveMyProfile() {
    if (savingProfile) return;
    if (!navigator.onLine) {
        alert("Pas de connexion : ton profil ne peut être enregistré qu'en ligne.");
        return;
    }

    savingProfile = true;
    profileSaveBtn.disabled = true;
    profileSaveBtn.textContent = 'Enregistrement…';

    try {
        const old = profiles[myId] || {};
        let avatarPath = avatarDraft.removed ? null : (old.avatar_url || null);
        let uploadedNew = false;

        // 1. Nouvelle photo : envoi dans mon dossier personnel
        if (avatarDraft.blob) {
            const path = `${myId}/avatars/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
            const { error } = await supabaseClient.storage
                .from('media')
                .upload(path, avatarDraft.blob, { contentType: 'image/jpeg' });
            if (error) {
                console.error('Erreur upload photo de profil :', error);
                alert(isNetworkError(error)
                    ? "Pas de connexion : la photo n'a pas pu être envoyée."
                    : 'Photo non enregistrée : ' + error.message);
                return;
            }
            avatarPath = path;
            uploadedNew = true;
        }

        // 2. Enregistrement du profil
        const row = {
            id: myId,
            display_name: profileNameInput.value.trim() || null,
            avatar_url: avatarPath,
            bio: profileBioInput.value.trim(),
            updated_at: new Date().toISOString()
        };
        const { data, error } = await supabaseClient
            .from('profiles')
            .upsert([row], { onConflict: 'id' })
            .select();

        if (error) {
            console.error('Erreur profil :', error);
            if (uploadedNew) deleteAvatarFile(avatarPath);
            if (isNetworkError(error)) {
                alert("Pas de connexion : ton profil n'a pas pu être enregistré.");
            } else {
                alert('Profil non enregistré : ' + error.message);
            }
            return;
        }

        profiles[myId] = (data && data[0]) || row;
        saveProfiles();

        // 3. Ménage : l'ancienne photo n'est plus utile
        if (old.avatar_url && old.avatar_url !== avatarPath) deleteAvatarFile(old.avatar_url);

        refreshProfileUI();
        closeProfileModal();
    } finally {
        savingProfile = false;
        profileSaveBtn.disabled = false;
        profileSaveBtn.textContent = 'Enregistrer';
    }
}

if (meBtn && profileModal) {
    meBtn.addEventListener('click', openProfileModal);
    profileClose.addEventListener('click', closeProfileModal);
    profileModal.addEventListener('click', (e) => { if (e.target === profileModal) closeProfileModal(); });

    profileAvatarBtn.addEventListener('click', () => profileAvatarInput.click());
    profileAvatarPreview.addEventListener('click', () => profileAvatarInput.click());

    profileAvatarInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const blob = await makeAvatarBlob(file);
            clearAvatarPreview();
            avatarDraft = { blob: blob, previewUrl: URL.createObjectURL(blob), removed: false };
            profileAvatarPreview.onerror = null;
            profileAvatarPreview.src = avatarDraft.previewUrl;
        } catch (err) {
            console.error('Photo illisible :', err);
            alert("Cette image n'a pas pu être lue. Essaie une photo au format JPG ou PNG.");
        }
        profileAvatarInput.value = '';
        updateRemoveBtn();
    });

    profileRemoveBtn.addEventListener('click', () => {
        clearAvatarPreview();
        avatarDraft = { blob: null, previewUrl: null, removed: true };
        setAvatarImg(profileAvatarPreview, null, profileNameInput.value.trim() || 'Moi');
        updateRemoveBtn();
    });

    profileSaveBtn.addEventListener('click', saveMyProfile);
}

if (profileSignOutBtn) {
    profileSignOutBtn.addEventListener('click', () => window.signOutChat());
}

if (partnerInfoEl && partnerModal) {
    partnerInfoEl.addEventListener('click', openPartnerModal);
    partnerModalClose.addEventListener('click', closePartnerModal);
    partnerModal.addEventListener('click', (e) => { if (e.target === partnerModal) closePartnerModal(); });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (profileModal) closeProfileModal();
        if (partnerModal) closePartnerModal();
    }
});

/* ---------- Envoi de texte ---------- */

if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
        if (!myId) return;

        if (isRecording) {
            stopAndSendRecording();
            return;
        }
        const text = messageInput.value.trim();
        if (!text) return;
        if (text.length > 4000) {
            alert('Message trop long (4000 caractères maximum).');
            return;
        }

        messageInput.value = '';
        if (emojiPicker) emojiPicker.classList.remove('active');
        messageInput.focus();

        // Pas de connexion : le message est mis en attente
        if (!navigator.onLine) {
            queueText(text);
            return;
        }

        // La bulle apparaît tout de suite (avec 🕓), confirmée quand le serveur répond
        const clientId = newClientId();
        addSending(clientId, 'text', { text: text });
        const result = await insertMessage(text, 'text', clientId);

        if (result.status === 'network') {
            failSending(clientId);
            queueText(text);   // la connexion a lâché pendant l'envoi
        } else if (result.status === 'error') {
            failSending(clientId);
            alert('Message non envoyé : ' + result.error.message);
            messageInput.value = text;
        }
    });
}

if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    });

    // Signale à l'autre personne qu'on est en train d'écrire
    messageInput.addEventListener('input', () => {
        const now = Date.now();
        if (channelReady && messageInput.value.trim() && now - lastTypingSent > 2000) {
            lastTypingSent = now;
            realtimeChannel.send({ type: 'broadcast', event: 'typing', payload: { id: myId } });
        }
    });
}

/* ---------- Suppression ---------- */

window.deleteMessageFromDB = async function (id) {
    if (!navigator.onLine) {
        alert('Pas de connexion : suppression impossible pour le moment.');
        return;
    }

    const msg = cacheFind(id);

    const { data, error } = await supabaseClient
        .from('messages')
        .delete()
        .eq('id', id)
        .select();

    if (error && isNetworkError(error)) {
        alert('Pas de connexion : suppression impossible pour le moment.');
        return;
    }
    if (error || !data || data.length === 0) {
        console.error('Erreur de suppression :', error);
        alert('Suppression refusée : ce message ne vous appartient pas.');
        return;
    }

    // Le fichier associé n'a plus lieu d'être : on nettoie le stockage.
    if (msg && (msg.type === 'image' || msg.type === 'audio') && msg.content.startsWith(`${myId}/`)) {
        try {
            await supabaseClient.storage.from('media').remove([msg.content]);
        } catch (e) { /* pas grave */ }
    }

    cacheRemove(id);
    const el = document.getElementById(`msg-${id}`);
    if (el) el.remove();
};

/* ---------- Images (compressées avant envoi) ---------- */

async function compressImage(file, maxSize = 1024, quality = 0.75) {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);

        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();

        const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', quality));
        return (blob && blob.size < file.size) ? blob : file;
    } catch (e) {
        return file;   // en cas de problème on envoie l'original
    }
}

if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', () => {
        if (!navigator.onLine) {
            alert('Pas de connexion : les photos ne peuvent être envoyées qu\'en ligne.');
            return;
        }
        imageInput.click();
    });

    imageInput.addEventListener('change', async (e) => {
        const original = e.target.files[0];
        imageInput.value = '';   // permet de renvoyer la même photo
        if (!original || !myId) return;

        // 1. La photo apparaît tout de suite, avec un aperçu local
        const clientId = newClientId();
        const firstPreview = URL.createObjectURL(original);
        addSending(clientId, 'image', { previewSrc: firstPreview });

        // 2. Réduction (plus légère = envoi plus rapide)
        const file = await compressImage(original);
        const localUrl = URL.createObjectURL(file);
        setSendingPreview(clientId, localUrl);
        URL.revokeObjectURL(firstPreview);

        if (file.size > MAX_UPLOAD_BYTES) {
            failSending(clientId);
            alert('Cette photo dépasse 25 Mo. Choisis une image plus légère.');
            return;
        }

        // 3. Envoi dans mon dossier personnel
        const contentType = file.type || 'image/jpeg';
        const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const path = `${myId}/img_${Date.now()}.${ext}`;

        const { error } = await supabaseClient.storage
            .from('media')
            .upload(path, file, { contentType: contentType });

        if (error) {
            console.error('Erreur upload image :', error);
            failSending(clientId);
            alertUploadError('La photo', error);
            return;
        }

        localMedia.set(path, localUrl);   // pas besoin de retélécharger notre propre photo

        const result = await insertMessage(path, 'image', clientId);
        if (result.status !== 'ok') {
            failSending(clientId);
            alertUploadError('La photo', result.error);
        }
    });
}

/* ---------- Enregistrement vocal ---------- */

if (recordBtn) {
    recordBtn.addEventListener('click', () => {
        if (!myId) return;
        if (!isRecording) {
            if (!navigator.onLine) {
                alert("Pas de connexion : les vocaux ne peuvent être envoyés qu'en ligne.");
                return;
            }
            startRecording();
        } else {
            stopAndSendRecording();
        }
    });
}

if (cancelRecBtn) {
    cancelRecBtn.addEventListener('click', cancelRecording);
}

function recordedSeconds() {
    return recordStartedAt ? (Date.now() - recordStartedAt) / 1000 : 0;
}

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

        let options = {};
        if (MediaRecorder.isTypeSupported('audio/webm')) options = { mimeType: 'audio/webm' };
        else if (MediaRecorder.isTypeSupported('audio/mp4')) options = { mimeType: 'audio/mp4' };

        mediaRecorder = new MediaRecorder(mediaStream, options);
        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.start(100);
        isRecording = true;
        recordStartedAt = Date.now();

        setupAudioVisualizer(mediaStream);

        if (recordBtn) recordBtn.classList.add('recording');
        if (activityBar) activityBar.classList.add('active');
        if (recordingTimer) recordingTimer.textContent = '00:00';

        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const s = Math.floor(recordedSeconds());
            const mins = String(Math.floor(s / 60)).padStart(2, '0');
            const secs = String(s % 60).padStart(2, '0');
            if (recordingTimer) recordingTimer.textContent = `${mins}:${secs}`;
            if (s >= MAX_RECORD_SECONDS) stopAndSendRecording();
        }, 200);

    } catch (err) {
        console.error('Erreur micro :', err);
        alert('Accès au microphone refusé ou non autorisé.');
    }
}

function setupAudioVisualizer(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        microphoneSource = audioContext.createMediaStreamSource(stream);

        microphoneSource.connect(analyser);
        analyser.fftSize = 64;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        function drawVisualizer() {
            if (!isRecording) return;

            animFrameId = requestAnimationFrame(drawVisualizer);
            analyser.getByteFrequencyData(dataArray);

            if (!canvasCtx) return;
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

            const barWidth = 3;
            const gap = 3;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                let barHeight = (dataArray[i] / 255) * canvas.height;
                if (barHeight < 4) barHeight = 4;

                const gradient = canvasCtx.createLinearGradient(0, 0, 0, canvas.height);
                gradient.addColorStop(0, '#3b82f6');
                gradient.addColorStop(1, '#1d4ed8');

                canvasCtx.fillStyle = gradient;
                const y = (canvas.height - barHeight) / 2;
                canvasCtx.beginPath();
                if (canvasCtx.roundRect) canvasCtx.roundRect(x, y, barWidth, barHeight, 4);
                else canvasCtx.rect(x, y, barWidth, barHeight);
                canvasCtx.fill();

                x += barWidth + gap;
                if (x > canvas.width) break;
            }
        }

        drawVisualizer();
    } catch (e) {
        console.error('Erreur visualiseur :', e);
    }
}

function stopAndSendRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    // Vocal trop court : on annule au lieu d'envoyer
    if (recordedSeconds() < 0.6) {
        cancelRecording();
        return;
    }

    const seconds = recordedSeconds();

    mediaRecorder.onstop = async () => {
        const fullMime = mediaRecorder.mimeType || 'audio/webm';
        const mimeType = fullMime.split(';')[0];
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
        const audioBlob = new Blob(audioChunks, { type: mimeType });

        // On libère tout de suite le micro : l'envoi continue en arrière-plan
        cleanupAudio();
        if (audioBlob.size === 0) return;

        if (audioBlob.size > MAX_UPLOAD_BYTES) {
            alert('Ce vocal dépasse 25 Mo.');
            return;
        }

        const clientId = newClientId();
        const localUrl = URL.createObjectURL(audioBlob);
        addSending(clientId, 'audio', { seconds: seconds });

        const path = `${myId}/vocal_${Date.now()}.${ext}`;

        const { error } = await supabaseClient.storage
            .from('media')
            .upload(path, audioBlob, { contentType: mimeType });

        if (error) {
            console.error('Erreur upload vocal :', error);
            failSending(clientId);
            alertUploadError('Le vocal', error);
            return;
        }

        localMedia.set(path, localUrl);

        const result = await insertMessage(path, 'audio', clientId);
        if (result.status !== 'ok') {
            failSending(clientId);
            alertUploadError('Le vocal', result.error);
        }
    };

    mediaRecorder.stop();
}

function cancelRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    mediaRecorder.onstop = () => cleanupAudio();
    mediaRecorder.stop();
}

function cleanupAudio() {
    isRecording = false;
    recordStartedAt = 0;
    if (recordBtn) recordBtn.classList.remove('recording');
    if (activityBar) activityBar.classList.remove('active');
    clearInterval(timerInterval);
    if (audioContext) audioContext.close();
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
}

/* ---------- Emojis et modale image ---------- */

if (emojiToggleBtn && emojiPicker) {
    emojiToggleBtn.addEventListener('click', () => emojiPicker.classList.toggle('active'));
    emojiPicker.addEventListener('click', (e) => {
        if (e.target.tagName === 'SPAN') {
            messageInput.value += e.target.textContent;
            messageInput.focus();
        }
    });
}

const imageModal = document.getElementById('imageModal');
const modalImg = document.getElementById('modalImg');

function openModal(src) {
    if (imageModal && modalImg) {
        modalImg.src = src;
        imageModal.style.display = 'flex';
    }
}

function closeImageModal() {
    if (imageModal) imageModal.style.display = 'none';
}

const closeModal = document.getElementById('closeModal');
if (closeModal) closeModal.addEventListener('click', closeImageModal);
if (imageModal) {
    imageModal.addEventListener('click', (e) => {
        if (e.target === imageModal) closeImageModal();
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImageModal();
});

/* ---------- Démarrage, déclenché par auth.js ---------- */

function actuallyStartChat() {
    myId = window.chatAuth.userId;

    // On affiche tout de suite la copie locale (même sans connexion)
    messageCache.forEach(m => renderMessage(m));
    getOutbox().forEach(renderPending);
    refreshProfileUI();

    initChat();
    initProfilesChannel();
    refreshConnectionUI();

    window.addEventListener('online', () => {
        refreshConnectionUI();
        flushOutbox();
        setTimeout(() => { if (navigator.onLine) loadHistory(); }, 2000);
    });
    window.addEventListener('offline', refreshConnectionUI);

    setInterval(flushOutbox, 15000);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .catch(err => console.error('Service worker :', err));
    }
}

// On démarre dès que auth.js prévient que la connexion est faite — ou tout
// de suite si c'était déjà le cas avant que ce fichier finisse de charger.
let chatStarted = false;
function tryStartChat() {
    if (chatStarted || !window.chatAuth || !window.chatAuth.userId) return;
    chatStarted = true;
    actuallyStartChat();
}
document.addEventListener('chat-auth-ready', tryStartChat);
if (window.chatAuth && window.chatAuth.ready) tryStartChat();