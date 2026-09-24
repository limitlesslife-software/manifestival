// Supabase-projektin julkiset tunnisteet.
//
// Nämä EIVÄT ole salaisuuksia. Supabasen anon-avain on suunniteltu
// julkiseksi: se päätyy joka tapauksessa jokaiselle selaimelle. Ainoa
// todellinen pääsynvalvonta on tietokannan RLS-politiikka.
// Ks. docs/SECURITY.md.
//
// Salaisuudet (kuten ANTHROPIC_API_KEY) elävät vain palvelimella Vercelin
// ympäristömuuttujina eivätkä koskaan tässä tiedostossa.

export const SUPABASE_URL = 'https://twpyubcymdnbvelsjidg.supabase.co';

export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3cHl1YmN5bWRuYnZlbHNqaWRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTg1MTEsImV4cCI6MjEwMDgzNDUxMX0.ych4lT7elajj3H12smhi2wjP-CP1dYrqtKhoK1RoSYQ';

/** Sovelluksen oman palvelinpuolen päätepisteet. */
export const API = Object.freeze({
  parse: '/api/parse',
  /**
   * Kuitin ja laskun kuvan luenta.
   *
   * KUVA KULKEE LÄPI, EI TALTEEN. Päätepiste ei tallenna kuvaa
   * mihinkään. Ks. api/extract.js ja src/app/receiptCapture.js.
   */
  extract: '/api/extract'
});
