// SERVICE WORKER — Mon Chat Privé
// Permet d'ouvrir l'application sans connexion Internet.
// Si tu ajoutes un NOUVEAU fichier à précharger, change le numéro de version.
const VERSION = 'v2';
const APP_CACHE = `chat-prive-app-${VERSION}`;
const IMG_CACHE = 'chat-prive-images';
const MAX_IMAGES = 100;

const APP_FILES = [
    './',
    './index.html',
    './style.css',
    './auth.css',
    './supabase.js',
    './auth.js',
    './chat.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// Installation : on garde une copie de l'application
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(APP_CACHE).then((cache) => cache.addAll(APP_FILES))
    );
    self.skipWaiting();
});

// Activation : on supprime les anciennes versions du cache
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k.startsWith('chat-prive-app-') && k !== APP_CACHE)
                    .map((k) => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// Fichiers de l'application : le réseau d'abord (toujours à jour),
// et si le réseau est absent ou trop lent (3 s), on utilise la copie gardée.
function networkFirst(request) {
    return new Promise((resolve) => {
        let settled = false;

        const timer = setTimeout(async () => {
            const cached = await caches.match(request, { ignoreSearch: true });
            if (cached && !settled) {
                settled = true;
                resolve(cached);
            }
        }, 3000);

        fetch(request)
            .then((response) => {
                clearTimeout(timer);
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(APP_CACHE).then((cache) => cache.put(request, copy));
                }
                if (!settled) {
                    settled = true;
                    resolve(response);
                }
            })
            .catch(async () => {
                clearTimeout(timer);
                let cached = await caches.match(request, { ignoreSearch: true });
                if (!cached && request.mode === 'navigate') {
                    cached = await caches.match('./index.html');
                }
                if (!settled) {
                    settled = true;
                    resolve(cached || Response.error());
                }
            });
    });
}

// Les photos viennent maintenant d'adresses signées : la même image a une
// adresse différente chaque heure. On range donc la copie sous l'adresse
// SANS le jeton, sinon le cache ne servirait jamais.
function imageCacheKey(url) {
    const u = new URL(url);
    return u.origin + u.pathname;
}

async function trimImageCache(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_IMAGES) {
        await Promise.all(keys.slice(0, keys.length - MAX_IMAGES).map((k) => cache.delete(k)));
    }
}

async function cacheFirstImage(request, event) {
    const cache = await caches.open(IMG_CACHE);
    const key = imageCacheKey(request.url);

    const cached = await cache.match(key);
    if (cached) return cached;

    try {
        const response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
        if (response && response.ok) {
            // On enregistre la copie en arrière-plan : la photo s'affiche sans attendre
            const save = cache.put(key, response.clone())
                .then(() => trimImageCache(cache))
                .catch(() => {});
            event.waitUntil(save);
        }
        return response;
    } catch (e) {
        try {
            return await fetch(request);
        } catch (e2) {
            return Response.error();
        }
    }
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;   // envois, uploads : on ne touche à rien

    const url = new URL(request.url);

    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (request.destination === 'image') {
        event.respondWith(cacheFirstImage(request, event));
    }
    // tout le reste (API Supabase, vocaux, temps réel) passe par le réseau
});