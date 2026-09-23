// =====================================================================
//  MON CHAT PRIVÉ — logique de la messagerie
//  auth.js se charge AVANT ce fichier : il crée window.supabaseClient,
//  gère la connexion (e-mail + mot de passe) et remplit window.chatAuth.
//  Ce fichier ne démarre rien tant que la connexion n'est pas faite.
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
const MEDIA_URL_KEY = 'chatMediaUrls';
const REACTIONS_KEY = 'chatReactions';
const RECEIPTS_KEY = 'chatReceipts';
const PREFS_KEY = 'chatPrefs';
const OLDER_PAGE = 100;              // messages ajoutés à chaque « Voir les messages plus anciens »
const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

// Mon identifiant de compte. Renseigné au démarrage, une fois connecté.
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
const chatBodyEl = document.getElementById('chatBody');
const glowPulseEl = document.getElementById('glowPulse');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const scrollBadge = document.getElementById('scrollBadge');
const typingRow = document.getElementById('typingRow');
const avatarRing = document.getElementById('avatarRing');
const composerEl = document.getElementById('composer');
const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

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
let historyLimit = HISTORY_LIMIT;   // grandit quand on charge des messages plus anciens
let hasMoreHistory = false;
let loadingOlder = false;

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

// Copie locale des derniers messages : sert à afficher l'historique sans connexion
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

// Identifiant unique généré par le navigateur : la base refuse deux fois
// le même, ce qui empêche tout doublon lors d'un réessai.
function newClientId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
    if (avatarRing) avatarRing.dataset.state = cls;

    // Bulle animée "l'autre écrit" sous la conversation
    if (typingRow) {
        const showTyping = cls === 'typing';
        if (typingRow.classList.contains('show') !== showTyping) {
            const stayAtBottom = isNearBottom();
            typingRow.classList.toggle('show', showTyping);
            if (chatBodyEl) chatBodyEl.classList.toggle('has-typing', showTyping);
            if (stayAtBottom) setTimeout(scrollToBottom, 260);
        }
    }
}

function refreshConnectionUI() {
    if (offlineBanner) offlineBanner.classList.toggle('show', !navigator.onLine);
    updateStatus();
}

/* ---------- Fichiers privés : adresses signées ---------- */
// Le stockage "media" est privé : la base ne contient que le chemin du fichier.
// L'adresse est demandée au serveur à l'affichage et reste valable une heure.

let signedUrls = readJSON(MEDIA_URL_KEY, {});   // chemin -> { url, exp }
const localMedia = new Map();                   // chemin -> copie locale (envoi en cours)

function saveSignedUrls() {
    // On ne garde que les 150 plus récentes pour ne pas saturer localStorage
    const entries = Object.entries(signedUrls).sort((a, b) => b[1].exp - a[1].exp).slice(0, 150);
    signedUrls = Object.fromEntries(entries);
    writeJSON(MEDIA_URL_KEY, signedUrls);
}

// Adresse déjà connue et encore valable (sans appel réseau)
function cachedMediaUrl(path) {
    if (!path) return null;
    const local = localMedia.get(path);
    if (local) return local;
    const hit = signedUrls[path];
    return hit && hit.exp > Date.now() ? hit.url : null;
}

async function mediaUrl(path) {
    if (!path) return null;

    const ready = cachedMediaUrl(path);
    if (ready) return ready;

    const hit = signedUrls[path];
    // Hors ligne : on retourne l'adresse périmée, le navigateur en a peut-être une copie
    if (!navigator.onLine) return hit ? hit.url : null;

    try {
        const { data, error } = await supabaseClient.storage
            .from('media')
            .createSignedUrl(path, SIGNED_URL_SECONDS);

        if (error || !data) {
            console.warn('Adresse de fichier indisponible :', error && error.message);
            return hit ? hit.url : null;
        }
        signedUrls[path] = { url: data.signedUrl, exp: Date.now() + (SIGNED_URL_SECONDS - 300) * 1000 };
        saveSignedUrls();
        return data.signedUrl;
    } catch (e) {
        return hit ? hit.url : null;
    }
}

// Remplit le src d'une image ou d'un lecteur audio, sans bloquer l'affichage
function applyMediaSrc(el, path) {
    const ready = cachedMediaUrl(path);
    if (ready) {
        el.src = ready;
        return;
    }
    mediaUrl(path).then(url => { if (url) el.src = url; });
}

/* ---------- Effets et interface : défilement, lumière, cœurs, vocaux, thème ---------- */

let renderInstant = false;   // vrai pendant le chargement de l'historique : pas d'animation d'entrée
let preserveScroll = false;  // vrai quand on charge des messages plus anciens : l'écran ne doit pas bouger
let belowCount = 0;          // nouveaux messages arrivés pendant qu'on lit plus haut

// Défilement intelligent : on ne "saute" en bas que si on y était déjà
function isNearBottom() {
    return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 140;
}

function updateScrollButton() {
    if (!scrollDownBtn) return;
    const show = !isNearBottom();
    scrollDownBtn.classList.toggle('show', show);
    if (scrollBadge) {
        scrollBadge.textContent = belowCount > 99 ? '99+' : String(belowCount);
        scrollBadge.classList.toggle('show', show && belowCount > 0);
    }
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    belowCount = 0;
    updateScrollButton();
}

function noteNewBelow() {
    belowCount++;
    updateScrollButton();
}

chatMessages.addEventListener('scroll', () => {
    if (isNearBottom()) {
        belowCount = 0;
        markReadSoon();
    }
    if (chatMessages.scrollTop < 80 && hasMoreHistory && historyLoaded) loadOlder();
    if (menuMessageId !== null) closeMessageMenu();
    updateScrollButton();
}, { passive: true });

if (scrollDownBtn) {
    scrollDownBtn.addEventListener('click', () => {
        if (chatMessages.scrollTo) chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
        else scrollToBottom();
    });
}

// Un message supprimé s'efface en douceur
function removeMessageEl(el) {
    if (!el) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 230);
}

// Un à trois emojis seuls : affichés en grand, sans bulle
let EMOJI_ONLY_RE = null;
try {
    EMOJI_ONLY_RE = new RegExp('^(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\u200d|\\ufe0f|\\s)+$', 'u');
} catch (e) { /* ancien navigateur : simplement pas de grands emojis */ }

function isOnlyEmoji(text) {
    const t = String(text || '').trim();
    if (!EMOJI_ONLY_RE || !t || t.length > 24 || !EMOJI_ONLY_RE.test(t)) return false;
    const compact = t.replace(/\s/g, '');
    const count = (typeof Intl !== 'undefined' && Intl.Segmenter)
        ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(compact)).length
        : Array.from(compact).length;
    return count <= 3;
}

// Lumière ambiante : un éclat part du côté de celui qui écrit
function pulseGlow(side) {
    if (!glowPulseEl || reduceMotion) return;
    glowPulseEl.dataset.side = side;
    glowPulseEl.classList.remove('go');
    void glowPulseEl.offsetWidth; // relance l'animation
    glowPulseEl.classList.add('go');
}

