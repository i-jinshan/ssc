/*
# Create lottery_sessions table

1. New Tables
- `lottery_sessions`
  - `id` (uuid, primary key) - session identifier passed between client and edge function
  - `cookies` (text) - cookie jar from the lottery site, updated as the session progresses
  - `form_token` (text) - antiforgery token extracted from the login form
  - `captcha_de_text` (text) - captcha challenge token needed for login submission
  - `authenticated` (boolean, default false) - whether the session has successfully logged in
  - `created_at` (timestamptz) - when the session was created
2. Security
- Enable RLS on `lottery_sessions`.
- Allow anon + authenticated CRUD: the edge function (using the service role key) manages rows,
  and the anon-key frontend only passes session IDs as opaque tokens — it never reads the table
  directly. Policies are open because the edge function is the real access controller.
*/

CREATE TABLE IF NOT EXISTS lottery_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cookies text NOT NULL DEFAULT '',
  form_token text,
  captcha_de_text text,
  authenticated boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE lottery_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_lottery_sessions" ON lottery_sessions;
CREATE POLICY "anon_select_lottery_sessions" ON lottery_sessions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_lottery_sessions" ON lottery_sessions;
CREATE POLICY "anon_insert_lottery_sessions" ON lottery_sessions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_lottery_sessions" ON lottery_sessions;
CREATE POLICY "anon_update_lottery_sessions" ON lottery_sessions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_lottery_sessions" ON lottery_sessions;
CREATE POLICY "anon_delete_lottery_sessions" ON lottery_sessions FOR DELETE
  TO anon, authenticated USING (true);
