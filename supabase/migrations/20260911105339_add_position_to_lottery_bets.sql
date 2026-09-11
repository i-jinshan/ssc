ALTER TABLE lottery_bets ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 5;
COMMENT ON COLUMN lottery_bets.position IS '1=万 2=千 3=百 4=十 5=个';