// Pluie de cœurs quand un message parle d'amour
const LOVE_RE = /[❤♥💕💖💗💘💓💞💝😍🥰😘]/u;
const HEART_GLYPHS = ['❤️', '💖', '💕', '💗', '💘'];

function burstHearts(side) {
    if (!chatBodyEl || reduceMotion) return;
    const layer = document.createElement('div');
    layer.className = 'hearts';
    const rise = chatBodyEl.clientHeight || 500;
    const originX = side === 'left' ? 22 : 78;

    for (let i = 0; i < 14; i++) {
        const heart = document.createElement('span');
        heart.textContent = HEART_GLYPHS[i % HEART_GLYPHS.length];
        heart.style.setProperty('--x', `${originX + (Math.random() * 30 - 15)}%`);
        heart.style.setProperty('--dx', `${Math.round(Math.random() * 90 - 45)}px`);
        heart.style.setProperty('--rise', `${Math.round(rise * (0.55 + Math.random() * 0.4))}px`);
        heart.style.setProperty('--s', `${Math.round(16 + Math.random() * 20)}px`);
        heart.style.setProperty('--d', `${(1.6 + Math.random() * 1.1).toFixed(2)}s`);
        heart.style.setProperty('--delay', `${(Math.random() * 0.5).toFixed(2)}s`);
        layer.appendChild(heart);
    }
    chatBodyEl.appendChild(layer);
    setTimeout(() => layer.remove(), 3500);
}

/* --- Lecteur de vocaux (remplace le lecteur standard) --- */

const VOICE_BARS = 30;
const PLAY_ICON = '<svg class="ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>';
const PAUSE_ICON = '<svg class="ico-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/></svg>';

function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Forme de l'onde : toujours la même pour un même vocal
function voiceBarHeights(seed) {
    let x = hashString(seed) || 1;
    let prev = 0.5;
    const heights = [];
    for (let i = 0; i < VOICE_BARS; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        prev = prev * 0.45 + ((x % 1000) / 1000) * 0.55;
        heights.push(Math.round(24 + prev * 76));
    }
    return heights;
}

// La durée est écrite dans le nom du fichier des nouveaux vocaux (ex : vocal_123_12s.webm)
function durationFromUrl(url) {
    const m = /_(\d{1,4})s\.(?:webm|m4a|mp4|ogg)(?:\?.*)?$/i.exec(url || '');
    return m ? parseInt(m[1], 10) : 0;
}

function buildVoicePlayer(src) {
    const wrap = document.createElement('div');
    wrap.className = 'voice';

    const knownSeconds = durationFromUrl(src);
    const audio = document.createElement('audio');
    audio.preload = knownSeconds ? 'none' : 'metadata'; // ne télécharge rien avant l'écoute si on connaît la durée
    applyMediaSrc(audio, src);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'voice-play';
    playBtn.setAttribute('aria-label', 'Écouter le vocal');
    playBtn.innerHTML = PLAY_ICON + PAUSE_ICON;

    const body = document.createElement('div');
    body.className = 'voice-body';

    const wave = document.createElement('div');
    wave.className = 'voice-wave';
    const bars = voiceBarHeights(src).map(h => {
        const bar = document.createElement('i');
        bar.style.setProperty('--h', `${h}%`);
        wave.appendChild(bar);
        return bar;
    });

    const meta = document.createElement('div');
    meta.className = 'voice-meta';
    const timeEl = document.createElement('span');
    const speedBtn = document.createElement('button');
    speedBtn.type = 'button';
    speedBtn.className = 'voice-speed';
    speedBtn.textContent = '1×';
    speedBtn.setAttribute('aria-label', "Vitesse de lecture");
    meta.appendChild(timeEl);
    meta.appendChild(speedBtn);

    body.appendChild(wave);
    body.appendChild(meta);
    wrap.appendChild(playBtn);
    wrap.appendChild(body);
    wrap.appendChild(audio);

    let duration = knownSeconds || 0;

    function totalSeconds() {
        return duration || (isFinite(audio.duration) ? audio.duration : 0);
    }

    function render() {
        const total = totalSeconds();
        const current = audio.currentTime || 0;
        const on = total ? Math.round(Math.min(1, current / total) * VOICE_BARS) : 0;
        bars.forEach((bar, i) => bar.classList.toggle('on', i < on));
        const started = current > 0.05;
        timeEl.textContent = started ? formatDuration(current) : (total ? formatDuration(total) : '0:00');
    }
    render();

    audio.addEventListener('loadedmetadata', () => {
        if (isFinite(audio.duration) && audio.duration > 0) {
            if (!duration) duration = audio.duration;
            render();
        } else if (!duration && audio.duration === Infinity) {
            // Particularité des enregistrements du navigateur : la durée se révèle en allant à la fin
            const fix = () => {
                audio.removeEventListener('timeupdate', fix);
                if (isFinite(audio.duration)) duration = audio.duration;
                audio.currentTime = 0;
                render();
            };
            audio.addEventListener('timeupdate', fix);
            try { audio.currentTime = 1e101; } catch (e) { /* ignoré */ }
        }
    });
    audio.addEventListener('timeupdate', render);
    audio.addEventListener('play', () => {
        wrap.classList.add('playing');
        document.querySelectorAll('audio').forEach(a => { if (a !== audio) a.pause(); }); // un seul vocal à la fois
    });
    audio.addEventListener('pause', () => wrap.classList.remove('playing'));
    audio.addEventListener('ended', () => {
        wrap.classList.remove('playing');
        audio.currentTime = 0;
        render();
    });
    audio.addEventListener('error', () => {
        wrap.classList.add('broken');
        timeEl.textContent = 'Indisponible';
    });

    playBtn.addEventListener('click', () => {
        if (audio.paused) {
            const started = audio.play();
            if (started && started.catch) {
                started.catch(() => { wrap.classList.add('fallback'); audio.controls = true; });
            }
        } else {
            audio.pause();
        }
    });

    // Toucher l'onde permet d'aller à un endroit précis
    wave.addEventListener('click', (e) => {
        const total = totalSeconds();
        if (!total) return;
        const rect = wave.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / (rect.width || 1)));
        audio.currentTime = ratio * total;
        render();
    });

    const speeds = [1, 1.5, 2];
    let speedIndex = 0;
    speedBtn.addEventListener('click', () => {
        speedIndex = (speedIndex + 1) % speeds.length;
        audio.playbackRate = speeds[speedIndex];
        speedBtn.textContent = `${speeds[speedIndex]}×`;
    });

    return wrap;
}

/* --- Barre de saisie : micro quand le champ est vide, "envoyer" quand il y a du texte --- */

function updateComposerState() {
    if (composerEl && messageInput) {
        composerEl.classList.toggle('has-text', messageInput.value.trim().length > 0);
    }
}

