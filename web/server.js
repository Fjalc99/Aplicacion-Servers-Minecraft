/**
 * Versión web de Minecraft Server Manager.
 *
 * Reutiliza tal cual:
 *   - src/            (el motor: servidores, mods, backups...), vía src/appCore.js
 *   - renderer/       (la interfaz de la app de escritorio)
 *   - preload.js      (la definición de window.api), que se ejecuta en el
 *                     navegador sobre un "Electron" simulado (web/public/electron-shim.js)
 *
 * Las llamadas de la interfaz llegan por POST /api/invoke y los eventos en vivo
 * (consola, jugadores, progreso, caídas) salen por WebSocket.
 *
 * AVISO: esta versión no tiene login. Por defecto solo escucha en 127.0.0.1
 * (este mismo equipo). No la expongas a la red ni a internet todavía.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const { createAppCore } = require('../src/appCore');
const { userDataDir } = require('../src/paths');
const store = require('../src/store');
const javaProcess = require('../src/javaProcess');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'renderer');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 20 * 1024 * 1024; // los resultados de un análisis de muchos mods pueden ser grandes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

function exportsDir() {
  const dir = path.join(userDataDir(), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Abre una ruta en el explorador de archivos de ESTE equipo (solo tiene sentido en local). */
function openInFileManager(target, { select = false } = {}) {
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = 'explorer';
    args = select ? [`/select,${target}`] : [target];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = select ? ['-R', target] : [target];
  } else {
    cmd = 'xdg-open';
    args = [select ? path.dirname(target) : target];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // sin explorador disponible (p. ej. servidor sin escritorio): se ignora
  child.unref();
}

/** Devuelve la ruta absoluta dentro de baseDir, o null si la petición intenta salirse (../). */
function safeJoin(baseDir, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const full = path.resolve(baseDir, '.' + path.posix.normalize('/' + decoded));
  const base = path.resolve(baseDir) + path.sep;
  return full.startsWith(base) ? full : null;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value === undefined ? null : value));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Petición demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
      } catch (err) {
        reject(new Error('JSON no válido'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * index.html de la app de escritorio, adaptado para el navegador: añade el
 * Electron simulado y preload.js justo antes de renderer.js, y permite la
 * conexión WebSocket en la política de seguridad de contenido.
 */
function buildIndexHtml() {
  let html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf-8');
  html = html.replace("default-src 'self';", "default-src 'self'; connect-src 'self' ws: wss:;");
  html = html.replace(
    /(<script src="renderer\.js)/,
    '<script src="/web/electron-shim.js"></script>\n  <script src="/web/preload.js"></script>\n  $1'
  );
  return html;
}

/** preload.js envuelto para ejecutarse en el navegador con el require() simulado. */
function buildBrowserPreload() {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf-8');
  return `(function (require) {\n${source}\n})(window.__msmRequire);\n`;
}

function createWebServer() {
  let wss = null;

  function broadcast(channel, payload) {
    if (!wss) return;
    const message = JSON.stringify({ channel, payload });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(message);
    }
  }

  const core = createAppCore({
    send: broadcast,
    notify: (title, body) => broadcast('app:notify', { title, body }),
  });

  // Mismos canales que la app de escritorio + versiones web de los que allí
  // usan diálogos nativos. Los selectores de carpeta se resuelven en el propio
  // navegador (ver electron-shim.js), así que no aparecen aquí.
  const handlers = {
    ...core.handlers,

    'servers:openFolder': (id) => {
      const server = store.getServer(id);
      if (server) openInFileManager(server.dir);
      return null;
    },

    'mods:showInFolder': (filePath) => {
      openInFileManager(filePath, { select: true });
      return true;
    },

    'mods:exportZip': async ({ serverId, results }, ctx) => {
      try {
        const server = store.getServer(serverId);
        const baseName = server ? `mods-${server.name.replace(/[^\w\-]+/g, '_')}` : 'mods-servidor';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${baseName}-${stamp}.zip`;
        const result = await core.buildModsZip(results, path.join(exportsDir(), fileName), (info) =>
          ctx.reply('mods:exportProgress', info)
        );
        if (result.ok) result.downloadUrl = `/downloads/${encodeURIComponent(fileName)}`;
        return result;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };

  async function handleInvoke(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const handler = handlers[body.channel];
    if (!handler) {
      sendJson(res, 404, { error: `Operación desconocida: ${body.channel}` });
      return;
    }

    try {
      const result = await handler(body.arg, { reply: broadcast });
      sendJson(res, 200, { result });
    } catch (err) {
      // Igual que en Electron: el error llega a la interfaz como una promesa rechazada.
      sendJson(res, 500, { error: err.message });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'POST' && pathname === '/api/invoke') {
      handleInvoke(req, res);
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(buildIndexHtml());
      return;
    }

    if (pathname === '/web/preload.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      res.end(buildBrowserPreload());
      return;
    }

    if (pathname.startsWith('/web/')) {
      const file = safeJoin(PUBLIC_DIR, pathname.slice('/web/'.length));
      if (file) sendFile(res, file);
      else { res.writeHead(403); res.end(); }
      return;
    }

    if (pathname.startsWith('/downloads/')) {
      const fileName = path.basename(decodeURIComponent(pathname.slice('/downloads/'.length)));
      const file = path.join(exportsDir(), fileName);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('No encontrado'); return; }
      res.writeHead(200, {
        'Content-Type': MIME['.zip'],
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // Resto: archivos de la interfaz (style.css, renderer.js...)
    const file = safeJoin(RENDERER_DIR, pathname);
    if (file) sendFile(res, file);
    else { res.writeHead(403); res.end(); }
  });

  wss = new WebSocketServer({ server, path: '/ws' });

  return { server, broadcast };
}

/**
 * Al cerrar con Ctrl+C: si hay servidores de Minecraft en marcha, les manda
 * "stop" y espera a que guarden el mundo (hasta 60 s) antes de salir, para no
 * cortarlos a lo bruto.
 */
function installGracefulShutdown(httpServer) {
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) {
      console.log('\nSaliendo sin esperar más.');
      process.exit(1);
    }
    shuttingDown = true;

    const running = store.listServers().filter((s) => javaProcess.isRunning(s.id));
    if (running.length > 0) {
      console.log(`\nDeteniendo ${running.length} servidor(es) de Minecraft para que guarden el mundo... (Ctrl+C otra vez para forzar)`);
      for (const s of running) javaProcess.stopServer(s.id, { force: false });

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && running.some((s) => javaProcess.isRunning(s.id))) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    httpServer.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 3000;
  const { server } = createWebServer();

  server.listen(port, host, () => {
    console.log('Minecraft Server Manager (versión web)');
    console.log(`  Abre en el navegador:  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  Carpeta de datos:      ${userDataDir()}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log('  ⚠ AVISO: estás escuchando fuera de este equipo y esta versión NO tiene login.');
    }
    console.log('  Ctrl+C para salir (se detendrán antes los servidores en marcha).');
  });

  installGracefulShutdown(server);
}

module.exports = { createWebServer, safeJoin };
