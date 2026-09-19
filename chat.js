// CONFIGURATION SUPABASE
const SUPABASE_URL = 'https://ocquhbznrqbezhnjxaml.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kDdbAVit-5dBPLA7JxNA7Q_nlskMKw9';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const BASE_TITLE = document.title;
const MAX_RECORD_SECONDS = 300; // un vocal s'arrête et s'envoie tout seul après 5 minutes

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
const pendingIncoming = [];
let lastDateKey = null;
let unreadCount = 0;
let partnerOnline = false;
let partnerTyping = false;
let partnerTypingTimeout = null;
let lastTypingSent = 0;

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
    if (partnerTyping) {
        statusText.textContent = '✍️ écrit…';
        statusText.className = 'status typing';
    } else if (partnerOnline) {
        statusText.textContent = '● En ligne';
        statusText.className = 'status online';
    } else {
        statusText.textContent = '○ Hors ligne';
        statusText.className = 'status offline';
    }
}

/* ---------- Affichage des messages ---------- */

// Le texte n'est jamais interprété comme du HTML (sécurité)
function renderMessage(msg) {
    if (!msg || document.getElementById(`msg-${msg.id}`)) return;

    const created = msg.created_at ? new Date(msg.created_at) : new Date();

    // Séparateur de date quand on change de jour
    const dateKey = created.toDateString();
    if (dateKey !== lastDateKey) {
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.textContent = dateLabel(created);
        chatMessages.appendChild(sep);
        lastDateKey = dateKey;
    }

    const isMine = msg.sender === myName;
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
        img.src = msg.content;
        img.className = 'message-img';
        img.alt = 'Photo';
        img.addEventListener('click', () => openModal(msg.content));
        div.appendChild(img);
    } else if (msg.type === 'audio') {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = msg.content;
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

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Message reçu en temps réel
function handleIncoming(msg) {
    if (!historyLoaded) {          // on attend la fin du chargement de l'historique
        pendingIncoming.push(msg);
        return;
    }
    renderMessage(msg);

    if (msg.sender !== myName) {
        partnerTyping = false;
        updateStatus();
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
    }
});

/* ---------- Supabase : envoi ---------- */

async function insertMessage(content, type) {
    const { data, error } = await supabaseClient
        .from('messages')
        .insert([{ content: content, type: type, sender: myName }])
        .select();

    if (error) {
        console.error("Erreur d'envoi :", error);
        alert("Message non envoyé : " + error.message);
        return false;
    }
    // Affichage immédiat chez l'expéditeur (le doublon du temps réel est ignoré)
    if (data && data[0]) renderMessage(data[0]);
    return true;
}

/* ---------- Supabase : historique + temps réel ---------- */

async function loadHistory() {
    const { data, error } = await supabaseClient
        .from('messages')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        console.error("Erreur de chargement :", error);
        alert("Impossible de charger les messages : " + error.message);
        return;
    }
    data.forEach(renderMessage);
    historyLoaded = true;
    pendingIncoming.splice(0).forEach(renderMessage);
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
                await realtimeChannel.track({ name: myName });
                loadHistory();
            } else {
                channelReady = false;
            }
        });
}

initChat();
updateStatus();

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

        const ok = await insertMessage(text, 'text');
        if (!ok) messageInput.value = text; // on remet le texte si l'envoi a échoué
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
    const { data, error } = await supabaseClient
        .from('messages')
        .delete()
        .eq('id', id)
        .select();

    if (error || !data || data.length === 0) {
        console.error("Erreur de suppression :", error);
        alert("Suppression refusée par la base de données (règles RLS).");
        return;
    }
    const el = document.getElementById(`msg-${id}`);
    if (el) el.remove();
};

/* ---------- Images (compressées avant envoi) ---------- */

async function compressImage(file, maxSize = 1280, quality = 0.8) {
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
    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', async (e) => {
        const original = e.target.files[0];
        if (!original) return;

        imageBtn.textContent = '⏳';
        imageBtn.disabled = true;

        const file = await compressImage(original);
        const contentType = file.type || 'image/jpeg';
        const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const fileName = `img_${Date.now()}.${ext}`;

        const { error } = await supabaseClient.storage
            .from('media')
            .upload(fileName, file, { contentType: contentType });

        if (error) {
            console.error("Erreur upload image :", error);
            alert("Image non envoyée : " + error.message);
        } else {
            const { data: urlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
            await insertMessage(urlData.publicUrl, 'image');
        }

        imageBtn.textContent = '📷';
        imageBtn.disabled = false;
        imageInput.value = ''; // permet de renvoyer la même photo
    });
}

/* ---------- Enregistrement vocal ---------- */

if (recordBtn) {
    recordBtn.addEventListener('click', () => {
        if (!isRecording) startRecording();
        else stopAndSendRecording();
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

        if (audioBlob.size > 0) {
            const fileName = `vocal_${Date.now()}.${ext}`;

            const { error } = await supabaseClient.storage
                .from('media')
                .upload(fileName, audioBlob, { contentType: mimeType });

            if (error) {
                console.error("Erreur upload vocal :", error);
                alert("Vocal non envoyé : " + error.message);
            } else {
                const { data: urlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                await insertMessage(urlData.publicUrl, 'audio');
            }
        }
        cleanupAudio();
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