/* --- Thème : sombre / clair et couleur (propres à cet appareil) --- */

const THEME_KEY = 'chatTheme';
const THEME_ACCENTS = ['rose', 'ocean', 'violet', 'emerald', 'sunset'];
const THEME_BAR_COLOR = { dark: '#110c24', light: '#f5f0fa' };

function readTheme() {
    const t = readJSON(THEME_KEY, {});
    return {
        mode: t.mode === 'light' ? 'light' : 'dark',
        accent: THEME_ACCENTS.indexOf(t.accent) >= 0 ? t.accent : 'rose'
    };
}

function applyTheme(theme, save) {
    document.documentElement.dataset.mode = theme.mode;
    document.documentElement.dataset.accent = theme.accent;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_BAR_COLOR[theme.mode]);

    document.querySelectorAll('#modeToggle button').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === theme.mode);
    });
    document.querySelectorAll('#accentPicker button').forEach(b => {
        const active = b.dataset.accent === theme.accent;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (save) writeJSON(THEME_KEY, theme);
}

document.querySelectorAll('#modeToggle button').forEach(btn => {
    btn.addEventListener('click', () => {
        const theme = readTheme();
        theme.mode = btn.dataset.mode === 'light' ? 'light' : 'dark';
        applyTheme(theme, true);
    });
});
document.querySelectorAll('#accentPicker button').forEach(btn => {
    btn.addEventListener('click', () => {
        const theme = readTheme();
        theme.accent = btn.dataset.accent;
        applyTheme(theme, true);
    });
});
applyTheme(readTheme(), false);

/* ---------- Réponses, réactions, « vu », gestes ---------- */

let replyTarget = null;              // message auquel on est en train de répondre
const messageIndex = new Map();      // id -> message (pour retrouver les citations et le menu)
const quoteCache = new Map();        // id -> message cité, lu au serveur (null = supprimé)
let reactionsData = readJSON(REACTIONS_KEY, {});   // messageId -> { userId: emoji }
let receipts = readJSON(RECEIPTS_KEY, {});         // userId -> dernier message lu
let prefs = readJSON(PREFS_KEY, { readReceipts: true });

const replyBar = document.getElementById('replyBar');
const replyBarWho = document.getElementById('replyBarWho');
const replyBarText = document.getElementById('replyBarText');
const replyBarCancel = document.getElementById('replyBarCancel');

const msgMenu = document.getElementById('msgMenu');
const msgMenuBackdrop = document.getElementById('msgMenuBackdrop');
const msgMenuBox = document.getElementById('msgMenuBox');
const msgMenuReactions = document.getElementById('msgMenuReactions');
const readReceiptsToggle = document.getElementById('readReceiptsToggle');

function messageById(id) {
    return messageIndex.get(id) || cacheFind(id);
}

function showToast(text) {
    let t = document.getElementById('toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast';
        document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => t.classList.remove('show'), 1600);
}

/* --- Citations (répondre à un message précis) --- */

function messagePreview(m) {
    if (!m) return 'Message supprimé';
    if (m.type === 'image') return '📷 Photo';
    if (m.type === 'audio') return '🎤 Message vocal';
    return String(m.content || '').replace(/\s+/g, ' ').slice(0, 120);
}

function senderLabel(senderId) {
    return senderId === myId ? 'Toi' : partnerDisplayName(senderId);
}

async function resolveQuote(id) {
    const known = messageById(id);
    if (known) return known;
    if (quoteCache.has(id)) return quoteCache.get(id);
    try {
        const { data, error } = await supabaseClient
            .from('messages')
            .select('id, sender_id, type, content')
            .eq('id', id)
            .maybeSingle();
        if (error) return undefined;      // hors ligne : on réessaiera
        quoteCache.set(id, data || null);
        return data || null;
    } catch (e) {
        return undefined;
    }
}

function buildQuote(replyToId) {
    const box = document.createElement('div');
    box.className = 'reply-quote';
    box.dataset.replyTo = String(replyToId);
    const who = document.createElement('strong');
    const txt = document.createElement('span');
    box.appendChild(who);
    box.appendChild(txt);

    const fill = (m) => {
        if (m === undefined) {
            who.textContent = '';
            txt.textContent = 'Message';
            return;
        }
        who.textContent = m ? senderLabel(m.sender_id) : '';
        txt.textContent = messagePreview(m);
        box.classList.toggle('gone', !m);
    };

    const known = messageById(replyToId) || (quoteCache.has(replyToId) ? quoteCache.get(replyToId) : undefined);
    if (known !== undefined) fill(known);
    else {
        fill(undefined);
        resolveQuote(replyToId).then(fill);
    }
    return box;
}

function setReplyTarget(m) {
    if (!m) return;
    replyTarget = { id: m.id, sender_id: m.sender_id, type: m.type, content: m.content };
    replyBarWho.textContent = `Réponse à ${senderLabel(m.sender_id)}`;
    replyBarText.textContent = messagePreview(m);
    replyBar.classList.add('show');
    messageInput.focus();
}

function clearReplyTarget() {
    replyTarget = null;
    if (replyBar) replyBar.classList.remove('show');
}

// Récupère l'identifiant du message cité et ferme la barre (à appeler au moment d'envoyer)
function takeReplyTarget() {
    const id = replyTarget ? replyTarget.id : null;
    clearReplyTarget();
    return id;
}

if (replyBarCancel) replyBarCancel.addEventListener('click', clearReplyTarget);

// Retrouver et mettre en évidence le message d'origine
async function jumpToMessage(id, retried) {
    let el = document.getElementById(`msg-${id}`);
    if (!el && !retried && hasMoreHistory) {
        historyLimit += OLDER_PAGE * 3;
        await loadHistory({ keepScroll: true });
        return jumpToMessage(id, true);
    }
    if (!el) {
        showToast("Ce message n'est plus disponible");
        return;
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
}

/* --- Réactions --- */

function reactionsFor(messageId) {
    return reactionsData[messageId] || {};
}

function saveReactions() {
    // On ne garde que les plus récentes pour ne pas saturer le stockage local
    const ids = Object.keys(reactionsData).map(Number).sort((a, b) => b - a).slice(0, 600);
    const kept = {};
    ids.forEach(id => { kept[id] = reactionsData[id]; });
    reactionsData = kept;
    writeJSON(REACTIONS_KEY, reactionsData);
}

function applyReactions(messageId) {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;

    let box = Array.from(el.children).find(c => c.classList.contains('reactions')) || null;
    const entries = Object.entries(reactionsFor(messageId));

    if (!entries.length) {
        if (box) box.remove();
        el.classList.remove('has-reactions');
        return;
    }
    if (!box) {
        box = document.createElement('div');
        box.className = 'reactions';
        el.appendChild(box);
    }
    box.innerHTML = '';

    const groups = {};
    entries.forEach(([uid, emoji]) => { (groups[emoji] = groups[emoji] || []).push(uid); });
    Object.keys(groups).forEach(emoji => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'reaction-chip' + (groups[emoji].includes(myId) ? ' mine' : '');
        chip.dataset.emoji = emoji;
        chip.dataset.messageId = String(messageId);
        chip.textContent = emoji;
        if (groups[emoji].length > 1) {
            const n = document.createElement('span');
            n.textContent = String(groups[emoji].length);
            chip.appendChild(n);
        }
        box.appendChild(chip);
    });
    el.classList.add('has-reactions');
}

function setReactionLocal(messageId, userId, emoji) {
    const current = reactionsData[messageId] || (reactionsData[messageId] = {});
    if (emoji) current[userId] = emoji;
    else delete current[userId];
    if (!Object.keys(current).length) delete reactionsData[messageId];
    saveReactions();
    applyReactions(messageId);
}

async function toggleReaction(messageId, emoji) {
    if (!myId) return;
    if (!navigator.onLine) {
        alert('Pas de connexion : impossible de réagir pour le moment.');
        return;
    }
    const before = reactionsFor(messageId)[myId] || null;
    const next = before === emoji ? null : emoji;
    setReactionLocal(messageId, myId, next);   // affichage immédiat

    let error;
    if (next) {
        ({ error } = await supabaseClient
            .from('message_reactions')
            .upsert([{ message_id: messageId, user_id: myId, emoji: next }], { onConflict: 'message_id,user_id' }));
    } else {
        ({ error } = await supabaseClient
            .from('message_reactions')
            .delete()
            .eq('message_id', messageId)
            .eq('user_id', myId));
    }
    if (error) {
        setReactionLocal(messageId, myId, before);   // on annule l'affichage
        console.error('Réaction refusée :', error);
        alert(/message_reactions/i.test(error.message || '') || error.code === 'PGRST205'
            ? "La table des réactions est introuvable dans Supabase : lance d'abord le script SQL des nouveautés."
            : 'Réaction non enregistrée : ' + error.message);
    }
}

async function loadReactions() {
    if (!myId || !messageIndex.size) return;
    const minId = Math.min(...messageIndex.keys());
    try {
        const { data, error } = await supabaseClient
            .from('message_reactions')
            .select('message_id, user_id, emoji')
            .gte('message_id', minId);
        if (error) {
            console.warn('Réactions non chargées :', error.message);
            return;
        }
        const fresh = {};
        data.forEach(r => { (fresh[r.message_id] = fresh[r.message_id] || {})[r.user_id] = r.emoji; });
        reactionsData = fresh;
        saveReactions();
        chatMessages.querySelectorAll('.message[data-id]').forEach(el => applyReactions(Number(el.dataset.id)));
    } catch (e) {
        console.warn('Réactions non chargées :', e);
    }
}

// Un message supprimé disparaît aussi de la mémoire locale
function forgetMessage(id) {
    cacheRemove(id);
    messageIndex.delete(id);
    delete reactionsData[id];
    saveReactions();
}

/* --- « Vu » --- */

function saveReceipts() {
    writeJSON(RECEIPTS_KEY, receipts);
}

function partnerReadId() {
    let max = 0;
    Object.keys(receipts).forEach(uid => {
        if (uid !== myId && receipts[uid] > max) max = receipts[uid];
    });
    return max;
}

function isSeen(messageId) {
    if (prefs.readReceipts === false) return false;
    const read = partnerReadId();
    return !!read && messageId <= read;
}

function updateTicks() {
    chatMessages.querySelectorAll('.message.sent[data-id]').forEach(el => {
        const tick = el.querySelector('.ticks');
        if (!tick) return;
        const seen = isSeen(Number(el.dataset.id));
        tick.textContent = seen ? '✓✓' : '✓';
        tick.classList.toggle('seen', seen);
    });
}

async function loadReceipts() {
    if (!myId) return;
    try {
        const { data, error } = await supabaseClient.from('read_receipts').select('user_id, last_read_id');
        if (error) {
            console.warn('Accusés de lecture non chargés :', error.message);
            return;
        }
        const map = {};
        data.forEach(r => { map[r.user_id] = r.last_read_id; });
        receipts = map;
        saveReceipts();
        updateTicks();
    } catch (e) {
        console.warn('Accusés de lecture non chargés :', e);
    }
}

let markTimer = null;
function markReadSoon() {
    clearTimeout(markTimer);
    markTimer = setTimeout(markRead, 700);
}

// J'ai vu la conversation : on prévient l'autre (seulement si l'application est visible et qu'on est en bas)
async function markRead() {
    if (!myId || prefs.readReceipts === false || document.hidden || !navigator.onLine || !historyLoaded) return;
    if (!isNearBottom()) return;

    let latest = 0;
    messageIndex.forEach((m, id) => {
        if (m.sender_id !== myId && id > latest) latest = id;
    });
    const previous = receipts[myId] || 0;
    if (!latest || latest <= previous) return;

    receipts[myId] = latest;
    saveReceipts();
    const { error } = await supabaseClient
        .from('read_receipts')
        .upsert([{ user_id: myId, last_read_id: latest, updated_at: new Date().toISOString() }], { onConflict: 'user_id' });
    if (error) {
        receipts[myId] = previous;   // on réessaiera plus tard
        saveReceipts();
        console.warn('Accusé de lecture non envoyé :', error.message);
    }
}

if (readReceiptsToggle) {
    readReceiptsToggle.checked = prefs.readReceipts !== false;
    readReceiptsToggle.addEventListener('change', () => {
        prefs.readReceipts = readReceiptsToggle.checked;
        writeJSON(PREFS_KEY, prefs);
        updateTicks();
        if (prefs.readReceipts) markReadSoon();
    });
}

/* --- Temps réel : réactions et « vu » (canal séparé : la messagerie ne dépend pas de lui) --- */

function initExtrasChannel() {
    supabaseClient
        .channel('chat-prive-extras')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, payload => {
            if (payload.eventType === 'DELETE') {
                const r = payload.old;
                if (r && r.message_id) setReactionLocal(r.message_id, r.user_id, null);
            } else {
                const r = payload.new;
                if (r && r.message_id) setReactionLocal(r.message_id, r.user_id, r.emoji);
            }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'read_receipts' }, payload => {
            const r = payload.new;
            if (r && r.user_id) {
                receipts[r.user_id] = r.last_read_id;
                saveReceipts();
                updateTicks();
            }
        })
        .subscribe();
}

