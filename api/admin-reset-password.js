import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, mode, tempPassword } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    if (mode === "email") {
      // Send password reset email via Supabase
      const { error } = await supabase.auth.resetPasswordForEmail(email);
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ message: `Password reset email sent to ${email}` });

    } else if (mode === "temp") {
      if (!tempPassword) return res.status(400).json({ error: "Temp password required" });

      // Look up user by email
      const { data: users, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) return res.status(400).json({ error: listError.message });

      const user = users.users.find(u => u.email === email);
      if (!user) return res.status(404).json({ error: "User not found" });

      // Update their password
      const { error } = await supabase.auth.admin.updateUserById(user.id, {
        password: tempPassword
      });
      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ message: `Password updated for ${email}` });
    }

    return res.status(400).json({ error: "Invalid mode" });

  } catch (err) {
    console.error("admin-reset-password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}