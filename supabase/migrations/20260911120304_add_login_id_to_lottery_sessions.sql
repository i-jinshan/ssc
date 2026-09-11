/*
# Add login_id column to lottery_sessions

1. Modified Tables
- `lottery_sessions`
  - `login_id` (text, nullable) - stores the username entered in step 1 of the 星亿娱乐 two-step login flow,
    so step 2 can submit it together with the password without the user re-entering it.
2. Security
- No RLS policy changes. The column is accessible via the same existing open policies.
*/

ALTER TABLE lottery_sessions ADD COLUMN IF NOT EXISTS login_id text;