/* --- Messages plus anciens --- */

function buildOlderPill() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'older-pill';
    b.textContent = 'Voir les messages plus anciens';
    b.addEventListener('click', loadOlder);
    return b;
}

async function loadOlder() {
    if (loadingOlder || loadingHistory || !hasMoreHistory) return;
    loadingOlder = true;

    const pill = chatMessages.querySelector('.older-pill');
    if (pill) pill.textContent = 'Chargement…';

    // Repère : le premier message visible, pour que l'écran ne saute pas
    const top = chatMessages.getBoundingClientRect().top;
    const anchor = Array.from(chatMessages.querySelectorAll('.message[data-id]'))
        .find(el => el.getBoundingClientRect().bottom > top + 4);
    const anchorId = anchor ? anchor.id : null;
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;

    historyLimit += OLDER_PAGE;
    try {
        await loadHistory({ keepScroll: true });
    } finally {
        if (anchorId) {
            const el = document.getElementById(anchorId);
            if (el) chatMessages.scrollTop += el.getBoundingClientRect().top - anchorTop;
        }
        loadingOlder = false;
    }
}

/* --- Menu du message (appui long ou clic droit) --- */

let menuMessageId = null;

function openMessageMenu(el) {
    const id = Number(el.dataset.id);
    const m = messageById(id);
    if (!m || !msgMenu) return;
    menuMessageId = id;

    msgMenuReactions.innerHTML = '';
    const mine = reactionsFor(id)[myId];
    QUICK_REACTIONS.forEach(emoji => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-emoji' + (mine === emoji ? ' on' : '');
        b.dataset.emoji = emoji;
        b.textContent = emoji;
        msgMenuReactions.appendChild(b);
    });

    const copyBtn = msgMenuBox.querySelector('[data-act="copy"]');
    const deleteBtn = msgMenuBox.querySelector('[data-act="delete"]');
    if (copyBtn) copyBtn.style.display = m.type === 'text' ? '' : 'none';
    if (deleteBtn) deleteBtn.style.display = m.sender_id === myId ? '' : 'none';

    el.classList.add('menu-open');
    msgMenu.classList.add('open');

    // Position : sous le message, ou au-dessus s'il n'y a pas la place
    const rect = el.getBoundingClientRect();
    const w = msgMenuBox.offsetWidth;
    const h = msgMenuBox.offsetHeight;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 8);
    let left = m.sender_id === myId ? rect.right - w : rect.left;
    left = Math.min(Math.max(12, left), Math.max(12, window.innerWidth - w - 12));
    msgMenuBox.style.top = `${Math.round(top)}px`;
    msgMenuBox.style.left = `${Math.round(left)}px`;

    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* ignoré */ } }
}

