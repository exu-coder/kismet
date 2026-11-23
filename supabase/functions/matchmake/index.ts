import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Kismet server-side matchmaking (v2).
// verify_jwt = false (temporary — identities are random localStorage IDs).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { userId, action } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    if (action === "leave") {
      await supabase.from("match_queue").delete().eq("user_id", userId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Clean stale entries (> 2 min)
    await supabase
      .from("match_queue")
      .delete()
      .lt("created_at", new Date(Date.now() - 120_000).toISOString());

    // If this user was already matched as responder, return the match now
    const { data: myRow } = await supabase
      .from("match_queue")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (myRow && myRow.matched_with && myRow.call_id) {
      return new Response(
        JSON.stringify({
          status: "matched",
          callId: myRow.call_id,
          partnerId: myRow.matched_with,
          role: myRow.role || "responder",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Try to find someone already waiting
    const { data: waiting } = await supabase
      .from("match_queue")
      .select("*")
      .is("matched_with", null)
      .neq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1);

    if (waiting && waiting.length > 0) {
      const partner = waiting[0];
      const callId = "call_" + [userId, partner.user_id].sort().join("_");

      await supabase
        .from("match_queue")
        .update({ matched_with: userId, call_id: callId, role: "responder" })
        .eq("user_id", partner.user_id);

      await supabase.from("match_queue").upsert({
        user_id: userId,
        matched_with: partner.user_id,
        call_id: callId,
        role: "initiator",
        created_at: new Date().toISOString(),
      });

      return new Response(
        JSON.stringify({
          status: "matched",
          callId,
          partnerId: partner.user_id,
          role: "initiator",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // No one waiting → join the queue
    await supabase.from("match_queue").upsert({
      user_id: userId,
      matched_with: null,
      call_id: null,
      role: null,
      created_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ status: "waiting" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
