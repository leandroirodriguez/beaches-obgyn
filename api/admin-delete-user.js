import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) return res.status(500).json({ error: "SUPABASE_URL is missing" });
  if (!key) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is missing" });

  const supabase = createClient(url, key);

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { providerId, email } = req.body;
  if (!providerId || !email) return res.status(400).json({ error: "providerId and email are required" });

  try {
    // Find auth user by email
    const { data: users, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) return res.status(400).json({ error: listError.message });

    const authUser = users.users.find(u => u.email === email);

    // Delete from providers table
    const { error: dbError } = await supabase.from("providers").delete().eq("id", providerId);
    if (dbError) return res.status(400).json({ error: dbError.message });

    // Delete from auth if found
    if (authUser) {
      const { error: authError } = await supabase.auth.admin.deleteUser(authUser.id);
      if (authError) return res.status(400).json({ error: authError.message });
    }

    return res.status(200).json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("admin-delete-user error:", err);
    return res.status(500).json({ error: err.message });
  }
}