function closeMessageMenu() {
    if (msgMenu) msgMenu.classList.remove('open');
    chatMessages.querySelectorAll('.message.menu-open').forEach(x => x.classList.remove('menu-open'));
    menuMessageId = null;
}

function copyText(text) {
    const done = () => showToast('Message copié');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
        fallbackCopy(text, done);
    }
}

function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { showToast('Copie impossible'); }
    ta.remove();
}

if (msgMenu) {
    msgMenuBackdrop.addEventListener('click', closeMessageMenu);
    msgMenu.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMessageMenu(); });
    msgMenuBox.addEventListener('click', (e) => {
        const emojiBtn = e.target.closest('.menu-emoji');
        const actBtn = e.target.closest('[data-act]');
        const id = menuMessageId;
        if (emojiBtn && id !== null) {
            closeMessageMenu();
            toggleReaction(id, emojiBtn.dataset.emoji);
        } else if (actBtn && id !== null) {
            const m = messageById(id);
            const act = actBtn.dataset.act;
            closeMessageMenu();
            if (!m) return;
            if (act === 'reply') setReplyTarget(m);
            else if (act === 'copy') copyText(String(m.content || ''));
            else if (act === 'delete' && confirm('Supprimer ce message ?')) window.deleteMessageFromDB(id);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && msgMenu.classList.contains('open')) closeMessageMenu();
    });
}

/* --- Gestes : appui long = menu, glisser vers la droite = répondre, double toucher = ❤️ --- */

const LONG_PRESS_MS = 450;
const SWIPE_TRIGGER = 64;
let gesture = null;
let lastTap = { id: 0, time: 0 };

function gestureTarget(e) {
    if (!e.target || !e.target.closest) return null;
    // Les boutons du message (lecture d'un vocal, citation, réaction…) gardent leur rôle
    if (e.target.closest('.voice-play, .voice-speed, .voice-wave, .reply-quote, .reaction-chip, .older-pill')) return null;
    const el = e.target.closest('.message[data-id]');
    return el && chatMessages.contains(el) ? el : null;
}

function heartPop(el, e) {
    const pop = document.createElement('span');
    pop.className = 'heart-pop';
    pop.textContent = '❤️';
    const rect = el.getBoundingClientRect();
    pop.style.left = `${Math.round((e && e.clientX ? e.clientX : rect.left + rect.width / 2) - rect.left)}px`;
    pop.style.top = `${Math.round((e && e.clientY ? e.clientY : rect.top + rect.height / 2) - rect.top)}px`;
    el.appendChild(pop);
    setTimeout(() => pop.remove(), 900);
}

chatMessages.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    const el = gestureTarget(e);
    if (!el) return;
    gesture = { el: el, id: Number(el.dataset.id), x: e.clientX, y: e.clientY, dx: 0,
        swiping: false, moved: false, longPressed: false, pid: e.pointerId, timer: null };
    gesture.timer = setTimeout(() => {
        if (gesture && !gesture.moved && !gesture.swiping) {
            gesture.longPressed = true;
            openMessageMenu(gesture.el);
        }
    }, LONG_PRESS_MS);
});

chatMessages.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.pid) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!gesture.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        gesture.moved = true;
        clearTimeout(gesture.timer);
    }
    if (!gesture.swiping && dx > 14 && dx > Math.abs(dy) * 1.5) {
        gesture.swiping = true;
        gesture.el.classList.add('swiping');
        try { gesture.el.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
    }
    if (gesture.swiping) {
        gesture.dx = Math.max(0, dx);
        gesture.el.style.transform = `translateX(${Math.min(gesture.dx * 0.5, 44)}px)`;
        gesture.el.classList.toggle('swipe-ready', gesture.dx >= SWIPE_TRIGGER);
    }
});

function endGesture(e, cancelled) {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    clearTimeout(g.timer);

    if (g.swiping) {
        g.el.classList.remove('swiping', 'swipe-ready');
        g.el.style.transform = '';
        if (!cancelled && g.dx >= SWIPE_TRIGGER) setReplyTarget(messageById(g.id));
        return;
    }
    if (cancelled || g.moved || g.longPressed) return;

    // Simple toucher, puis deuxième toucher rapide = ❤️
    const now = Date.now();
    if (lastTap.id === g.id && now - lastTap.time < 320) {
        lastTap = { id: 0, time: 0 };
        heartPop(g.el, e);
        if (reactionsFor(g.id)[myId] !== '❤️') toggleReaction(g.id, '❤️');
    } else {
        lastTap = { id: g.id, time: now };
    }
}

chatMessages.addEventListener('pointerup', (e) => endGesture(e, false));
chatMessages.addEventListener('pointercancel', (e) => endGesture(e, true));

