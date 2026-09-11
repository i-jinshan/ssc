/*
# Add captcha_code and login_token columns to lottery_sessions

1. Modified Tables
- `lottery_sessions`
  - `captcha_code` (text, nullable) - stores the user-entered captcha code from step 1, reused in step 2 login
  - `login_token` (text, nullable) - stores the JWT-like auth token returned by /api/Token/Login
2. Security
- No RLS policy changes. The columns are accessible via the same existing open policies.
*/

ALTER TABLE lottery_sessions ADD COLUMN IF NOT EXISTS captcha_code text;
ALTER TABLE lottery_sessions ADD COLUMN IF NOT EXISTS login_token text;
