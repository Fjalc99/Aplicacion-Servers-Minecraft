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
 * Requiere iniciar sesión (web/auth.js). Hay dos roles: admin (todo) y amigo
 * (encender/apagar, consola, jugadores y backups). Los usuarios se crean con
 * "npm run usuarios". Por defecto solo escucha en 127.0.0.1; para acceder desde
 * fuera, ponlo detrás de un proxy con HTTPS (ver README, sección Caddy).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const { createAppCore } = require('../src/appCore');
const { userDataDir } = require('../src/paths');
const store = require('../src/store');
const javaProcess = require('../src/javaProcess');
const auth = require('./auth');
const access = require('./access');
const publicTunnel = require('./publicTunnel');

const SESSION_COOKIE = 'msm_session';

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

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** IP real del cliente. Si llega a través de un proxy local (Caddy), se usa X-Forwarded-For. */
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (isLoopback(remote)) {
    // Detrás de un proxy local (cloudflared, Caddy): la IP real viene en cabeceras.
    if (req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim();
    if (req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return remote;
}

/** ¿La petición llegó por HTTPS (directo o a través del proxy local)? */
function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' && isLoopback(req.socket.remoteAddress || '');
}

/**
 * Protección contra peticiones enviadas desde otras webs (CSRF): si el
 * navegador indica un Origin, tiene que ser esta misma dirección.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    return false;
  }
  if (host === req.headers.host) return true;
  // A través del túnel, el navegador está en https://algo.trycloudflare.com; se
  // acepta solo ese enlace concreto (el nuestro), no cualquier otro.
  const tunnelHost = publicTunnel.activeHost();
  return Boolean(tunnelHost) && host === tunnelHost && isLoopback(req.socket.remoteAddress || '');
}

function sessionCookie(token, req, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax (no Strict): así, abrir el enlace desde WhatsApp/Discord mantiene la
    // sesión. Las peticiones desde otras webs se frenan con la comprobación de origen.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * index.html de la app de escritorio, adaptado para el navegador: añade el
 * Electron simulado y preload.js justo antes de renderer.js, y permite la
 * conexión WebSocket en la política de seguridad de contenido.
 */
function buildIndexHtml(user) {
  let html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf-8');
  html = html.replace("default-src 'self';", "default-src 'self'; connect-src 'self' ws: wss:;");
  html = html.replace('</head>', '  <link rel="stylesheet" href="/web/roles.css" />\n</head>');
  // El rol va en el propio HTML para que los botones de admin no lleguen a verse
  // ni un instante. Es solo estético: los permisos se comprueban en el servidor.
  html = html.replace(
    '<body>',
    `<body data-role="${user.role}" data-commands="${user.role === 'admin' || user.canSendCommands ? 'si' : 'no'}" data-user="${user.username}" data-server-access="${user.role === 'admin' ? 'admin' : 'shared'}">`
  );
  html = html.replace(
    /(<script src="renderer\.js)/,
    '<script src="/web/electron-shim.js"></script>\n  <script src="/web/preload.js"></script>\n  <script src="/web/session.js"></script>\n  $1'
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
  // Enlaces de descarga de backups pendientes: token -> { username, filePath, fileName, expiresAt }
  const backupDownloads = new Map();

  // Canales de eventos que pertenecen a un servidor concreto: servers:log:<id>, etc.
  const SERVER_EVENT = /^servers:(?:log|exit|players|backupProgress):(.+)$/;

  function send(client, message) {
    if (client.readyState === 1) client.send(message);
  }

  /**
   * Envía un evento a todos los que pueden verlo: los de un servidor, solo a
   * quien tiene acceso a ese servidor; el resto (p. ej. progreso de exportar
   * mods, que solo usa el admin), solo a administradores salvo que se indique.
   */
  function broadcast(channel, payload, { serverId = null } = {}) {
    if (!wss) return;
    const match = channel.match(SERVER_EVENT);
    const id = serverId || (match ? match[1] : null);
    const server = id ? store.getServer(id) : null;
    const message = JSON.stringify({ channel, payload });
    for (const client of wss.clients) {
      if (!client.user) continue;
      if (id ? access.accessTo(client.user, server) : client.user.role === 'admin') send(client, message);
    }
  }

  function sendToUser(username, channel, payload) {
    if (!wss) return;
    const message = JSON.stringify({ channel, payload });
    for (const client of wss.clients) {
      if (client.user && client.user.username.toLowerCase() === username.toLowerCase()) send(client, message);
    }
  }

  publicTunnel.setUrlListener((url) => {
    broadcast('app:notify', url
      ? { title: 'Enlace público activo', body: `Pásaselo a tus amigos: ${url}` }
      : { title: 'Enlace público caído', body: 'El túnel de Cloudflare se ha cerrado. Actívalo de nuevo en Ajustes.' });
  });

  // ---------------------------------------------------------------------------
  // Cola de arranque: si un amigo pulsa Iniciar y el PC no tiene memoria libre,
  // su servidor espera su turno y arranca solo cuando se apague otro.
  // ---------------------------------------------------------------------------
  const startQueue = []; // [{ serverId, username, queuedAt }]

  function queuePosition(serverId) {
    const index = startQueue.findIndex((entry) => entry.serverId === serverId);
    return index === -1 ? null : index + 1;
  }

  function enqueueStart(serverId, username) {
    if (!queuePosition(serverId)) startQueue.push({ serverId, username, queuedAt: Date.now() });
    return queuePosition(serverId);
  }

  function activeUser(username) {
    const found = auth.listUsers().find((u) => u.username.toLowerCase() === username.toLowerCase() && u.status !== 'pendiente');
    return found ? { username: found.username, role: found.role, canSendCommands: found.canSendCommands } : null;
  }

  /** Arranca por orden lo que haya en la cola mientras quepa en la memoria. */
  function processStartQueue() {
    while (startQueue.length > 0) {
      const entry = startQueue[0];
      const server = store.getServer(entry.serverId);
      const user = activeUser(entry.username);
      if (!server || !user || javaProcess.isRunning(entry.serverId)) {
        startQueue.shift(); // borrado, cuenta borrada, o ya lo encendió alguien
        continue;
      }
      const decision = access.authorize(user, 'servers:start', entry.serverId, {
        allServers: store.listServers(),
        isRunning: (id) => javaProcess.isRunning(id),
      });
      if (!decision.ok && decision.code === 'ram') return; // sigue sin caber: se respeta el orden
      startQueue.shift();
      if (!decision.ok) {
        sendToUser(entry.username, 'app:notify', { title: 'Salió de la cola', body: `"${server.name}" no se ha podido encender: ${decision.error}` });
        continue;
      }
      try {
        core.handlers['servers:start'](entry.serverId, { user, reply: () => {} });
        sendToUser(entry.username, 'app:notify', { title: 'Tu turno', body: `"${server.name}" se está encendiendo.` });
      } catch (err) {
        sendToUser(entry.username, 'app:notify', { title: 'Salió de la cola', body: `"${server.name}" no se ha podido encender: ${err.message}` });
      }
    }
  }

  const queueTimer = setInterval(processStartQueue, 30000);
  queueTimer.unref();

  const core = createAppCore({
    send: (channel, payload) => {
      broadcast(channel, payload);
      // Al apagarse un servidor queda memoria libre: se revisa la cola.
      if (channel.startsWith('servers:exit:')) setTimeout(processStartQueue, 1500);
    },
    notify: (title, body, serverId) => broadcast('app:notify', { title, body }, { serverId }),
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

    // ---------- Cola de arranque ----------
    'servers:leaveQueue': (id, ctx) => {
      const index = startQueue.findIndex((entry) => entry.serverId === id);
      if (index === -1) return true;
      const entry = startQueue[index];
      if (ctx.user.role !== 'admin' && entry.username.toLowerCase() !== ctx.user.username.toLowerCase()) {
        throw new Error('Solo quien lo puso en la cola (o un administrador) puede quitarlo.');
      }
      startQueue.splice(index, 1);
      return true;
    },

    // ---------- Usuarios (solo admin: no están en las listas de amigos) ----------
    'users:list': () => auth.listUsers(),
    'users:approve': (username) => { auth.approveUser(username); return true; },
    'users:reject': (username) => { auth.rejectUser(username); return true; },
    'users:setRole': ({ username, role }) => { auth.setRole(username, role); return true; },
    'users:setCommands': ({ username, enabled }) => { auth.setCanSendCommands(username, enabled); return true; },
    'users:resetPassword': (username) => auth.resetPassword(username),
    'users:delete': (username, ctx) => {
      if (String(username).toLowerCase() === ctx.user.username.toLowerCase()) {
        throw new Error('No puedes borrar tu propia cuenta desde aquí.');
      }
      auth.removeUser(username);
      return true;
    },

    // ---------- Enlace público de la web (Cloudflare) ----------
    'webTunnel:status': () => ({ ...publicTunnel.status(), installed: Boolean(publicTunnel.findCloudflared()) }),
    'webTunnel:start': () => publicTunnel.start(),
    'webTunnel:stop': () => publicTunnel.stop(),
    'webTunnel:setAutostart': (enabled) => publicTunnel.setAutoStart(enabled),

    // ---------- Cuenta propia (cualquier usuario) ----------
    'account:changePassword': ({ current, next }, ctx) => {
      auth.changeOwnPassword(ctx.user.username, current, next);
      return true;
    },

    // En escritorio es "Guardar como"; aquí se genera un enlace de descarga de un
    // solo uso, válido 10 minutos y solo para quien lo pidió (los permisos ya se
    // han comprobado en access.authorize antes de llegar aquí).
    'servers:downloadBackup': ({ id, fileName }, ctx) => {
      try {
        const filePath = core.backupFilePath(id, fileName);
        for (const [old, entry] of backupDownloads) if (entry.expiresAt < Date.now()) backupDownloads.delete(old);
        const token = crypto.randomBytes(24).toString('hex');
        backupDownloads.set(token, {
          username: ctx.user.username,
          filePath,
          fileName,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        return { ok: true, downloadUrl: `/downloads/backup/${token}` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
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

  /**
   * Ajusta la respuesta según quién pregunta: cada uno solo ve los servidores a
   * los que tiene acceso (con un campo "access" para la interfaz), y lo que crea
   * un amigo queda a su nombre.
   */
  function afterInvoke(user, channel, result, arg) {
    if (channel === 'servers:list' && Array.isArray(result)) {
      return result.map((server) => access.withAccess(user, server)).filter(Boolean);
    }
    if (channel === 'servers:get') {
      return result ? access.withAccess(user, result) : result;
    }
    if (channel === 'servers:status' && result && typeof arg === 'string') {
      return { ...result, queuePosition: queuePosition(arg) };
    }
    if (channel === 'servers:create' && result && result.ok && result.server && user.role !== 'admin') {
      const saved = store.getServer(result.server.id);
      if (saved) {
        saved.owner = user.username;
        store.saveServer(saved);
        result = { ...result, server: access.withAccess(user, saved) };
      }
    }
    return result;
  }

  async function handleInvoke(req, res, user) {
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

    const decision = access.authorize(user, body.channel, body.arg, {
      allServers: store.listServers(),
      isRunning: (id) => javaProcess.isRunning(id),
    });
    if (!decision.ok) {
      if (decision.code === 'ram' && body.channel === 'servers:start') {
        const position = enqueueStart(access.serverIdFromArg(body.arg), user.username);
        sendJson(res, 200, { result: { queued: true, position } });
        return;
      }
      sendJson(res, decision.status, { error: decision.error });
      return;
    }

    try {
      let result = await handler(decision.arg, {
        user,
        reply: (channel, payload) => sendToUser(user.username, channel, payload),
      });
      result = afterInvoke(user, body.channel, result, decision.arg);
      sendJson(res, 200, { result });
    } catch (err) {
      // Igual que en Electron: el error llega a la interfaz como una promesa rechazada.
      sendJson(res, 500, { error: err.message });
    }
  }

  async function handleLogin(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const result = auth.login(body.username, body.password, clientIp(req));
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(result.token, req, 7 * 24 * 60 * 60));
    sendJson(res, 200, { user: result.user });
  }

  async function handleRegister(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
      auth.register({ username: body.username, password: body.password }, clientIp(req));
      broadcast('app:notify', { title: 'Nueva cuenta pendiente', body: `"${body.username}" quiere entrar. Apruébala en Ajustes → Usuarios.` });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
    }
  }

  async function handleSetup(req, res) {
    try {
      const body = await readJsonBody(req);
      auth.createFirstAdmin({ username: body.username, password: body.password, code: body.code });
      const result = auth.login(body.username, body.password, clientIp(req));
      res.setHeader('Set-Cookie', sessionCookie(result.token, req, 7 * 24 * 60 * 60));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // Cloudflare también responde por http://; si alguien entra así, a https.
    // El host público puede venir en X-Forwarded-Host; si no, es el del túnel activo.
    if (req.headers['x-forwarded-proto'] === 'http' && isLoopback(req.socket.remoteAddress || '')) {
      const publicHost = req.headers['x-forwarded-host'] || publicTunnel.activeHost() || req.headers.host;
      res.writeHead(301, { Location: `https://${publicHost}${req.url}` });
      res.end();
      return;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (req.method === 'POST' && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'Origen no permitido.' });
      return;
    }

    // ---------- Rutas públicas (sin sesión) ----------

    // Mientras no haya administrador, todo lleva a la página de configuración inicial.
    if (!auth.hasAdmin()) {
      if (req.method === 'POST' && pathname === '/api/setup') {
        handleSetup(req, res);
        return;
      }
      if (req.method === 'GET' && (pathname === '/setup' || pathname === '/' || pathname === '/login')) {
        if (pathname !== '/setup') {
          res.writeHead(302, { Location: '/setup' });
          res.end();
          return;
        }
        sendFile(res, path.join(PUBLIC_DIR, 'setup.html'));
        return;
      }
    } else if (pathname === '/setup') {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      handleLogin(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/register') {
      handleRegister(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/login') {
      sendFile(res, path.join(PUBLIC_DIR, 'login.html'));
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      sendFile(res, path.join(ROOT, 'build', 'icon.png'));
      return;
    }
    if (req.method === 'GET' && ['/web/login.css', '/web/login.js', '/web/setup.js'].includes(pathname)) {
      sendFile(res, path.join(PUBLIC_DIR, path.basename(pathname)));
      return;
    }

    // ---------- A partir de aquí, hace falta sesión ----------
    const token = parseCookies(req)[SESSION_COOKIE];
    const user = auth.userForSession(token);

    if (req.method === 'POST' && pathname === '/api/logout') {
      if (token) auth.destroySession(token);
      res.setHeader('Set-Cookie', sessionCookie('', req, 0));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!user) {
      if (pathname.startsWith('/api/')) {
        sendJson(res, 401, { error: 'Tu sesión ha caducado. Vuelve a iniciar sesión.' });
      } else if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(302, { Location: '/login' });
        res.end();
      } else {
        res.writeHead(401);
        res.end();
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      sendJson(res, 200, { user });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/invoke') {
      handleInvoke(req, res, user);
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(buildIndexHtml(user));
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

    if (pathname.startsWith('/downloads/backup/')) {
      const token = pathname.slice('/downloads/backup/'.length);
      const entry = backupDownloads.get(token);
      backupDownloads.delete(token); // un solo uso
      if (!entry || entry.expiresAt < Date.now() || entry.username.toLowerCase() !== user.username.toLowerCase()) {
        res.writeHead(404);
        res.end('Enlace caducado o no válido. Vuelve a pulsar "Descargar".');
        return;
      }
      fs.stat(entry.filePath, (err, stat) => {
        if (err) { res.writeHead(404); res.end('No encontrado'); return; }
        const asciiName = entry.fileName.replace(/[^\w.\-]+/g, '_');
        res.writeHead(200, {
          'Content-Type': MIME['.zip'],
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`,
        });
        fs.createReadStream(entry.filePath).pipe(res);
      });
      return;
    }

    if (pathname.startsWith('/downloads/')) {
      if (user.role !== 'admin') { res.writeHead(403); res.end(); return; }
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

  // El WebSocket también exige sesión válida y mismo origen.
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const user = auth.userForSession(parseCookies(req)[SESSION_COOKIE]);
    if (pathname !== '/ws' || !user || !sameOrigin(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      ws.sessionToken = parseCookies(req)[SESSION_COOKIE];
      wss.emit('connection', ws, req);
    });
  });

  // Cada 30 s se revisan las conexiones abiertas: si la sesión ya no vale
  // (usuario borrado, contraseña cambiada, caducada) se cierra, y si cambió su
  // rol o permisos se actualiza.
  const sweep = setInterval(() => {
    for (const client of wss.clients) {
      const current = auth.userForSession(client.sessionToken);
      if (!current) client.terminate();
      else client.user = current;
    }
  }, 30000);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));

  server.on('close', () => clearInterval(queueTimer));
  return { server, broadcast, sendToUser, processStartQueue, startQueue };
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

    publicTunnel.stop();
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
  require('../src/duckdns').startUpdater();
  publicTunnel.setLocalPort(port);

  server.listen(port, host, () => {
    console.log('Minecraft Server Manager (versión web)');
    console.log(`  Abre en el navegador:  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  Carpeta de datos:      ${userDataDir()}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log('  ⚠ AVISO: escuchando fuera de este equipo SIN HTTPS: las contraseñas viajarían sin cifrar.');
      console.log('    Para acceder desde internet usa Caddy delante (ver README) y deja HOST=127.0.0.1.');
    }
    const code = auth.getSetupCode();
    if (code) {
      console.log('');
      console.log('  Todavía no hay administrador. Abre la web en este PC y crea el tuyo');
      console.log(`  con este código de configuración:  ${code}`);
      console.log('');
    }
    console.log('  Ctrl+C para salir (se detendrán antes los servidores en marcha).');

    if (publicTunnel.status().autoStart) {
      console.log('  Activando el enlace público de Cloudflare…');
      publicTunnel.start().then((st) => {
        if (st.url) console.log(`  Enlace público para tus amigos:  ${st.url}`);
        else if (st.error) console.log(`  ⚠ ${st.error}`);
      });
    }
  });

  installGracefulShutdown(server);
}

module.exports = { createWebServer, safeJoin, clientIp };
