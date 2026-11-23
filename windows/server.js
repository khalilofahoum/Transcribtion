// Windows launcher: serves the app on this computer only and opens it in its own window.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app');
const PORT = 47615;
const APP_URL = `http://localhost:${PORT}/`;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => fs.existsSync(p));
}

function openWindow(ownsServer) {
  const browser = findBrowser();
  if (!browser) {
    spawn('cmd', ['/c', 'start', '', APP_URL], { stdio: 'ignore', detached: true }).unref();
    if (!ownsServer) process.exit(0);
    return; // no dedicated window to watch: keep serving until this console is closed
  }
  // A dedicated profile keeps the microphone permission and lets us know when the window closes.
  const profile = path.join(process.env['LOCALAPPDATA'] || __dirname, 'TranscriberApp', 'profile');
  const child = spawn(browser, [
    `--app=${APP_URL}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=560,860',
  ], { stdio: 'ignore' });
  child.on('exit', () => process.exit(0));
  child.on('error', () => process.exit(1));
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') openWindow(false); // already running: just bring up the window
  else { console.error(err.message); process.exit(1); }
});
server.listen(PORT, '127.0.0.1', () => {
  if (process.argv.includes('--no-window')) console.log('Serving ' + APP_URL);
  else openWindow(true);
});
