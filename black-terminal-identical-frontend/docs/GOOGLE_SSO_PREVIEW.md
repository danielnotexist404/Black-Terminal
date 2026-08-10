# Google SSO for the Preview branch

The frontend uses Supabase Auth as the identity authority. Google secrets must
never be added to Vite variables, Vercel client variables, or this repository.

## 1. Google Auth Platform

Create a **Web application** OAuth client and configure the standard
`openid`, email, and profile scopes.

- Authorized JavaScript origins: add the exact stable Vercel Preview origin
  and the production origin.
- Authorized redirect URI:
  `https://jdwlspxzoudgzxcghbjo.supabase.co/auth/v1/callback`

Copy the Google Client ID and Client Secret into Supabase only.

## 2. Supabase Dashboard

1. Open **Authentication → Providers → Google**.
2. Enable Google and enter the Google Client ID and Client Secret.
3. Open **Authentication → URL Configuration**.
4. Keep the production URL as the Site URL.
5. Add the stable Preview URL as an additional redirect URL, including all
   paths, for example `https://preview.example.com/**`.
6. If Vercel creates dynamic Preview URLs, add the narrow account-scoped
   wildcard recommended by Supabase, for example
   `https://*-<vercel-account-slug>.vercel.app/**`.

Do not add a wildcard redirect URI in Google Cloud. Google requires exact
authorized redirect URIs; Google redirects to Supabase, and Supabase then
redirects to the allow-listed app URL.

## 3. Apply the profile bootstrap migration

Apply:

`supabase/migrations/202608100001_google_sso_profile_bootstrap.sql`

The migration enriches the existing `auth.users` trigger so Google metadata
creates the minimal `bt_users` profile. Optional account details stay empty
until the user fills them from **Profile → Edit Profile → Private Account
Details**.

## 4. Vercel Preview variables

The Preview environment needs the existing public Supabase values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The Google Client Secret belongs only in Supabase and must not be copied to
Vercel.

## 5. Acceptance check

1. Open the Vercel Preview deployment in a private browser window.
2. Select **Sign In** or **Create Account**.
3. Select **Continue with Google**.
4. Complete Google consent.
5. Confirm the app returns to the same Preview origin and opens the terminal.
6. Open **Profile → Edit Profile** and confirm the private account fields can
   be completed and saved.

