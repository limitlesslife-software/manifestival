// Deno-liima delete-account-funktiolle. Kaikki logiikka on handler.js:ssä
// (testattu Nodessa); tämä tiedosto vain kytkee Denon ympäristön siihen.
//
// EI OLE DEPLOYATTU. Käyttöönotto on omistajan erillinen, kontrolloitu
// toimenpide (ks. supabase/functions/README.md).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleRequest } from './handler.js';

// Vain ne muuttujat, jotka handler oikeasti lukee -- ei koko ympäristöä.
const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEYS',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DELETE_ACCOUNT_ALLOWED_ORIGINS'
];

Deno.serve((request: Request) => {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return handleRequest(request, { env, createClient });
});
