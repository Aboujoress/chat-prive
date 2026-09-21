// =====================================================================
//  CODE D'ACCÈS — verrouille l'application avec un code à 4 chiffres
//  Se charge avant chat.js. Tout est enfermé dans une fonction.
//  Expose : window.chatLock  (ready(), enabled(), lockNow())
//
//  Attention : c'est un verrou de confort (contre un regard curieux ou
//  quelqu'un qui prend ton téléphone), pas un chiffrement des données.
// =====================================================================
(function () {
    const LOCK_KEY = 'chatLock';         // { salt, hash } — jamais le code lui-même
    const FAIL_KEY = 'chatLockFails';    // { count, until }
    const PREF_KEY = 'chatLockPrefs';    // { delay }
    const PIN_LENGTH = 4;
    const ITERATIONS = 120000;
    const DELAYS = [
        { ms: 0, label: 'Immédiatement' },
        { ms: 60000, label: 'Après 1 minute' },
        { ms: 300000, label: 'Après 5 minutes' },
        { ms: 900000, label: 'Après 15 minutes' }
    ];

    const available = !!(window.crypto && window.crypto.subtle);

    const screen = document.getElementById('lockScreen');
    const titleEl = document.getElementById('lockTitle');
    const subEl = document.getElementById('lockSub');
    const dotsEl = document.getElementById('lockDots');
    const keysEl = document.getElementById('lockKeys');
    const forgotBtn = document.getElementById('lockForgot');
    const cancelBtn = document.getElementById('lockCancel');

    const statusEl = document.getElementById('lockStatus');
    const enableBtn = document.getElementById('lockEnableBtn');
    const changeBtn = document.getElementById('lockChangeBtn');
    const disableBtn = document.getElementById('lockDisableBtn');
    const delayRow = document.getElementById('lockDelayRow');
    const delaySelect = document.getElementById('lockDelaySelect');

    function read(key, fallback) {
        try {
            const v = JSON.parse(localStorage.getItem(key));
            return v === null || v === undefined ? fallback : v;
        } catch (e) { return fallback; }
    }
    function write(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignoré */ }
    }
    function remove(key) {
        try { localStorage.removeItem(key); } catch (e) { /* ignoré */ }
    }

    function enabled() {
        const lock = read(LOCK_KEY, null);
        return !!(lock && lock.salt && lock.hash);
    }

    function toB64(bytes) {
        let s = '';
        new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b); });
        return btoa(s);
    }
    function fromB64(b64) {
        const raw = atob(b64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    async function derive(pin, saltBytes) {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
        return toB64(bits);
    }

    async function saveNewPin(pin) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        write(LOCK_KEY, { salt: toB64(salt), hash: await derive(pin, salt) });
        remove(FAIL_KEY);
    }

    async function verifyPin(pin) {
        const lock = read(LOCK_KEY, null);
        if (!lock) return false;
        return (await derive(pin, fromB64(lock.salt))) === lock.hash;
    }

    /* ---------- Écran du clavier ---------- */

    let mode = 'unlock';         // unlock | verify-old | set-new | set-confirm
    let entry = '';
    let firstPin = null;
    let onSuccess = null;
    let onCancel = null;
    let processing = false;
    let lockTimer = null;

    let readyResolve;
    const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

    function isOpen() { return screen && screen.classList.contains('open'); }

    function buildKeypad() {
        if (!keysEl || keysEl.children.length) return;
        const layout = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '<'];
        layout.forEach((k) => {
            const b = document.createElement('button');
            b.type = 'button';
            if (k === '') {
                b.className = 'lock-key empty';
                b.disabled = true;
                b.setAttribute('aria-hidden', 'true');
            } else if (k === '<') {
                b.className = 'lock-key back';
                b.setAttribute('aria-label', 'Effacer');
                b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="M14 9.5l5 5M19 9.5l-5 5"/></svg>';
                b.addEventListener('click', backspace);
            } else {
                b.className = 'lock-key';
                b.textContent = k;
                b.addEventListener('click', () => press(k));
            }
            keysEl.appendChild(b);
        });
    }

    function renderDots() {
        if (!dotsEl) return;
        dotsEl.innerHTML = '';
        for (let i = 0; i < PIN_LENGTH; i++) {
            const d = document.createElement('i');
            if (i < entry.length) d.className = 'on';
            dotsEl.appendChild(d);
        }
    }

    function setMessage(text, isError) {
        if (!subEl) return;
        subEl.textContent = text;
        subEl.classList.toggle('error', !!isError);
    }

    function shake() {
        if (!dotsEl) return;
        dotsEl.classList.remove('shake');
        void dotsEl.offsetWidth;
        dotsEl.classList.add('shake');
    }

    function setMode(m) {
        mode = m;
        entry = '';
        renderDots();
        const texts = {
            'unlock': ["Entre ton code", 'Ton code à 4 chiffres'],
            'verify-old': ['Code actuel', 'Entre ton code actuel pour continuer'],
            'set-new': ['Nouveau code', 'Choisis un code à 4 chiffres'],
            'set-confirm': ['Confirme ton code', 'Entre-le une deuxième fois']
        };
        titleEl.textContent = texts[m][0];
        setMessage(texts[m][1], false);
        if (forgotBtn) forgotBtn.style.display = m === 'unlock' ? '' : 'none';
        if (cancelBtn) cancelBtn.style.display = m === 'unlock' ? 'none' : '';
    }

    function open(m, success, cancel) {
        if (!screen) return;
        onSuccess = success || null;
        onCancel = cancel || null;
        setMode(m);
        screen.classList.add('open');
        document.body.classList.add('locked');
        checkLockout();
    }

    function close() {
        if (!screen) return;
        screen.classList.remove('open');
        if (!document.getElementById('loginScreen') || !document.getElementById('loginScreen').classList.contains('open')) {
            document.body.classList.remove('locked');
        }
        entry = '';
        clearTimeout(lockTimer);
    }

    /* ---------- Essais et blocage temporaire ---------- */

    function lockedUntil() {
        const f = read(FAIL_KEY, { count: 0, until: 0 });
        return f.until > Date.now() ? f.until : 0;
    }

    function checkLockout() {
        clearTimeout(lockTimer);
        const until = lockedUntil();
        if (!until) return;
        const tick = () => {
            const left = Math.ceil((until - Date.now()) / 1000);
            if (left <= 0) {
                setMessage(mode === 'unlock' ? 'Ton code à 4 chiffres' : 'Entre ton code actuel pour continuer', false);
                return;
            }
            setMessage(`Trop d'essais. Réessaie dans ${left} s`, true);
            lockTimer = setTimeout(tick, 500);
        };
        tick();
    }

    function registerFailure() {
        const f = read(FAIL_KEY, { count: 0, until: 0 });
        f.count += 1;
        if (f.count % 5 === 0) {
            const round = f.count / 5;                       // 30 s, 60 s, 120 s…
            f.until = Date.now() + 30000 * Math.pow(2, Math.min(round - 1, 6));
        }
        write(FAIL_KEY, f);
    }

    /* ---------- Saisie ---------- */

    function backspace() {
        if (processing) return;
        entry = entry.slice(0, -1);
        renderDots();
    }

    function press(d) {
        if (processing || lockedUntil() || entry.length >= PIN_LENGTH) return;
        entry += d;
        renderDots();
        if (entry.length === PIN_LENGTH) setTimeout(process, 140);
    }

    async function process() {
        if (processing) return;
        processing = true;
        const pin = entry;
        try {
            if (mode === 'unlock' || mode === 'verify-old') {
                if (await verifyPin(pin)) {
                    remove(FAIL_KEY);
                    if (mode === 'unlock') {
                        close();
                        readyResolve();
                        if (onSuccess) onSuccess();
                    } else if (onSuccess) {
                        const next = onSuccess;
                        onSuccess = null;
                        next();
                    }
                } else {
                    registerFailure();
                    shake();
                    entry = '';
                    renderDots();
                    if (lockedUntil()) checkLockout();
                    else setMessage('Code incorrect', true);
                }
            } else if (mode === 'set-new') {
                firstPin = pin;
                setMode('set-confirm');
            } else if (mode === 'set-confirm') {
                if (pin === firstPin) {
                    await saveNewPin(pin);
                    firstPin = null;
                    close();
                    refreshSettings();
                    if (onSuccess) onSuccess();
                } else {
                    shake();
                    firstPin = null;
                    setMode('set-new');
                    setMessage('Les deux codes ne correspondent pas. Recommence.', true);
                }
            }
        } finally {
            processing = false;
        }
    }

    // Clavier physique (ordinateur)
    document.addEventListener('keydown', (e) => {
        if (!isOpen()) return;
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
        else if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
        else if (e.key === 'Escape' && mode !== 'unlock') { e.stopPropagation(); cancelFlow(); }
    }, true);

    function cancelFlow() {
        close();
        firstPin = null;
        if (onCancel) onCancel();
        refreshSettings();
    }

    if (cancelBtn) cancelBtn.addEventListener('click', cancelFlow);

    if (forgotBtn) {
        forgotBtn.addEventListener('click', () => {
            if (!confirm("Pour retrouver l'accès, tu vas être déconnecté : il faudra saisir ton e-mail et ton mot de passe. Continuer ?")) return;
            if (window.signOutChat) window.signOutChat({ skipConfirm: true });
        });
    }

    /* ---------- Réglages (fenêtre « Mon profil ») ---------- */

    function currentDelay() {
        const p = read(PREF_KEY, { delay: 60000 });
        return typeof p.delay === 'number' ? p.delay : 60000;
    }

    function refreshSettings() {
        if (!statusEl) return;

        if (!available) {
            statusEl.textContent = "Le code d'accès n'est pas disponible dans ce navigateur.";
            [enableBtn, changeBtn, disableBtn, delayRow].forEach((el) => { if (el) el.style.display = 'none'; });
            return;
        }

        const on = enabled();
        statusEl.textContent = on ? '✓ Un code protège l\'application' : "Demande un code à 4 chiffres à l'ouverture.";
        if (enableBtn) enableBtn.style.display = on ? 'none' : '';
        if (changeBtn) changeBtn.style.display = on ? '' : 'none';
        if (disableBtn) disableBtn.style.display = on ? '' : 'none';
        if (delayRow) delayRow.style.display = on ? '' : 'none';
        if (delaySelect) delaySelect.value = String(currentDelay());
    }

    if (delaySelect) {
        DELAYS.forEach((d) => {
            const o = document.createElement('option');
            o.value = String(d.ms);
            o.textContent = d.label;
            delaySelect.appendChild(o);
        });
        delaySelect.addEventListener('change', () => write(PREF_KEY, { delay: parseInt(delaySelect.value, 10) || 0 }));
    }

    if (enableBtn) enableBtn.addEventListener('click', () => open('set-new'));
    if (changeBtn) changeBtn.addEventListener('click', () => open('verify-old', () => setMode('set-new')));
    if (disableBtn) {
        disableBtn.addEventListener('click', () => open('verify-old', () => {
            remove(LOCK_KEY);
            remove(FAIL_KEY);
            close();
            refreshSettings();
        }));
    }

    /* ---------- Verrouillage automatique au retour sur l'application ---------- */

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            hiddenAt = Date.now();
        } else if (hiddenAt && enabled() && !isOpen() && Date.now() - hiddenAt >= currentDelay()) {
            open('unlock');
        }
    });

    /* ---------- Démarrage ---------- */

    buildKeypad();
    refreshSettings();

    window.chatLock = {
        ready: () => readyPromise,
        enabled: enabled,
        lockNow: () => { if (enabled() && !isOpen()) open('unlock'); }
    };

    // Code activé : l'écran se ferme seulement avec le bon code, dès l'ouverture
    if (available && enabled()) open('unlock');
    else readyResolve();
})();