// Clic droit (ordinateur) ou appui long natif : notre menu à la place de celui du navigateur
chatMessages.addEventListener('contextmenu', (e) => {
    const el = gestureTarget(e);
    if (!el) return;
    e.preventDefault();
    if (gesture) { clearTimeout(gesture.timer); gesture = null; }
    openMessageMenu(el);
});

// Toucher une citation ou une réaction
chatMessages.addEventListener('click', (e) => {
    const quote = e.target.closest && e.target.closest('.reply-quote');
    if (quote && quote.dataset.replyTo) {
        jumpToMessage(Number(quote.dataset.replyTo));
        return;
    }
    const chip = e.target.closest && e.target.closest('.reaction-chip');
    if (chip) toggleReaction(Number(chip.dataset.messageId), chip.dataset.emoji);
});

/* ---------- Affichage des messages ---------- */

function resetChatView() {
    chatMessages.innerHTML = '';
    lastDateKey = null;
    lastRenderedTime = 0;
}

// Séparateur de date quand on change de jour
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
    const wasNear = isNearBottom();

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
    div.dataset.id = String(msg.id);
    messageIndex.set(msg.id, msg);
    div.className = `message ${isMine ? 'sent' : 'received'}${(renderInstant || replacing) ? ' instant' : ''}`;
    if (msg.type === 'image') div.classList.add('media');
    if (msg.type === 'text' && isOnlyEmoji(msg.content)) div.classList.add('big-emoji');

    // Réponse à un message précis : on affiche la citation en haut de la bulle
    if (msg.reply_to) div.appendChild(buildQuote(msg.reply_to));

    if (msg.type === 'image') {
        const img = document.createElement('img');
        img.className = 'message-img loading';
        img.alt = 'Photo';
        const stick = !preserveScroll && (wasNear || renderInstant || isMine);
        img.addEventListener('load', () => {
            img.classList.remove('loading');
            if (stick) scrollToBottom(); // la photo grandit : on reste en bas
        });
        img.addEventListener('error', () => img.classList.remove('loading'));
        img.addEventListener('click', () => openModal(img.src));
        applyMediaSrc(img, msg.content);
        div.appendChild(img);
    } else if (msg.type === 'audio') {
        div.appendChild(buildVoicePlayer(msg.content));
    } else if (msg.type === 'call') {
        const p = document.createElement('p');
        p.className = 'call-log';
        let label = 'Appel';
        try {
            const info = JSON.parse(msg.content || '{}');
            if (info.status === 'missed') label = isMine ? 'Sans réponse' : 'Appel manqué';
            else if (info.status === 'declined') label = 'Appel refusé';
            else label = 'Appel · ' + formatDuration(info.duration || 0);
        } catch (e) { /* ignoré */ }
        p.textContent = '📞 ' + label;
        div.appendChild(p);
    } else {
        const p = document.createElement('p');
        p.textContent = msg.content;
        div.appendChild(p);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(msg.created_at);
    if (isMine) {   // ✓ envoyé, ✓✓ vu par l'autre
        time.appendChild(document.createTextNode(' '));
        const tick = document.createElement('span');
        tick.className = 'ticks';
        const seen = isSeen(msg.id);
        tick.textContent = seen ? '✓✓' : '✓';
        if (seen) tick.classList.add('seen');
        time.appendChild(tick);
    }
    div.appendChild(time);

    if (replacing) {
        target.replaceWith(div);
    } else {
        chatMessages.appendChild(div);
        if (preserveScroll) { /* chargement de messages anciens : on ne touche pas au défilement */ }
        else if (isMine || wasNear || renderInstant) scrollToBottom();
        else noteNewBelow(); // on lit plus haut : on ne bouge pas, on signale le nouveau message
    }

    applyReactions(msg.id);
    lastRenderedTime = Math.max(lastRenderedTime, created.getTime());
}

// Message écrit hors ligne : affiché avec une horloge 🕓 en attendant l'envoi
function renderPending(item) {
    if (document.getElementById(`pending-${item.clientId}`)) return;

    ensureDateSeparator(new Date(item.created_at));

    const div = document.createElement('div');
    div.id = `pending-${item.clientId}`;
    div.className = `message sent pending${renderInstant ? ' instant' : ''}`;

    if (item.replyTo) div.appendChild(buildQuote(item.replyTo));

    const p = document.createElement('p');
    p.textContent = item.content;
    div.appendChild(p);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${formatTime(item.created_at)} 🕓`;
    div.appendChild(time);

    chatMessages.appendChild(div);
    if (!preserveScroll) scrollToBottom();
}

function removePending(clientId) {
    const el = document.getElementById(`pending-${clientId}`);
    if (el) el.remove();
}

/* ---------- Envoi instantané : la bulle apparaît tout de suite ---------- */

const sending = new Map();   // clientId -> { el, type }

function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function addSending(clientId, type, opts) {
    const now = new Date();
    ensureDateSeparator(now);

    const div = document.createElement('div');
    div.className = 'message sent pending sending';
    if (opts.replyTo) div.appendChild(buildQuote(opts.replyTo));

    if (type === 'image') {
        div.classList.add('media');
        const img = document.createElement('img');
        img.className = 'message-img loading';
        img.alt = 'Photo en cours d\'envoi';
        img.addEventListener('load', () => { img.classList.remove('loading'); scrollToBottom(); });
        img.addEventListener('error', () => img.classList.remove('loading'));
        img.src = opts.previewSrc;
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
    scrollToBottom();
    pulseGlow('right');

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

    if (document.getElementById(`msg-${saved.id}`)) {   // déjà affiché grâce au temps réel
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
        pulseGlow('left');
        if (msg.type === 'text' && LOVE_RE.test(msg.content)) burstHearts('left');
        if (document.hidden) {
            unreadCount++;
            document.title = `(${unreadCount}) ${BASE_TITLE}`;
        }
    }
    markReadSoon();
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && myId) {
        unreadCount = 0;
        document.title = BASE_TITLE;
        flushOutbox();
        loadProfiles();
        markReadSoon();
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
        notifyPartner(data[0]);
    } else {
        failSending(clientId);
    }
    return { status: 'ok' };
}
// Prévient l'autre personne (notification push) après l'envoi d'un message.
// Appel direct à la fonction Edge, sans passer par un Database Webhook.
function notifyPartner(savedMessage) {
    if (!savedMessage) return;
    supabaseClient.functions.invoke('notify-message', {
        body: { type: 'INSERT', table: 'messages', record: savedMessage }
    }).catch(err => console.warn('Notification non envoyée :', err));
}

function alertUploadError(label, error) {
    if (isNetworkError(error)) {
        alert(`Pas de connexion : ${label} n'a pas pu être envoyé. Réessaie quand tu seras en ligne.`);
    } else {
        alert(`${label} non envoyé : ` + ((error && error.message) || 'erreur inconnue'));
    }
}

/* ---------- Messages en attente (envoi au retour de la connexion) ---------- */

