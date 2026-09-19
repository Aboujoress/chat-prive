// =====================================================================
//  AUTHENTIFICATION
//  Ce fichier se charge AVANT chat.js. Il crée le client Supabase,
//  affiche l'écran de connexion tant que personne n'est identifié,
//  puis appelle window.startChat().
// =====================================================================

const SUPABASE_URL = 'https://ocquhbznrqbezhnjxaml.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kDdbAVit-5dBPLA7JxNA7Q_nlskMKw9';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: true,      // la session survit à la fermeture de l'app
        autoRefreshToken: true,
        detectSessionInUrl: false
    }
});

window.supabaseClient = supabaseClient;
window.chatAuth = { userId: null, email: null };

const loginScreen = document.getElementById('loginScreen');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginSubmit = document.getElementById('loginSubmit');
const loginError = document.getElementById('loginError');

let chatStarted = false;

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
    setTimeout(() => loginEmail.focus(), 100);
}

function hideLogin() {
    loginScreen.classList.remove('open');
    document.body.classList.remove('locked');
    loginPassword.value = '';
}

// Le chat ne démarre qu'une fois, même si la session est rafraîchie ensuite.
function enterChat(session) {
    window.chatAuth.userId = session.user.id;
    window.chatAuth.email = session.user.email;
    hideLogin();

    if (!chatStarted) {
        chatStarted = true;
        window.startChat();
    }
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
    if (/failed to fetch|network/.test(msg) || !navigator.onLine) {
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
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error || !data.session) {
            showLogin(friendlyError(error));
            return;
        }
        enterChat(data.session);
    } finally {
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'Se connecter';
    }
});

// Déconnexion (bouton dans la fenêtre "Mon profil")
window.signOutChat = async function () {
    if (!confirm('Se déconnecter de cet appareil ?')) return;
    try {
        await supabaseClient.auth.signOut();
    } catch (e) { /* on recharge quand même */ }
    // On efface la copie locale des messages : un autre compte ne doit
    // pas retrouver la conversation en ouvrant l'application.
    try {
        localStorage.removeItem('chatCache');
        localStorage.removeItem('chatOutbox');
        localStorage.removeItem('chatProfiles');
        localStorage.removeItem('chatMediaUrls');
    } catch (e) { /* rien de grave */ }
    location.reload();
};

// Si la session expire ou est révoquée pendant l'utilisation
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (!session && chatStarted)) {
        location.reload();
    }
});

// Démarrage : la session enregistrée est lue localement, donc l'application
// s'ouvre aussi hors ligne si on s'est déjà connecté une fois.
(async function boot() {
    try {
        const { data } = await supabaseClient.auth.getSession();
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