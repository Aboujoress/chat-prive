// =====================================================================
//  SERVICE WORKER — notifications uniquement
//  Il ne met RIEN en cache et n'intercepte aucune requête : le bug de
//  cache d'avant ne peut donc pas revenir. Il sert seulement à recevoir
//  les notifications, même quand l'application est fermée.
// =====================================================================

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // On supprime toutes les anciennes copies en cache des versions précédentes
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('chat-prive')).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

const IS_IOS = /iphone|ipad|ipod/i.test(self.navigator.userAgent || '');

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignoré */ }

    if (data.kind === 'call') {
        const options = {
            body: data.body || 'Appel entrant',
            icon: 'icon-192.png',
            badge: 'icon-192.png',
            tag: data.tag || 'call-incoming',
            requireInteraction: true,
            vibrate: [400, 200, 400, 200, 400, 200, 400],
            data: { url: data.url || './', callId: data.callId },
            actions: [
                { action: 'accept', title: '✅ Répondre' },
                { action: 'decline', title: '❌ Refuser' }
            ]
        };
        event.waitUntil(self.registration.showNotification(data.title || 'Appel entrant', options));
        return;
    }

    const title = data.title || 'Mon Chat Privé';
    const options = {
        body: data.body || 'Nouveau message',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.tag || 'chat-prive',
        data: { url: data.url || './' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Toucher la notification ouvre (ou ramène au premier plan) la conversation
const SUPABASE_ANON_URL = 'https://ocquhbznrqbezhnjxaml.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kDdbAVit-5dBPLA7JxNA7Q_nlskMKw9';

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const isCall = event.notification.tag === 'call-incoming';
    const callId = event.notification.data && event.notification.data.callId;
    const targetUrl = (event.notification.data && event.notification.data.url) || './';

    if (isCall && event.action === 'decline') {
        event.waitUntil(
            fetch(`${SUPABASE_ANON_URL}/functions/v1/decline-call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
                body: JSON.stringify({ callId: callId })
            }).catch(() => { /* ignoré */ })
        );
        return;
    }

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            const existing = list.find(c => 'focus' in c);
            if (existing) {
                existing.focus();
                if (isCall) existing.postMessage({ type: 'incoming-call', callId: callId, action: event.action || 'open' });
                return;
            }
            if (clients.openWindow) return clients.openWindow(isCall ? targetUrl + (event.action === 'accept' ? '&action=accept' : '') : targetUrl);
        })
    );
});

// Réception d'une notification push, même application fermée
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignoré */ }

    const title = data.title || 'Mon Chat Privé';
    const options = {
        body: data.body || 'Nouveau message',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.tag || 'chat-prive',
        data: { url: data.url || './' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Clic sur la notification : ouvre (ou réactive) l'application
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || './';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});


// Réception d'une notification push, même application fermée
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignoré */ }

    const title = data.title || 'Mon Chat Privé';
    const options = {
        body: data.body || 'Nouveau message',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.tag || 'chat-prive',
        data: { url: data.url || './' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Clic sur la notification : ouvre (ou réactive) l'application
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || './';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});