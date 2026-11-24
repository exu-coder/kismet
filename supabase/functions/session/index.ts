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

  // Prefer the edge-provided client IP. Take the last forwarded hop so a
  // caller-supplied X-Forwarded-For cannot bypass the per-IP limiter.
  const forwarded = (req.headers.get("x-forwarded-for") || "")
    .split(",").map(part => part.trim()).filter(Boolean);
  const ip = (req.headers.get("cf-connecting-ip")
    || forwarded[forwarded.length - 1]
    || "unknown").slice(0, 64) || "unknown";
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const [{ count: ipCount }, { count: dayCount }] = await Promise.all([
      admin.from("session_grants").select("*", { count: "exact", head: true })
        .eq("ip", ip).gte("created_at", hourAgo),
      admin.from("session_grants").select("*", { count: "exact", head: true })
        .gte("created_at", dayAgo),
    ]);
    if ((ipCount ?? 0) >= PER_IP_LIMIT || (dayCount ?? 0) >= GLOBAL_DAILY_LIMIT) {
      return json({ error: "Too many new sessions. Please try again later." }, 429);
    }

    // Opportunistic cleanup keeps the table small without a cron job.
    await admin.from("session_grants").delete().lt("created_at", dayAgo);
    await admin.from("session_grants").insert({ ip });

    // Throwaway guest credentials. The .invalid TLD can never receive mail,
    // and email_confirm skips the mailer entirely.
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
