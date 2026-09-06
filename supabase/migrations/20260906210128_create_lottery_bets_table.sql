/*
# Create lottery_bets table for auto-betting

1. New Tables
- `lottery_bets`
  - `id` (uuid, primary key) - bet record identifier
  - `session_id` (uuid) - links to lottery_sessions for the edge function
  - `lottery_id` (int) - which game (60/127/128)
  - `issue` (text) - the draw period this bet is for
  - `picks` (int array) - the digits bet on (个位)
  - `bet_amount` (numeric) - amount per number
  - `total_cost` (numeric) - bet_amount * picks.length
  - `status` (text) - pending / won / lost
  - `result_number` (int) - the actual drawn last digit
  - `payout` (numeric) - winnings if any
  - `net` (numeric) - payout - total_cost
  - `created_at` (timestamptz)
  - `settled_at` (timestamptz)
2. Security
- Enable RLS on `lottery_bets`.
- Allow anon + authenticated CRUD: the edge function (using service role key) manages rows,
  and the anon-key frontend only passes session IDs as opaque tokens. Policies are open
  because the edge function is the real access controller.
*/

CREATE TABLE IF NOT EXISTS lottery_bets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid,
  lottery_id int NOT NULL,
  issue text NOT NULL,
  picks int[] NOT NULL,
  bet_amount numeric NOT NULL,
  total_cost numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result_number int,
  payout numeric NOT NULL DEFAULT 0,
  net numeric NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  settled_at timestamptz
);

ALTER TABLE lottery_bets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_lottery_bets" ON lottery_bets;
CREATE POLICY "anon_select_lottery_bets" ON lottery_bets FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_lottery_bets" ON lottery_bets;
CREATE POLICY "anon_insert_lottery_bets" ON lottery_bets FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_lottery_bets" ON lottery_bets;
CREATE POLICY "anon_update_lottery_bets" ON lottery_bets FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_lottery_bets" ON lottery_bets;
CREATE POLICY "anon_delete_lottery_bets" ON lottery_bets FOR DELETE
  TO anon, authenticated USING (true);
