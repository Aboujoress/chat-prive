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
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { body: event.data ? event.data.text() : '' };
    }

    event.waitUntil((async () => {
        // Si la conversation est déjà ouverte à l'écran, inutile de notifier
        // (sur iPhone, Safari exige de toujours afficher une notification).
        if (!IS_IOS) {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            if (windows.some((w) => w.visibilityState === 'visible')) return;
        }

        await self.registration.showNotification(data.title || 'Mon Chat Privé', {
            body: data.body || 'Nouveau message',
            tag: data.tag || 'chat-prive',
            renotify: true,
            icon: 'icon-192.png',
            lang: 'fr',
            data: { url: data.url || './' }
        });
    })());
});

// Toucher la notification ouvre (ou ramène au premier plan) la conversation
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of windows) {
            if (w.url.startsWith(self.registration.scope) && 'focus' in w) {
                await w.focus();
                return;
            }
        }
        if (self.clients.openWindow) await self.clients.openWindow(target);
    })());
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