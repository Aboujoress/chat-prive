// =====================================================================
//  Fonction Supabase : notify-message
//  Envoie une notification à l'autre personne à chaque nouveau message.
//  Peut être appelée directement par l'application, ou par un webhook.
//
//  Secrets à créer dans Supabase (Edge Functions > Secrets) :
//    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, WEBHOOK_SECRET
//  (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY existent déjà automatiquement.)
// =====================================================================
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

export interface Sub {
  id: number;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  show_preview: boolean;
}

export interface Deps {
  secret: string;
  getSubscriptionsExcept(userId: string): Promise<Sub[]>;
  getSenderName(userId: string): Promise<string | null>;
  send(sub: Sub, payload: string): Promise<void>;
  deleteSubscription(id: number): Promise<void>;
}

// Texte affiché dans la notification
export function previewOf(msg: { type?: string; content?: string }): string {
  if (msg.type === 'image') return '📷 Photo';
  if (msg.type === 'video') return '🎥 Vidéo';
  if (msg.type === 'audio') return '🎤 Message vocal';
    if (msg.type === 'call') {
    try {
      const info = JSON.parse(msg.content ?? '{}');
      if (info.status === 'missed') return '📵 Appel manqué';
      if (info.status === 'declined') return '📵 Appel refusé';
      const m = Math.floor((info.duration || 0) / 60), s = String((info.duration || 0) % 60).padStart(2, '0');
      return `📞 Appel terminé (${m}:${s})`;
    } catch { return '📞 Appel'; }
  }
  const text = String(msg.content ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 117) + '…' : text || 'Nouveau message';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

export function buildHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!deps.secret || req.headers.get('x-webhook-secret') !== deps.secret) {
      return json({ error: 'unauthorized' }, 401);
    }

    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return json({ error: 'bad request' }, 400);
    }

    // On ne s'intéresse qu'aux nouveaux messages
    if (payload?.type !== 'INSERT' || payload?.table !== 'messages' || !payload.record?.sender_id) {
      return json({ ok: true, skipped: 'pas un nouveau message' });
    }
    const msg = payload.record;

    // Tous les appareils des AUTRES comptes (pas celui de l'expéditeur)
    const subs = await deps.getSubscriptionsExcept(msg.sender_id);
    if (!subs.length) return json({ ok: true, sent: 0 });

    const senderName = (await deps.getSenderName(msg.sender_id)) || 'Nouveau message';

    let sent = 0, removed = 0, failed = 0;
    await Promise.all(subs.map(async (sub) => {
      const showText = sub.show_preview !== false;
      const data = JSON.stringify({
        title: showText ? senderName : 'Mon Chat Privé',
        body: showText ? previewOf(msg) : 'Nouveau message',
        tag: 'chat-prive',
        url: './',
      });
      try {
        await deps.send(sub, data);
        sent++;
      } catch (e: any) {
        // 404 / 410 : l'appareil n'existe plus (application désinstallée, notifications coupées)
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await deps.deleteSubscription(sub.id);
          removed++;
        } else {
          failed++;
          console.error('Envoi impossible :', e?.statusCode, e?.body ?? e?.message ?? e);
        }
      }
    }));

    return json({ ok: true, sent, removed, failed });
  };
}

function realDeps(): Deps {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:contact@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  return {
    secret: Deno.env.get('WEBHOOK_SECRET') ?? '',
    async getSubscriptionsExcept(userId) {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('id, user_id, endpoint, p256dh, auth, show_preview')
        .neq('user_id', userId);
      if (error) throw error;
      return data ?? [];
    },
    async getSenderName(userId) {
      const { data } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle();
      return data?.display_name ?? null;
    },
    async send(sub, payload) {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 3600, urgency: 'high' },
      );
    },
    async deleteSubscription(id) {
      await supabase.from('push_subscriptions').delete().eq('id', id);
    },
  };
}

// (NOTIFY_TEST sert uniquement aux tests automatiques)
if (Deno.env.get('NOTIFY_TEST') !== '1') {
  const handler = buildHandler(realDeps());
  const secret = Deno.env.get('WEBHOOK_SECRET') ?? '';

  // Point d'entrée réel : accepte soit un vrai Database Webhook (secret),
  // soit un appel direct depuis l'application, authentifié par la session
  // de la personne connectée (pas besoin d'exposer le secret au navigateur).
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }
    if (req.headers.get('x-webhook-secret')) {
      return handler(req);   // vrai webhook Supabase : chemin inchangé
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'unauthorized' }, 401);

    const bodyText = await req.text();
    let record: any;
    try { record = JSON.parse(bodyText)?.record; } catch { record = null; }
    if (!record?.sender_id) return json({ error: 'bad request' }, 400);

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );

    const { data: userData } = await userClient.auth.getUser();
    const { data: isMember } = await userClient.rpc('is_couple_member');

    // On vérifie que la personne connectée est bien membre du couple ET
    // qu'elle est bien l'auteure du message qu'elle prétend notifier.
    if (userData?.user?.id !== record.sender_id || isMember !== true) {
      return json({ error: 'forbidden' }, 403);
    }

    const forwarded = new Request(req.url, {
      method: req.method,
      headers: new Headers({ ...Object.fromEntries(req.headers), 'x-webhook-secret': secret }),
      body: bodyText,
    });
    return handler(forwarded);
  });
}