// On réutilise le même client_id lors d'un réessai : si le premier envoi
// était en fait passé, la base refuse le doublon et rien n'apparaît deux fois.
function queueText(text, clientId, replyTo) {
    const item = {
        clientId: clientId || newClientId(),
        content: text,
        type: 'text',
        created_at: new Date().toISOString(),
        replyTo: replyTo || null
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
            if (data && data[0]) { cacheAdd(data[0]); notifyPartner(data[0]); }
            sentSomething = true;
        }
    } finally {
        flushing = false;
    }

    // On recharge pour remettre tous les messages dans le bon ordre
    if (sentSomething) loadHistory();
}

/* ---------- Supabase : historique + temps réel ---------- */

async function loadHistory(opts) {
    opts = opts || {};
    if (loadingHistory) return;
    loadingHistory = true;
    historyLoaded = false; // les messages qui arrivent pendant le chargement sont mis de côté

    try {
        const { data, error } = await supabaseClient
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(historyLimit);

        if (error) {
            console.error("Erreur de chargement :", error);
            if (!isNetworkError(error)) {
                alert("Impossible de charger les messages : " + error.message);
            }
            return; // hors ligne : on garde l'affichage venant de la copie locale
        }

        hasMoreHistory = data.length >= historyLimit;
        const messages = data.reverse();
        messageCache = messages.slice(-CACHE_LIMIT);
        saveCache();

        resetChatView();
        if (hasMoreHistory) chatMessages.appendChild(buildOlderPill());
        renderInstant = true;
        preserveScroll = !!opts.keepScroll;
        try {
            messages.forEach(m => renderMessage(m));
            getOutbox().forEach(renderPending);
        } finally {
            renderInstant = false;
            preserveScroll = false;
        }
        sending.forEach(rec => chatMessages.appendChild(rec.el));
        if (!opts.keepScroll) scrollToBottom();
    } finally {
        historyLoaded = true;
        loadingHistory = false;
        pendingIncoming.splice(0).forEach(m => renderMessage(m));
        refreshProfileUI();
        loadReactions();
        markReadSoon();
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
            forgetMessage(payload.old.id);
            removeMessageEl(document.getElementById(`msg-${payload.old.id}`));
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
            console.log('Temps réel :', status); // doit afficher SUBSCRIBED
            if (status === 'SUBSCRIBED') {
                channelReady = true;
                updateStatus();
                try { await realtimeChannel.track({ id: myId }); } catch (e) { /* ignoré */ }
                await loadHistory();
                loadProfiles();
                loadReceipts();
                flushOutbox();
            } else {
                channelReady = false;
                updateStatus();
            }
        });
}

/* ---------- Profils : photo, nom affiché, statut ---------- */
// Chaque personne est identifiée par l'UUID de son compte.
// La photo est un fichier privé : le profil ne contient que son chemin.

const PROFILES_KEY = 'chatProfiles';
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
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Avatar de secours (initiale sur dégradé) : fonctionne sans Internet
const AVATAR_GRADIENTS = [
    ['#e11d48', '#a21cae'], ['#7c3aed', '#4338ca'], ['#c2410c', '#be123c'],
    ['#0369a1', '#4338ca'], ['#047857', '#0f766e']
];

function initialAvatar(name, glyph) {
    const text = String(name || '?').trim();
    const first = glyph || Array.from(text)[0] || '?';
    const label = escapeXml(first.toUpperCase());
    let hash = 0;
    for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 997;
    const pair = glyph ? AVATAR_GRADIENTS[0] : AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pair[0]}"/><stop offset="1" stop-color="${pair[1]}"/></linearGradient></defs>` +
        '<rect width="128" height="128" fill="url(#g)"/>' +
        `<text x="64" y="64" dy=".35em" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="60" font-weight="600" fill="#ffffff">${label}</text>` +
        '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Affiche la photo du profil, ou l'initiale si pas de photo
function setAvatarImg(img, profile, name, glyph) {
    if (!img) return;
    const fallback = initialAvatar(name, glyph);
    img.onerror = () => { img.onerror = null; img.src = fallback; };

    const path = profile && profile.avatar_url;
    if (!path) {
        img.src = fallback;
        return;
    }
    const ready = cachedMediaUrl(path);
    if (ready) {
        if (img.getAttribute('src') !== ready) img.src = ready;   // évite de clignoter à chaque mise à jour
        return;
    }
    if (!img.getAttribute('src')) img.src = fallback;
    mediaUrl(path).then(url => { if (url) img.src = url; });
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

function myDisplayName() {
    const me = profiles[myId];
    return (me && me.display_name) || (window.chatAuth && window.chatAuth.email) || 'Moi';
}

function refreshProfileUI() {
    const partnerId = getPartnerId();
    const partner = partnerId ? profiles[partnerId] : null;
    const partnerName = partnerDisplayName(partnerId);

    if (partnerNameEl) partnerNameEl.textContent = partnerName;
    setAvatarImg(partnerAvatarEl, partner, partnerName, partner && partner.display_name ? null : '❤️');
    setAvatarImg(meAvatarEl, profiles[myId], myDisplayName());
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

// Supprime l'ancienne photo du stockage (uniquement dans mon dossier avatars)
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
    setAvatarImg(profileAvatarPreview, me, myDisplayName());
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
    if (savingProfile || !myId) return;
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
        setAvatarImg(profileAvatarPreview, null, profileNameInput.value.trim() || myDisplayName());
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

        const replyTo = takeReplyTarget();   // message cité éventuel

        messageInput.value = '';
        updateComposerState();
        if (emojiPicker) emojiPicker.classList.remove('active');
        messageInput.focus();

        // Pas de connexion : le message est mis en attente
        if (!navigator.onLine) {
            queueText(text, undefined, replyTo);
            return;
        }

        // La bulle apparaît tout de suite (avec 🕓), elle sera confirmée quand le serveur répond
        const clientId = newClientId();
        addSending(clientId, 'text', { text: text, replyTo: replyTo });
        if (LOVE_RE.test(text)) burstHearts('right');
        const result = await insertMessage(text, 'text', clientId, replyTo);

        if (result.status === 'network') {
            failSending(clientId);
            queueText(text, clientId, replyTo);   // la connexion a lâché : même identifiant, donc jamais de doublon
        } else if (result.status === 'error') {
            failSending(clientId);
            alert('Message non envoyé : ' + result.error.message);
            messageInput.value = text;   // on remet le texte si l'envoi a échoué
            updateComposerState();
        }
    });
}

if (messageInput) {
    messageInput.addEventListener('input', updateComposerState);
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

    forgetMessage(id);
    removeMessageEl(document.getElementById(`msg-${id}`));
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
        return file; // en cas de problème on envoie l'original
    }
}

