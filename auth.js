// =====================================================================
//  AUTHENTIFICATION — connexion par e-mail et mot de passe (Supabase Auth)
//  Ce fichier se charge AVANT chat.js. Tout est enfermé dans une fonction :
//  aucun de ses noms ne peut entrer en conflit avec ceux de chat.js.
//  Il expose seulement : window.supabaseClient, window.chatAuth
//  et window.signOutChat.
// =====================================================================
(function () {
    const SUPABASE_URL = 'https://ocquhbznrqbezhnjxaml.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_kDdbAVit-5dBPLA7JxNA7Q_nlskMKw9';

    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            persistSession: true,      // la session survit à la fermeture de l'app
            autoRefreshToken: true,
            detectSessionInUrl: false
        }
    });

    window.supabaseClient = client;
    window.chatAuth = { userId: null, email: null, ready: false };

    const loginScreen = document.getElementById('loginScreen');
    const loginForm = document.getElementById('loginForm');
    const loginEmail = document.getElementById('loginEmail');
    const loginPassword = document.getElementById('loginPassword');
    const loginSubmit = document.getElementById('loginSubmit');
    const loginError = document.getElementById('loginError');
    const loginToggle = document.getElementById('loginToggle');

    let signingOut = false;

    function showLogin(message) {
        if (message) {
            loginError.textContent = message;
            loginError.classList.add('show');
        } else {
            loginError.textContent = '';
            loginError.classList.remove('show');
        }
        loginScreen.classList.add('open');
        document.body.classList.add('locked');
        setTimeout(() => (loginEmail.value ? loginPassword : loginEmail).focus(), 150);
    }

    function hideLogin() {
        loginScreen.classList.remove('open');
        document.body.classList.remove('locked');
        loginPassword.value = '';
    }

    // Le chat démarre une seule fois. On prévient chat.js par un évènement
    // (et par window.chatAuth.ready) : ça marche quel que soit l'ordre de chargement.
    function enterChat(session) {
        if (window.chatAuth.ready) {          // session simplement rafraîchie : rien à refaire
            hideLogin();
            return;
        }
        window.chatAuth.userId = session.user.id;
        window.chatAuth.email = session.user.email;
        window.chatAuth.ready = true;
        hideLogin();
        document.dispatchEvent(new CustomEvent('chat-auth-ready'));
    }

    // Messages d'erreur en français, plus parlants que ceux de Supabase
    function friendlyError(error) {
        const msg = String((error && error.message) || '').toLowerCase();
        if (/invalid login credentials/.test(msg)) {
            return 'Adresse e-mail ou mot de passe incorrect.';
        }
        if (/email not confirmed/.test(msg)) {
            return "Ce compte n'est pas encore confirmé. Active-le depuis le tableau de bord Supabase.";
        }
        if (/failed to fetch|network|load failed/.test(msg) || !navigator.onLine) {
            return 'Pas de connexion. La première connexion doit se faire en ligne.';
        }
        return 'Connexion impossible : ' + ((error && error.message) || 'erreur inconnue');
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = loginEmail.value.trim();
        const password = loginPassword.value;
        if (!email || !password) return;

        loginSubmit.disabled = true;
        loginSubmit.textContent = 'Connexion…';
        loginError.classList.remove('show');

        try {
            const { data, error } = await client.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error || !data || !data.session) {
                showLogin(friendlyError(error));
                return;
            }
            enterChat(data.session);
        } catch (err) {
            showLogin(friendlyError(err));
        } finally {
            loginSubmit.disabled = false;
            loginSubmit.textContent = 'Se connecter';
        }
    });

    // Œil : afficher / masquer le mot de passe
    if (loginToggle) {
        loginToggle.addEventListener('click', () => {
            const visible = loginPassword.type === 'text';
            loginPassword.type = visible ? 'password' : 'text';
            loginToggle.classList.toggle('on', !visible);
            loginToggle.setAttribute('aria-label', visible ? 'Afficher le mot de passe' : 'Masquer le mot de passe');
            loginPassword.focus();
        });
    }

    // Déconnexion (bouton dans la fenêtre "Mon profil")
    window.signOutChat = async function (options) {
        if (!(options && options.skipConfirm) && !confirm('Se déconnecter de cet appareil ?')) return;
        signingOut = true;

        // Cet appareil ne doit plus recevoir les notifications de ce compte
        // (à faire AVANT la déconnexion, tant qu'on est encore identifié).
        try {
            if (window.chatPush) await window.chatPush.onSignOut();
        } catch (e) { /* on continue */ }

        // On efface la copie locale de la conversation et le code d'accès : un autre
        // compte ne doit pas retrouver la conversation sur cet appareil.
        try {
            ['chatCache', 'chatOutbox', 'chatProfiles', 'chatMediaUrls', 'chatReactions',
             'chatReceipts', 'chatLock', 'chatLockFails', 'chatLockPrefs'].forEach((k) => localStorage.removeItem(k));
        } catch (e) { /* rien de grave */ }

        try {
            await client.auth.signOut();
        } catch (e) { /* on recharge quand même */ }
        location.reload();
    };

    // Si la session expire ou est révoquée pendant l'utilisation
    client.auth.onAuthStateChange((event, session) => {
        if (signingOut) return;
        if (event === 'SIGNED_OUT' || (!session && window.chatAuth.ready)) {
            location.reload();
        }
    });

    // Démarrage : la session enregistrée est lue localement, donc l'application
    // reprend directement si on s'est déjà connecté une fois.
    (async function boot() {
        try {
            const { data } = await client.auth.getSession();
            if (data && data.session) {
                enterChat(data.session);
            } else {
                showLogin();
            }
        } catch (e) {
            console.error('Session illisible :', e);
            showLogin();
        }
    })();
})();