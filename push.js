// =====================================================================
//  NOTIFICATIONS — recevoir un message même quand l'application est fermée
//  Se charge avant chat.js. Tout est enfermé dans une fonction.
//  Expose seulement : window.chatPush (utilisé à la déconnexion).
// =====================================================================
(function () {
    // Clé PUBLIQUE des notifications (la clé privée reste dans Supabase, jamais ici).
    const VAPID_PUBLIC_KEY = 'BCp9xVEo7dCdOIsFvhaq_vhpXTitu35vLbapvqPq99bhRMGhfjk0umG1WzgMtRtwS-_FW8k5ivyR5cjVFNO-GJ0';
    const PREVIEW_KEY = 'chatPushPreview';

    const client = window.supabaseClient;
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        navigator.standalone === true;

    const statusEl = document.getElementById('pushStatus');
    const toggleBtn = document.getElementById('pushToggleBtn');
    const previewRow = document.getElementById('pushPreviewRow');
    const previewToggle = document.getElementById('pushPreviewToggle');

    let userId = null;
    let busy = false;

    function wantsPreview() {
        try { return localStorage.getItem(PREVIEW_KEY) !== '0'; } catch (e) { return true; }
    }

    function b64ToBytes(b64) {
        const pad = '='.repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    // Le nettoyage des anciens service workers (dans index.html) doit finir avant qu'on enregistre le nouveau
    function waitForCleanup() {
        return new Promise((resolve) => {
            let tries = 0;
            (function check() {
                let done = true;
                try { done = !!localStorage.getItem('swCleanupV3'); } catch (e) { /* ignoré */ }
                if (done || ++tries > 25) resolve();
                else setTimeout(check, 300);
            })();
        });
    }

    async function getRegistration() {
        await waitForCleanup();
        const reg = await navigator.serviceWorker.register('sw.js');
        await navigator.serviceWorker.ready;
        return reg;
    }

    async function currentSubscription() {
        const reg = await navigator.serviceWorker.getRegistration();
        return reg ? reg.pushManager.getSubscription() : null;
    }

    async function saveSubscription(sub) {
        const json = sub.toJSON();
        const { error } = await client
            .from('push_subscriptions')
            .upsert([{
                user_id: userId,
                endpoint: json.endpoint,
                p256dh: json.keys && json.keys.p256dh,
                auth: json.keys && json.keys.auth,
                show_preview: wantsPreview(),
                user_agent: String(navigator.userAgent || '').slice(0, 200),
                updated_at: new Date().toISOString()
            }], { onConflict: 'endpoint' })
            .select();
        return error || null;
    }

    function friendlySaveError(error) {
        const msg = String((error && error.message) || '');
        if (/push_subscriptions/i.test(msg) || error.code === 'PGRST205') {
            return "La table des notifications est introuvable dans Supabase : lance d'abord le script SQL des nouveautés.";
        }
        return 'Notifications non activées : ' + msg;
    }

    async function refreshUI() {
        if (!statusEl || !toggleBtn) return;

        if (!supported) {
            statusEl.textContent = (isIOS && !standalone)
                ? "Sur iPhone : ajoute d'abord l'application à l'écran d'accueil (bouton Partager, puis « Sur l'écran d'accueil »), ouvre-la depuis là, puis reviens ici."
                : "Ce navigateur ne gère pas les notifications.";
            toggleBtn.style.display = 'none';
            if (previewRow) previewRow.style.display = 'none';
            return;
        }

        if (Notification.permission === 'denied') {
            statusEl.textContent = 'Bloquées pour ce site. Autorise-les dans les réglages du navigateur, puis reviens ici.';
            toggleBtn.style.display = 'none';
            if (previewRow) previewRow.style.display = 'none';
            return;
        }

        let sub = null;
        try { sub = await currentSubscription(); } catch (e) { /* ignoré */ }
        const on = !!sub && Notification.permission === 'granted';

        statusEl.textContent = on
            ? '✓ Activées sur cet appareil'
            : "Reçois un message même quand l'application est fermée.";
        toggleBtn.style.display = '';
        toggleBtn.textContent = on ? 'Désactiver' : 'Activer les notifications';
        toggleBtn.dataset.on = on ? '1' : '0';
        toggleBtn.disabled = busy;
        if (previewRow) previewRow.style.display = on ? '' : 'none';
        if (previewToggle) previewToggle.checked = wantsPreview();
    }

    async function enable() {
        if (!supported || busy || !userId) return;
        busy = true;
        toggleBtn.disabled = true;
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;

            const reg = await getRegistration();
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY)
                });
            }
            const error = await saveSubscription(sub);
            if (error) {
                console.error('Notifications :', error);
                alert(friendlySaveError(error));
                try { await sub.unsubscribe(); } catch (e) { /* ignoré */ }
            }
        } catch (e) {
            console.error('Notifications :', e);
            alert("Impossible d'activer les notifications sur cet appareil : " + ((e && e.message) || e));
        } finally {
            busy = false;
            refreshUI();
        }
    }

    async function disable() {
        if (busy) return;
        busy = true;
        toggleBtn.disabled = true;
        try {
            const sub = await currentSubscription();
            if (sub) {
                try { await client.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch (e) { /* ignoré */ }
                await sub.unsubscribe();
            }
        } catch (e) {
            console.error('Notifications :', e);
        } finally {
            busy = false;
            refreshUI();
        }
    }

    // À chaque ouverture : si c'est déjà activé, on remet l'abonnement à jour (il peut changer d'adresse)
    async function silentSync() {
        if (!supported || Notification.permission !== 'granted') return;
        try {
            const reg = await getRegistration();
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY)
                });
            }
            await saveSubscription(sub);
        } catch (e) {
            console.warn('Notifications non synchronisées :', e);
        }
    }

    // Déconnexion : cet appareil ne doit plus recevoir les messages de ce compte
    async function onSignOut() {
        if (!supported) return;
        try {
            const sub = await currentSubscription();
            if (sub) {
                try { await client.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch (e) { /* ignoré */ }
                await sub.unsubscribe();
            }
        } catch (e) { /* ignoré */ }
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            if (toggleBtn.dataset.on === '1') disable();
            else enable();
        });
    }

    if (previewToggle) {
        previewToggle.addEventListener('change', async () => {
            try { localStorage.setItem(PREVIEW_KEY, previewToggle.checked ? '1' : '0'); } catch (e) { /* ignoré */ }
            try {
                const sub = await currentSubscription();
                if (sub) {
                    await client.from('push_subscriptions')
                        .update({ show_preview: previewToggle.checked })
                        .eq('endpoint', sub.endpoint);
                }
            } catch (e) { /* ignoré */ }
        });
    }

    function init() {
        userId = window.chatAuth && window.chatAuth.userId;
        refreshUI();
        silentSync().then(refreshUI);
    }

    window.chatPush = { onSignOut: onSignOut, refresh: refreshUI };

    document.addEventListener('chat-auth-ready', init);
    if (window.chatAuth && window.chatAuth.ready) init();
})();