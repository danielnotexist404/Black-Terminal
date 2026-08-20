import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error("SUPABASE_URL, an anonymous key, and a service-role key are required");
}

const suffix = randomBytes(12).toString("hex");
const email = `black-cloud-smoke-${suffix}@example.invalid`;
const password = `${randomBytes(24).toString("base64url")}Aa1!`;
const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});
const userClient = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

let userId = null;
let channel = null;
try {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { purpose: "black-cloud-target-smoke" }
  });
  if (createError || !created.user?.id) throw createError || new Error("Disposable Auth user was not created");
  userId = created.user.id;

  const { data: session, error: signInError } = await userClient.auth.signInWithPassword({ email, password });
  if (signInError || !session.session?.access_token) throw signInError || new Error("Disposable Auth login returned no session");

  const { error: restError } = await userClient.from("bt_users").select("auth_user_id").limit(1);
  if (restError) throw new Error(`Authenticated RLS REST smoke failed: ${restError.message}`);

  const { data: buckets, error: storageError } = await admin.storage.listBuckets();
  if (storageError) throw new Error(`Storage API smoke failed: ${storageError.message}`);
  if (!Array.isArray(buckets) || buckets.length !== 2) {
    throw new Error(`Storage bucket count mismatch: expected 2, received ${buckets?.length ?? "invalid"}`);
  }

  channel = userClient.channel(`black-cloud-smoke-${suffix}`);
  const realtimeStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscription timed out")), 15_000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve(status);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`Realtime subscription failed: ${status}`));
      }
    });
  });

  console.log(`Black Cloud target smoke passed: auth=create/login/delete, REST=RLS, storageBuckets=${buckets.length}, realtime=${realtimeStatus}.`);
} finally {
  if (channel) await userClient.removeChannel(channel).catch(() => undefined);
  await userClient.auth.signOut().catch(() => undefined);
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(`Disposable Auth user cleanup failed: ${error.message}`);
  }
}
