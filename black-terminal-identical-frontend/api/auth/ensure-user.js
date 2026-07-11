import { applyCors, getSupabaseAdmin, requireFields, requireMethod, sendError } from "../../server/portfolio-api.js";

const allowedEmailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "yahoo.com"
]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["email", "password", "username"]);

    const email = String(req.body.email).trim().toLowerCase();
    const password = String(req.body.password);
    const username = String(req.body.username).trim();
    const displayName = String(req.body.displayName || username).trim();
    const emailDomain = email.split("@")[1];

    if (!email.includes("@") || !allowedEmailDomains.has(emailDomain)) {
      const error = new Error("Email domain is not allowed for registration.");
      error.statusCode = 400;
      throw error;
    }

    if (password.length < 6) {
      const error = new Error("Password must be at least 6 characters.");
      error.statusCode = 400;
      throw error;
    }

    if (username.length < 3) {
      const error = new Error("Username must be at least 3 characters.");
      error.statusCode = 400;
      throw error;
    }

    const supabase = getSupabaseAdmin();
    const existingUser = await findAuthUserByEmail(supabase, email);

    if (existingUser) {
      const { error } = await supabase.auth.admin.updateUserById(existingUser.id, {
        password,
        email_confirm: true,
        user_metadata: {
          ...(existingUser.user_metadata || {}),
          username,
          displayName,
          display_name: displayName
        }
      });
      if (error) throw error;

      return res.status(200).json({
        ok: true,
        status: "confirmed-existing",
        email
      });
    }

    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        displayName,
        display_name: displayName
      },
      app_metadata: {
        role: "user",
        productTier: "retail"
      }
    });

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      status: "created-confirmed",
      email
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function findAuthUserByEmail(supabase, email) {
  const normalizedEmail = email.toLowerCase();
  let page = 1;

  while (page <= 10) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    const match = data.users.find((user) => String(user.email || "").toLowerCase() === normalizedEmail);
    if (match) return match;
    if (data.users.length < 1000) return null;
    page += 1;
  }

  return null;
}
