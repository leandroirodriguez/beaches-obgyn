import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

webpush.setVapidDetails(
  "mailto:admin@beachesobgyn.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { providerIds, title, body, data = {} } = req.body;
  if (!providerIds || !title || !body) return res.status(400).json({ error: "Missing fields" });

  // Fetch all push subscriptions for the given provider IDs
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .in("provider_id", providerIds);

  if (error) return res.status(500).json({ error: error.message });
  if (!subs || subs.length === 0) return res.status(200).json({ message: "No subscriptions found" });

  const payload = JSON.stringify({ title, body, data });

  const results = await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      ).catch(async err => {
        // Remove stale subscriptions (410 = unsubscribed)
        if (err.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        }
        throw err;
      })
    )
  );

  const sent = results.filter(r => r.status === "fulfilled").length;
  const failed = results.filter(r => r.status === "rejected").length;
  return res.status(200).json({ sent, failed });
}
