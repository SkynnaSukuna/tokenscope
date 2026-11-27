'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Намеренно используется /tokenscope/: так видны ошибки путей репозитория Pages.
function createPreview(root = path.resolve(__dirname, '../dist'), prefix = '/tokenscope/') {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === prefix.slice(0, -1)) {
      res.writeHead(302, { Location: prefix }); return res.end();
    }
    if (!pathname.startsWith(prefix)) { res.writeHead(404); return res.end('Not found'); }
    let relative;
    try { relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html'; }
    catch { res.writeHead(400); return res.end('Invalid path'); }
    const file = path.resolve(root, relative);
    const check = path.relative(root, file);
    if (check.startsWith('..') || path.isAbsolute(check)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end('Not found. Run npm run build first.'); }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
}
if (require.main === module) {
  const port = Number(process.env.PREVIEW_PORT || 4173);
  createPreview().listen(port, '127.0.0.1', () => console.log(`TokenScope Pages preview → http://127.0.0.1:${port}/tokenscope/`));
}
module.exports = { createPreview };
