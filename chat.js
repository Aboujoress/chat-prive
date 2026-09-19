// CONFIGURATION SUPABASE
const SUPABASE_URL = 'https://ocquhbznrqbezhnjxaml.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kDdbAVit-5dBPLA7JxNA7Q_nlskMKw9';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const BASE_TITLE = document.title;
const MAX_RECORD_SECONDS = 300;   // un vocal s'arrête et s'envoie tout seul après 5 minutes
const HISTORY_LIMIT = 300;        // nombre de messages chargés depuis Supabase
const CACHE_LIMIT = 200;          // nombre de messages gardés pour le mode hors ligne
const CACHE_KEY = 'chatCache';
const OUTBOX_KEY = 'chatOutbox';

// IDENTITÉ : chacun saisit son prénom une seule fois (gardé dans le navigateur)
let myName = localStorage.getItem('chatName');
if (!myName) {
    myName = (prompt("Ton prénom ? (ex : Abdou)") || '').trim();
    if (!myName) myName = 'Moi';
    localStorage.setItem('chatName', myName);
}

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
let secondsRecorded = 0;
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

/* ---------- Affichage des messages ---------- */

function resetChatView() {
    chatMessages.innerHTML = '';
    lastDateKey = null;
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
    const isMine = msg.sender === myName;

    // Message qu'on vient d'envoyer : il prend la place de la bulle "en cours d'envoi"
    let target = replaceEl || null;
    if (!target && isMine) {
        const rec = takeSendingMatch(msg);
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
        img.src = localMedia.get(msg.content) || msg.content;
        img.className = 'message-img';
        img.alt = 'Photo';
        img.addEventListener('click', () => openModal(img.src));
        div.appendChild(img);
    } else if (msg.type === 'audio') {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = localMedia.get(msg.content) || msg.content;
        // Un seul vocal à la fois
        audio.addEventListener('play', () => {
            document.querySelectorAll('audio').forEach(a => { if (a !== audio) a.pause(); });
        });
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
}

// Message écrit hors ligne : affiché avec une horloge 🕓 en attendant l'envoi
function renderPending(item) {
    if (document.getElementById(`pending-${item.tempId}`)) return;

    ensureDateSeparator(new Date(item.created_at));

    const div = document.createElement('div');
    div.id = `pending-${item.tempId}`;
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

function removePending(tempId) {
    const el = document.getElementById(`pending-${tempId}`);
    if (el) el.remove();
}

/* ---------- Envoi instantané : la bulle apparaît tout de suite ---------- */

const sending = new Map();     // tempId -> { el, type, key } (envois en cours)
const localMedia = new Map();  // adresse du fichier -> copie locale (évite de retélécharger ce qu'on vient d'envoyer)

function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function addSending(type, opts) {
    const tempId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();
    ensureDateSeparator(now);

    const div = document.createElement('div');
    div.className = 'message sent pending sending';

    if (type === 'image') {
        const img = document.createElement('img');
        img.src = opts.previewSrc;
        img.className = 'message-img';
        img.alt = 'Photo en cours d\'envoi';
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

    sending.set(tempId, { el: div, type: type, key: type === 'text' ? opts.text : null });
    return tempId;
}

function setSendingKey(tempId, key) {
    const rec = sending.get(tempId);
    if (rec) rec.key = key;
}

function setSendingPreview(tempId, src) {
    const rec = sending.get(tempId);
    const img = rec && rec.el.querySelector('img');
    if (img) img.src = src;
}

function failSending(tempId) {
    const rec = sending.get(tempId);
    if (rec) rec.el.remove();
    sending.delete(tempId);
}

// Le temps réel peut annoncer notre propre message avant la réponse d'envoi : on l'associe à la bulle
function takeSendingMatch(msg) {
    const age = Date.now() - new Date(msg.created_at).getTime();
    if (!(age < 120000)) return null; // uniquement les messages récents
    for (const [tempId, rec] of sending) {
        if (rec.type === msg.type && rec.key === msg.content) {
            sending.delete(tempId);
            return rec;
        }
    }
    return null;
}

// Le serveur a confirmé : la bulle devient le vrai message
function finishSending(tempId, saved) {
    cacheAdd(saved);
    const rec = sending.get(tempId);
    if (rec) sending.delete(tempId);

    if (document.getElementById(`msg-${saved.id}`)) { // déjà affiché grâce au temps réel
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
    renderMessage(msg);

    if (msg.sender !== myName) {
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
    if (!document.hidden) {
        unreadCount = 0;
        document.title = BASE_TITLE;
        flushOutbox();
        loadProfiles();
    }
});

/* ---------- Supabase : envoi ---------- */

// Retourne { status: 'ok' | 'network' | 'error', error }
async function insertMessage(content, type, tempId) {
    const { data, error } = await supabaseClient
        .from('messages')
        .insert([{ content: content, type: type, sender: myName }])
        .select();

    if (error) {
        console.error("Erreur d'envoi :", error);
        return { status: isNetworkError(error) ? 'network' : 'error', error: error };
    }
    if (data && data[0]) {
        if (tempId) {
            finishSending(tempId, data[0]);   // la bulle en cours d'envoi devient le vrai message
        } else {
            cacheAdd(data[0]);
            renderMessage(data[0]);
        }
    } else if (tempId) {
        failSending(tempId);
    }
    return { status: 'ok' };
}

function alertUploadError(label, error) {
    if (isNetworkError(error)) {
        alert(`Pas de connexion : ${label} n'a pas pu être envoyé. Réessaie quand tu seras en ligne.`);
    } else {
        alert(`${label} non envoyé : ` + error.message);
    }
}

/* ---------- Messages en attente (envoi automatique au retour de la connexion) ---------- */

function queueText(text) {
    const item = {
        tempId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        content: text,
        type: 'text',
        sender: myName,
        created_at: new Date().toISOString()
    };
    const outbox = getOutbox();
    outbox.push(item);
    setOutbox(outbox);
    renderPending(item);
}

async function flushOutbox() {
    if (flushing || !navigator.onLine || getOutbox().length === 0) return;
    flushing = true;
    let sentSomething = false;

    try {
        while (true) {
            const outbox = getOutbox();
            if (outbox.length === 0) break;
            const item = outbox[0];

            // Évite un doublon si un envoi précédent était en fait déjà arrivé
            const check = await supabaseClient
                .from('messages')
                .select('*')
                .eq('sender', item.sender)
                .eq('created_at', item.created_at)
                .eq('content', item.content)
                .limit(1);
            if (check.error && isNetworkError(check.error)) break;

            let saved = (!check.error && check.data && check.data[0]) ? check.data[0] : null;

            if (!saved) {
                const { data, error } = await supabaseClient
                    .from('messages')
                    .insert([{
                        content: item.content,
                        type: item.type,
                        sender: item.sender,
                        created_at: item.created_at
                    }])
                    .select();

                if (error) {
                    if (isNetworkError(error)) break; // on réessaiera plus tard
                    console.error("Message en attente refusé :", error);
                    alert("Un message en attente n'a pas pu être envoyé : " + error.message);
                    setOutbox(getOutbox().filter(i => i.tempId !== item.tempId));
                    removePending(item.tempId);
                    continue;
                }
                saved = data && data[0];
            }

            setOutbox(getOutbox().filter(i => i.tempId !== item.tempId));
            removePending(item.tempId);
            if (saved) {
                cacheAdd(saved);
                renderMessage(saved);
            }
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
    historyLoaded = false; // les messages qui arrivent pendant le chargement sont mis de côté

    try {
        const { data, error } = await supabaseClient
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(HISTORY_LIMIT);

        if (error) {
            console.error("Erreur de chargement :", error);
            if (!isNetworkError(error)) {
                alert("Impossible de charger les messages : " + error.message);
            }
            return; // hors ligne : on garde l'affichage venant de la copie locale
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
            presence: { key: myName },
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
            const others = Object.keys(realtimeChannel.presenceState()).filter(k => k !== myName);
            partnerOnline = others.length > 0;
            updateStatus();
        })
        // L'autre est en train d'écrire
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
            if (!payload || payload.name === myName) return;
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
                try { await realtimeChannel.track({ name: myName }); } catch (e) { /* ignoré */ }
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

// Chaque personne est identifiée par le prénom saisi au départ (myName).
// Le "nom affiché" peut changer librement sans toucher aux anciens messages.
const PROFILES_KEY = 'chatProfiles';
let profiles = readJSON(PROFILES_KEY, {}); // identifiant -> profil
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

// Affiche la photo du profil, ou l'initiale si pas de photo (ou photo introuvable hors ligne)
function setAvatarImg(img, profile, name, glyph) {
    if (!img) return;
    const fallback = initialAvatar(name, glyph);
    img.onerror = () => { img.onerror = null; img.src = fallback; };
    img.src = (profile && profile.avatar_url) || fallback;
}

// L'autre personne : dernier expéditeur différent de moi, sinon un autre profil existant
function getPartnerId() {
    for (let i = messageCache.length - 1; i >= 0; i--) {
        if (messageCache[i].sender && messageCache[i].sender !== myName) return messageCache[i].sender;
    }
    const others = Object.keys(profiles).filter(k => k !== myName);
    others.sort((a, b) => String(profiles[b].updated_at || '').localeCompare(String(profiles[a].updated_at || '')));
    return others[0] || null;
}

function partnerDisplayName(partnerId) {
    const partner = partnerId ? profiles[partnerId] : null;
    return (partner && partner.display_name) || partnerId || 'Mon Amour';
}

function refreshProfileUI() {
    const partnerId = getPartnerId();
    const partner = partnerId ? profiles[partnerId] : null;
    const partnerName = partnerDisplayName(partnerId);

    if (partnerNameEl) partnerNameEl.textContent = partnerName;
    setAvatarImg(partnerAvatarEl, partner, partnerName, partnerId ? null : '❤️');

    const me = profiles[myName];
    setAvatarImg(meAvatarEl, me, (me && me.display_name) || myName);
}

async function loadProfiles() {
    try {
        const { data, error } = await supabaseClient.from('profiles').select('*');
        if (error) {
            console.warn('Profils non chargés :', error.message);
            return; // hors ligne ou table absente : on garde la copie locale
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

// Canal séparé : si la table "profiles" n'est pas prête, la messagerie continue de fonctionner
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

function avatarPathFromUrl(url) {
    const m = /\/object\/public\/media\/(.+)$/.exec(url || '');
    return m ? decodeURIComponent(m[1].split('?')[0]) : null;
}

// Supprime l'ancienne photo du stockage (uniquement dans le dossier avatars/)
async function deleteAvatarFile(url) {
    const path = avatarPathFromUrl(url);
    if (!path || !path.startsWith('avatars/')) return;
    try {
        await supabaseClient.storage.from('media').remove([path]);
    } catch (e) { /* pas grave */ }
}

function clearAvatarPreview() {
    if (avatarDraft.previewUrl) URL.revokeObjectURL(avatarDraft.previewUrl);
}

function updateRemoveBtn() {
    const me = profiles[myName];
    const hasPhoto = avatarDraft.blob || (!avatarDraft.removed && me && me.avatar_url);
    if (profileRemoveBtn) profileRemoveBtn.style.display = hasPhoto ? 'inline-block' : 'none';
}

function openProfileModal() {
    const me = profiles[myName] || {};
    clearAvatarPreview();
    avatarDraft = { blob: null, previewUrl: null, removed: false };

    profileNameInput.value = me.display_name || myName;
    profileBioInput.value = me.bio || '';
    setAvatarImg(profileAvatarPreview, me, me.display_name || myName);
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
    setAvatarImg(partnerModalAvatar, partner, name, partnerId ? null : '❤️');
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
        const old = profiles[myName] || {};
        let avatarUrl = avatarDraft.removed ? null : (old.avatar_url || null);
        let uploadedNew = false;

        // 1. Nouvelle photo : envoi dans le dossier avatars/
        if (avatarDraft.blob) {
            const path = `avatars/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
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
            avatarUrl = supabaseClient.storage.from('media').getPublicUrl(path).data.publicUrl;
            uploadedNew = true;
        }

        // 2. Enregistrement du profil
        const row = {
            id: myName,
            display_name: profileNameInput.value.trim() || myName,
            avatar_url: avatarUrl,
            bio: profileBioInput.value.trim(),
            updated_at: new Date().toISOString()
        };
        const { data, error } = await supabaseClient
            .from('profiles')
            .upsert([row], { onConflict: 'id' })
            .select();

        if (error) {
            console.error('Erreur profil :', error);
            if (uploadedNew) deleteAvatarFile(avatarUrl); // on ne garde pas une photo orpheline
            if (isNetworkError(error)) {
                alert("Pas de connexion : ton profil n'a pas pu être enregistré.");
            } else if (/profiles/i.test(error.message || '') || error.code === 'PGRST205') {
                alert("La table « profiles » est introuvable dans Supabase : lance d'abord le script SQL des profils.");
            } else {
                alert('Profil non enregistré : ' + error.message);
            }
            return;
        }

        profiles[myName] = (data && data[0]) || row;
        saveProfiles();

        // 3. Ménage : l'ancienne photo n'est plus utile
        if (old.avatar_url && old.avatar_url !== avatarUrl) deleteAvatarFile(old.avatar_url);

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
        setAvatarImg(profileAvatarPreview, null, profileNameInput.value.trim() || myName);
        updateRemoveBtn();
    });

    profileSaveBtn.addEventListener('click', saveMyProfile);
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

// Démarrage : on affiche tout de suite la copie locale (même sans connexion)
messageCache.forEach(m => renderMessage(m));
getOutbox().forEach(renderPending);
refreshProfileUI();

initChat();
initProfilesChannel();
refreshConnectionUI();

// Retour / perte de connexion
window.addEventListener('online', () => {
    refreshConnectionUI();
    flushOutbox();
    setTimeout(() => { if (navigator.onLine) loadHistory(); }, 2000);
});
window.addEventListener('offline', refreshConnectionUI);
setInterval(flushOutbox, 15000); // nouvelle tentative régulière tant qu'il reste des messages en attente

/* ---------- Envoi de texte ---------- */

if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
        if (isRecording) {
            stopAndSendRecording();
            return;
        }
        const text = messageInput.value.trim();
        if (!text) return;

        messageInput.value = '';
        if (emojiPicker) emojiPicker.classList.remove('active');
        messageInput.focus();

        // Pas de connexion : le message est mis en attente
        if (!navigator.onLine) {
            queueText(text);
            return;
        }

        // La bulle apparaît tout de suite (avec 🕓), elle sera confirmée quand le serveur répond
        const tempId = addSending('text', { text: text });
        const result = await insertMessage(text, 'text', tempId);
        if (result.status === 'network') {
            failSending(tempId);
            queueText(text); // la connexion a lâché pendant l'envoi
        } else if (result.status === 'error') {
            failSending(tempId);
            alert("Message non envoyé : " + result.error.message);
            messageInput.value = text; // on remet le texte si l'envoi a échoué
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
            realtimeChannel.send({ type: 'broadcast', event: 'typing', payload: { name: myName } });
        }
    });
}

/* ---------- Suppression ---------- */

window.deleteMessageFromDB = async function (id) {
    if (!navigator.onLine) {
        alert("Pas de connexion : suppression impossible pour le moment.");
        return;
    }
    const { data, error } = await supabaseClient
        .from('messages')
        .delete()
        .eq('id', id)
        .select();

    if (error && isNetworkError(error)) {
        alert("Pas de connexion : suppression impossible pour le moment.");
        return;
    }
    if (error || !data || data.length === 0) {
        console.error("Erreur de suppression :", error);
        alert("Suppression refusée par la base de données (règles RLS).");
        return;
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
        return file; // en cas de problème on envoie l'original
    }
}

if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', () => {
        if (!navigator.onLine) {
            alert("Pas de connexion : les photos ne peuvent être envoyées qu'en ligne.");
            return;
        }
        imageInput.click();
    });

    imageInput.addEventListener('change', async (e) => {
        const original = e.target.files[0];
        imageInput.value = ''; // permet de renvoyer la même photo
        if (!original) return;

        // 1. La photo apparaît tout de suite dans le chat, avec un aperçu local
        const firstPreview = URL.createObjectURL(original);
        const tempId = addSending('image', { previewSrc: firstPreview });

        // 2. Réduction de la photo (plus légère = envoi plus rapide)
        const file = await compressImage(original);
        const localUrl = URL.createObjectURL(file);
        setSendingPreview(tempId, localUrl);
        URL.revokeObjectURL(firstPreview);

        // 3. Envoi
        const contentType = file.type || 'image/jpeg';
        const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const fileName = `img_${Date.now()}.${ext}`;

        const { error } = await supabaseClient.storage
            .from('media')
            .upload(fileName, file, { contentType: contentType });

        if (error) {
            console.error("Erreur upload image :", error);
            failSending(tempId);
            alertUploadError('La photo', error);
            return;
        }

        const { data: urlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
        const publicUrl = urlData.publicUrl;
        localMedia.set(publicUrl, localUrl); // pas besoin de retélécharger notre propre photo
        setSendingKey(tempId, publicUrl);

        const result = await insertMessage(publicUrl, 'image', tempId);
        if (result.status !== 'ok') {
            failSending(tempId);
            alertUploadError('La photo', result.error);
        }
    });
}

/* ---------- Enregistrement vocal ---------- */

if (recordBtn) {
    recordBtn.addEventListener('click', () => {
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

        setupAudioVisualizer(mediaStream);

        if (recordBtn) recordBtn.classList.add('recording');
        if (activityBar) activityBar.classList.add('active');

        secondsRecorded = 0;
        if (recordingTimer) recordingTimer.textContent = '00:00';

        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            secondsRecorded++;
            const mins = String(Math.floor(secondsRecorded / 60)).padStart(2, '0');
            const secs = String(secondsRecorded % 60).padStart(2, '0');
            if (recordingTimer) recordingTimer.textContent = `${mins}:${secs}`;
            if (secondsRecorded >= MAX_RECORD_SECONDS) stopAndSendRecording();
        }, 1000);

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
        console.error("Erreur visualiseur :", e);
    }
}

function stopAndSendRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    // Vocal trop court (moins d'une seconde) : on annule au lieu d'envoyer
    if (secondsRecorded < 1) {
        cancelRecording();
        return;
    }

    mediaRecorder.onstop = async () => {
        const fullMime = mediaRecorder.mimeType || 'audio/webm';
        const mimeType = fullMime.split(';')[0];               // ex : audio/webm
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'; // extension cohérente
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        const seconds = secondsRecorded;

        // On libère tout de suite le micro et la barre d'enregistrement : l'envoi continue en arrière-plan
        cleanupAudio();
        if (audioBlob.size === 0) return;

        const localUrl = URL.createObjectURL(audioBlob);
        const tempId = addSending('audio', { seconds: seconds });
        const fileName = `vocal_${Date.now()}.${ext}`;

        const { error } = await supabaseClient.storage
            .from('media')
            .upload(fileName, audioBlob, { contentType: mimeType });

        if (error) {
            console.error("Erreur upload vocal :", error);
            failSending(tempId);
            alertUploadError('Le vocal', error);
            return;
        }

        const { data: urlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
        const publicUrl = urlData.publicUrl;
        localMedia.set(publicUrl, localUrl); // on peut réécouter tout de suite sans retélécharger
        setSendingKey(tempId, publicUrl);

        const result = await insertMessage(publicUrl, 'audio', tempId);
        if (result.status !== 'ok') {
            failSending(tempId);
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
        if (e.target === imageModal) closeImageModal(); // clic à côté de la photo
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImageModal();
});

/* ---------- Service worker : ouverture de l'application sans connexion ---------- */

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.error('Service worker :', err));
    });
}