if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', () => {
        if (!myId) return;
        if (!navigator.onLine) {
            alert("Pas de connexion : les photos ne peuvent être envoyées qu'en ligne.");
            return;
        }
        imageInput.click();
    });

    imageInput.addEventListener('change', async (e) => {
        const original = e.target.files[0];
        imageInput.value = ''; // permet de renvoyer la même photo
        if (!original || !myId) return;

        // 1. La photo apparaît tout de suite dans le chat, avec un aperçu local
        const clientId = newClientId();
        const replyTo = takeReplyTarget();
        const firstPreview = URL.createObjectURL(original);
        addSending(clientId, 'image', { previewSrc: firstPreview, replyTo: replyTo });

        // 2. Réduction de la photo (plus légère = envoi plus rapide)
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

        const result = await insertMessage(path, 'image', clientId, replyTo);
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

        const stayAtBottom = isNearBottom();
        if (recordBtn) recordBtn.classList.add('recording');
        if (activityBar) activityBar.classList.add('active');
        if (composerEl) composerEl.classList.add('is-recording');
        if (stayAtBottom) scrollToBottom();

        setupAudioVisualizer(mediaStream);

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
        console.error("Erreur micro :", err);
        alert("Accès au microphone refusé ou non autorisé.");
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

        // Net sur les écrans haute densité, et rempli sur toute la largeur disponible
        const dpr = window.devicePixelRatio || 1;
        if (canvas) {
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                canvas.width = Math.round(rect.width * dpr);
                canvas.height = Math.round(rect.height * dpr);
            }
        }
        const styles = getComputedStyle(document.documentElement);
        const color1 = styles.getPropertyValue('--a1').trim() || '#e11d48';
        const color2 = styles.getPropertyValue('--a2').trim() || '#a21cae';

        function drawVisualizer() {
            if (!isRecording) return;

            animFrameId = requestAnimationFrame(drawVisualizer);
            analyser.getByteFrequencyData(dataArray);

            if (!canvasCtx) return;
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

            const barWidth = 3 * dpr;
            const gap = 3 * dpr;
            const count = Math.max(8, Math.floor(canvas.width / (barWidth + gap)));
            const usable = Math.max(4, Math.floor(bufferLength * 0.7)); // la voix vit dans les graves/médiums

            const gradient = canvasCtx.createLinearGradient(0, 0, 0, canvas.height);
            gradient.addColorStop(0, color1);
            gradient.addColorStop(1, color2);
            canvasCtx.fillStyle = gradient;

            for (let i = 0; i < count; i++) {
                const value = dataArray[Math.floor((i / count) * usable)] / 255;
                const barHeight = Math.max(4 * dpr, value * canvas.height);
                const x = i * (barWidth + gap);
                const y = (canvas.height - barHeight) / 2;
                canvasCtx.beginPath();
                if (canvasCtx.roundRect) canvasCtx.roundRect(x, y, barWidth, barHeight, 3 * dpr);
                else canvasCtx.rect(x, y, barWidth, barHeight);
                canvasCtx.fill();
            }
        }

        drawVisualizer();
    } catch (e) {
        console.error("Erreur visualiseur :", e);
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
    const replyTo = replyTarget ? replyTarget.id : null;

    mediaRecorder.onstop = async () => {
        const fullMime = mediaRecorder.mimeType || 'audio/webm';
        const mimeType = fullMime.split(';')[0];               // ex : audio/webm
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'; // extension cohérente
        const audioBlob = new Blob(audioChunks, { type: mimeType });

        // On libère tout de suite le micro et la barre d'enregistrement : l'envoi continue en arrière-plan
        cleanupAudio();
        if (audioBlob.size === 0) return;

        if (audioBlob.size > MAX_UPLOAD_BYTES) {
            alert('Ce vocal dépasse 25 Mo.');
            return;
        }

        const clientId = newClientId();
        clearReplyTarget();
        const localUrl = URL.createObjectURL(audioBlob);
        addSending(clientId, 'audio', { seconds: seconds, replyTo: replyTo });

        // La durée est écrite dans le nom du fichier : le lecteur l'affiche sans rien télécharger
        const path = `${myId}/vocal_${Date.now()}_${Math.max(1, Math.round(seconds))}s.${ext}`;

        const { error } = await supabaseClient.storage
            .from('media')
            .upload(path, audioBlob, { contentType: mimeType });

        if (error) {
            console.error('Erreur upload vocal :', error);
            failSending(clientId);
            alertUploadError('Le vocal', error);
            return;
        }

        localMedia.set(path, localUrl);   // on peut réécouter tout de suite sans retélécharger

        const result = await insertMessage(path, 'audio', clientId, replyTo);
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
    if (composerEl) composerEl.classList.remove('is-recording');
    if (recordBtn) recordBtn.classList.remove('recording');
    if (activityBar) activityBar.classList.remove('active');
    clearInterval(timerInterval);
    if (audioContext) audioContext.close();
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
}

/* ---------- Emojis et modale image ---------- */

if (emojiToggleBtn && emojiPicker) {
    emojiToggleBtn.addEventListener('click', () => {
        const stayAtBottom = isNearBottom();
        emojiPicker.classList.toggle('active');
        if (stayAtBottom) requestAnimationFrame(scrollToBottom);
    });
    emojiPicker.addEventListener('click', (e) => {
        if (e.target.tagName === 'SPAN') {
            messageInput.value += e.target.textContent;
            updateComposerState();
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
        if (e.target === imageModal) closeImageModal(); // clic à côté de la photo
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImageModal();
});

/* ---------- Démarrage, déclenché par auth.js une fois connecté ---------- */

function startChat() {
    myId = window.chatAuth.userId;

    // On affiche tout de suite la copie locale (même sans connexion)
    renderInstant = true;
    try {
        messageCache.forEach(m => renderMessage(m));
        getOutbox().forEach(renderPending);
    } finally {
        renderInstant = false;
    }
    scrollToBottom();
    refreshProfileUI();

    initChat();
    initProfilesChannel();
    initExtrasChannel();
    refreshConnectionUI();

    // Retour / perte de connexion
    window.addEventListener('online', () => {
        refreshConnectionUI();
        flushOutbox();
        setTimeout(() => { if (navigator.onLine) loadHistory(); }, 2000);
    });
    window.addEventListener('offline', refreshConnectionUI);
    setInterval(flushOutbox, 15000); // nouvelle tentative régulière tant qu'il reste des messages en attente
}

// On démarre dès que auth.js prévient que la connexion est faite — ou tout
// de suite si c'était déjà le cas avant que ce fichier finisse de charger.
let chatBooted = false;
function tryStartChat() {
    if (chatBooted || !window.chatAuth || !window.chatAuth.userId) return;
    chatBooted = true;
    // Si un code d'accès est activé, la conversation ne s'affiche qu'après l'avoir saisi
    const gate = window.chatLock && window.chatLock.ready ? window.chatLock.ready() : Promise.resolve();
    gate.then(startChat);
}
document.addEventListener('chat-auth-ready', tryStartChat);
if (window.chatAuth && window.chatAuth.ready) tryStartChat();