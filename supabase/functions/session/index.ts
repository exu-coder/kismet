import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const PER_IP_LIMIT = 30;       // per rolling hour
const GLOBAL_DAILY_LIMIT = 1000;

// The last XFF hop is the address assigned by the edge proxy. A caller can
// prepend hops, but cannot forge the final one, so do not trust
// cf-connecting-ip or an arbitrary forwarded value supplied by the client.
const trustedIp = (req: Request): string => {
  const hops = (req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return (hops[hops.length - 1] || "unknown").slice(0, 64) || "unknown";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceRoleKey) {
    return json({ error: "Session service is not configured" }, 500);
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  try {
    // Atomic reservation: the SQL function locks, counts, inserts and returns
    // one decision, so concurrent requests cannot both pass the limiter.
    const { data: allowed, error: reserveError } = await admin.rpc("kismet_reserve_session", {
      p_ip: trustedIp(req),
      p_per_ip_limit: PER_IP_LIMIT,
      p_global_daily_limit: GLOBAL_DAILY_LIMIT,
    });
    if (reserveError) {
      console.error("Session reservation failed:", reserveError.message);
      return json({ error: "Could not create a session" }, 500);
    }
    if (!allowed) {
      return json({ error: "Too many new sessions. Please try again later." }, 429);
    }

    const email = `guest_${crypto.randomUUID()}@kismet.invalid`;
    const password = `${crypto.randomUUID()}${crypto.randomUUID()}`;

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { kismet_guest: true },
    });
    if (createError || !created?.user) {
      console.error("Guest user creation failed:", createError?.message);
      return json({ error: "Could not create a session" }, 500);
    }

    const userClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: signed, error: signError } = await userClient.auth.signInWithPassword({ email, password });
    if (signError || !signed?.session) {
      console.error("Guest sign-in failed:", signError?.message);
      await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
      return json({ error: "Could not create a session" }, 500);
    }

    return json({
      access_token: signed.session.access_token,
      refresh_token: signed.session.refresh_token,
      expires_at: signed.session.expires_at,
      user_id: created.user.id,
    });
  } catch (error) {
    console.error("Session fallback failed:", error);
    return json({ error: "Could not create a session" }, 500);
  }
});
