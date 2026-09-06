const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// VITE_API_MODE=local  → use local Vite middleware (npm start on your own server)
// VITE_API_MODE=cloud  → use Supabase Edge Function (Bolt hosting)
// unset               → cloud if VITE_SUPABASE_URL exists, otherwise local
const useCloud =
  import.meta.env.VITE_API_MODE === 'cloud' ||
  (import.meta.env.VITE_API_MODE !== 'local' && Boolean(SUPABASE_URL));

export const API_URL = useCloud
  ? `${SUPABASE_URL}/functions/v1/lottery-proxy`
  : '/api/lottery';

export const API_HEADERS: Record<string, string> = useCloud
  ? {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    }
  : { 'Content-Type': 'application/json' };
