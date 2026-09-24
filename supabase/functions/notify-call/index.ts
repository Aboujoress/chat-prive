import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const callId = body?.callId;
  if (!callId) return json({ error: 'bad request' }, 400);

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData } = await userClient.auth.getUser();
  const { data: isMember } = await userClient.rpc('is_couple_member');
  if (!userData?.user?.id || isMember !== true) return json({ error: 'forbidden' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  const { data: callRow } = await admin.from('call_signals')
    .select('caller_id, callee_id').eq('call_id', callId).maybeSingle();
  if (!callRow || callRow.caller_id !== userData.user.id) return json({ error: 'forbidden' }, 403);

  const { data: subs } = await admin.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', callRow.callee_id);
  if (!subs?.length) return json({ ok: true, sent: 0 });

  const { data: callerProfile } = await admin.from('profiles')
    .select('display_name').eq('id', callRow.caller_id).maybeSingle();
  const callerName = callerProfile?.display_name || 'Ton amour';

  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:contact@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  const payload = JSON.stringify({
    kind: 'call',
    title: `${callerName} t'appelle`,
    body: 'Appel entrant — Mon Chat Privé',
    tag: 'call-incoming',
    url: `./?call=${callId}`,
    callId: callId,
  });

  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 30, urgency: 'high' },
      );
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await admin.from('push_subscriptions').delete().eq('id', sub.id);
      }
    }
  }));

  return json({ ok: true, sent });
});