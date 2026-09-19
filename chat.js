// CONFIGURATION SUPABASE (Variable renommée supabaseClient pour éviter tout conflit)
const SUPABASE_URL = 'https://ocquhbznrqbezhnjxaml.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kDdbAVit-5dBPLA7JxNA7Q_nlskMKw9';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
const canvas = document.getElementById('audioVisualizer');
const canvasCtx = canvas ? canvas.getContext('2d') : null;

// Variables Globales Audio
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

function formatTime(dateString) {
    const date = dateString ? new Date(dateString) : new Date();
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderMessage(msg) {
    if (!msg || document.getElementById(`msg-${msg.id}`)) return;

    const messageDiv = document.createElement('div');
    messageDiv.id = `msg-${msg.id}`;
    messageDiv.className = `message ${msg.sender === 'user' ? 'sent' : 'received'}`;
    
    let body = '';
    if (msg.type === 'text') {
        body = `<p>${msg.content}</p>`;
    } else if (msg.type === 'image') {
        body = `<img src="${msg.content}" class="message-img" onclick="openModal('${msg.content}')" alt="Photo">`;
    } else if (msg.type === 'audio') {
        body = `<audio controls src="${msg.content}"></audio>`;
    }

    messageDiv.innerHTML = `
        <button class="delete-msg-btn" onclick="deleteMessageFromDB(${msg.id})" title="Supprimer">✕</button>
        ${body}
        <span class="time">${formatTime(msg.created_at)}</span>
    `;

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 1. Initialisation Supabase Realtime
async function initChat() {
    try {
        const { data: messages, error } = await supabaseClient
            .from('messages')
            .select('*')
            .order('created_at', { ascending: true });

        if (messages) {
            messages.forEach(msg => renderMessage(msg));
        }

        supabaseClient
            .channel('public:messages')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
                renderMessage(payload.new);
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, payload => {
                const el = document.getElementById(`msg-${payload.old.id}`);
                if (el) el.remove();
            })
            .subscribe();
    } catch (e) {
        console.error("Erreur d'initialisation Supabase:", e);
    }
}

initChat();

// 2. Envoi de Message Texte
if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
        if (isRecording) {
            stopAndSendRecording();
            return;
        }
        const text = messageInput.value.trim();
        if (text) {
            messageInput.value = '';
            if (emojiPicker) emojiPicker.classList.remove('active');
            
            await supabaseClient.from('messages').insert([
                { content: text, type: 'text', sender: 'user' }
            ]);
        }
    });
}

if (messageInput) {
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendBtn.click();
    });
}

// 3. Suppression
window.deleteMessageFromDB = async function(id) {
    await supabaseClient.from('messages').delete().eq('id', id);
};

// 4. Envoi d'Images
if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        
        const { data, error } = await supabaseClient.storage
            .from('media')
            .upload(fileName, file);

        if (data) {
            const { data: publicUrlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
            await supabaseClient.from('messages').insert([
                { content: publicUrlData.publicUrl, type: 'image', sender: 'user' }
            ]);
        }
    });
}

// 5. Gestion de Enregistrement Vocal
if (recordBtn) {
    recordBtn.addEventListener('click', () => {
        if (!isRecording) {
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
        }, 1000);

    } catch (err) {
        console.error("Erreur Micro :", err);
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
                canvasCtx.roundRect(x, y, barWidth, barHeight, 4);
                canvasCtx.fill();

                x += barWidth + gap;
                if (x > canvas.width) break;
            }
        }

        drawVisualizer();
    } catch (e) {
        console.error("Erreur Visualizer :", e);
    }
}

function stopAndSendRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    mediaRecorder.onstop = async () => {
        const mimeTypeUsed = mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunks, { type: mimeTypeUsed });

        if (audioBlob.size > 0) {
            const fileName = `vocal_${Date.now()}.webm`;
            
            const { data, error } = await supabaseClient.storage
                .from('media')
                .upload(fileName, audioBlob, { contentType: mimeTypeUsed });

            if (data) {
                const { data: publicUrlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                await supabaseClient.from('messages').insert([
                    { content: publicUrlData.publicUrl, type: 'audio', sender: 'user' }
                ]);
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

// 6. Emojis et Modale
if (emojiToggleBtn && emojiPicker) {
    emojiToggleBtn.addEventListener('click', () => emojiPicker.classList.toggle('active'));
    emojiPicker.addEventListener('click', (e) => {
        if (e.target.tagName === 'SPAN') {
            messageInput.value += e.target.textContent;
            messageInput.focus();
        }
    });
}

function openModal(src) {
    const imageModal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImg');
    if (imageModal && modalImg) {
        modalImg.src = src;
        imageModal.style.display = 'flex';
    }
}

const closeModal = document.getElementById('closeModal');
if (closeModal) {
    closeModal.addEventListener('click', () => {
        document.getElementById('imageModal').style.display = 'none';
    });
}