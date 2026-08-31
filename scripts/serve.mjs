// Riippuvuudeton staattinen kehityspalvelin.
//
// Sovellus käyttää ES-moduuleita, joten sitä ei voi avata file://-osoitteesta.
// Tämä palvelin ei asenna mitään eikä vaadi verkkoyhteyttä.
//
//   npm run serve      ->  http://localhost:3000
//
// HUOM: /api/parse ei toimi tässä. Se on Vercelin serverless-funktio.
// Puheohjaus tallentaa komennon raakatekstinä ilman jäsennystä.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.sql': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);

  // Estetään hakemistosta ulos osoittavat polut.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (urlPath.startsWith('/api/')) {
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' })
       .end(JSON.stringify({ error: '/api/* vaatii Vercelin ajoympäristön' }));
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(data);
  });
});

server.listen(PORT, () => {
  console.log('Manifestival: http://localhost:' + PORT);
  console.log('Lopeta: Ctrl+C');
});
