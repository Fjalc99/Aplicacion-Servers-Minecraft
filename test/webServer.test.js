const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { tmpDir } = require('./helpers');

// La web guarda los datos en DATA_DIR: se usa una carpeta temporal para no
// tocar los servidores ni los usuarios reales de quien ejecute los tests.
process.env.DATA_DIR = tmpDir('msm-web-');

const auth = require('../web/auth');
const store = require('../src/store');
const { createWebServer, safeJoin, clientIp } = require('../web/server');
const publicTunnel = require('../web/publicTunnel');

auth.addUser({ username: 'admin', password: 'clave-admin', role: 'admin' });
auth.addUser({ username: 'amigo', password: 'clave-amigo', role: 'amigo' });
auth.addUser({ username: 'amigocmd', password: 'clave-amigocmd', role: 'amigo', canSendCommands: true });
auth.addUser({ username: 'lleno', password: 'clave-lleno', role: 'amigo' });

// Servidores de prueba (no se arrancan): uno del admin (compartido), uno de
// "amigo", uno de "ana" y dos de "lleno" (ya en su límite).
const fake = (id, owner) => ({
  id, name: id, loader: 'vanilla', mcVersion: '1.21.1', dir: path.join(process.env.DATA_DIR, id),
  memory: 1024, properties: { 'server-port': 25565, 'level-name': 'world' },
  launch: { type: 'jar', value: 'server.jar' }, createdAt: new Date().toISOString(),
  ...(owner ? { owner } : {}),
});
store.saveServer(fake('compartido'));
store.saveServer(fake('deamigo', 'amigo'));
store.saveServer(fake('deana', 'ana'));
store.saveServer(fake('lleno1', 'lleno'));
store.saveServer(fake('lleno2', 'lleno'));

let server;
let broadcast;
let base;
let processStartQueue;
let startQueue;

test.before(async () => {
  ({ server, broadcast, processStartQueue, startQueue } = createWebServer());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login de ${username}`);
  return res.headers.get('set-cookie').split(';')[0]; // "msm_session=..."
}

async function invoke(cookie, channel, arg, extraHeaders = {}) {
  const res = await fetch(`${base}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: JSON.stringify({ channel, arg }),
  });
  return { status: res.status, body: await res.json() };
}

test('safeJoin no deja salir de la carpeta base', () => {
  const dir = path.resolve('/srv/app/renderer');
  assert.equal(safeJoin(dir, 'style.css'), path.join(dir, 'style.css'));
  assert.ok(safeJoin(dir, '../package.json').startsWith(dir + path.sep));
  assert.ok(safeJoin(dir, '..%2F..%2Fpackage.json').startsWith(dir + path.sep));
});

test('sin sesión: la API da 401, la portada lleva al login y el login es accesible', async () => {
  assert.equal((await invoke(null, 'servers:list')).status, 401);

  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');

  assert.equal((await fetch(`${base}/login`)).status, 200);
  assert.equal((await fetch(`${base}/renderer.js`)).status, 401);
});

test('login con contraseña incorrecta falla', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'no-es-esta' }),
  });
  assert.equal(res.status, 401);
});

test('admin: resultados, 404 para canales desconocidos y 500 con el mensaje de error', async () => {
  const cookie = await login('admin', 'clave-admin');

  const list = await invoke(cookie, 'servers:list');
  assert.equal(list.status, 200);
  assert.equal(list.body.result.length, 5); // el admin los ve todos

  assert.equal((await invoke(cookie, 'no:existe')).status, 404);

  const failing = await invoke(cookie, 'servers:listBackups', 'id-inexistente');
  assert.equal(failing.status, 500);
  assert.match(failing.body.error, /no encontrado/i);
});

test('amigo: puede lo básico y se le deniega lo de administrador', async () => {
  const cookie = await login('amigo', 'clave-amigo');

  assert.equal((await invoke(cookie, 'servers:list')).status, 200);
  assert.equal((await invoke(cookie, 'servers:stop', { id: 'compartido', force: false })).status, 200);

  for (const [channel, arg] of [
    ['servers:delete', { id: 'compartido', deleteFiles: true }],
    ['servers:restoreBackup', { id: 'compartido', fileName: 'a.zip' }],
    ['servers:sendCommand', { id: 'compartido', command: 'op amigo' }],
    ['servers:stop', { id: 'compartido', force: true }],
    ['servers:import', { folderPath: '/' }],
    ['servers:importWorld', { serverId: 'deamigo', worldFolder: '/' }],
  ]) {
    const res = await invoke(cookie, channel, arg);
    assert.equal(res.status, 403, channel);
  }
});

test('amigo con permiso de comandos pasa el control de permisos', async () => {
  const cookie = await login('amigocmd', 'clave-amigocmd');
  // El servidor no existe/no está en marcha, así que falla después (500), pero ya no por permisos (403).
  const res = await invoke(cookie, 'servers:sendCommand', { id: 'compartido', command: 'say hola' });
  assert.equal(res.status, 500);
});

test('cada amigo ve los compartidos y los suyos, pero no los de otros', async () => {
  const cookie = await login('amigo', 'clave-amigo');
  const list = (await invoke(cookie, 'servers:list')).body.result;
  const byId = Object.fromEntries(list.map((srv) => [srv.id, srv.access]));
  assert.deepEqual(byId, { compartido: 'shared', deamigo: 'owner' });

  assert.equal((await invoke(cookie, 'servers:get', 'deana')).status, 404);
  assert.equal((await invoke(cookie, 'servers:start', 'deana')).status, 404);
  assert.equal((await invoke(cookie, 'servers:delete', { id: 'deana', deleteFiles: true })).status, 404);

  // En el suyo sí puede hacer cosas de "dueño"
  assert.equal((await invoke(cookie, 'servers:updateMemory', { id: 'deamigo', memory: 2048 })).status, 200);
  assert.equal((await invoke(cookie, 'servers:updateMemory', { id: 'deamigo', memory: 99999 })).status, 403);
});

test('página de inicio: los amigos ven estado y dirección, pero solo el admin cambia la dirección', async () => {
  const amigo = await login('amigo', 'clave-amigo');
  const status = await invoke(amigo, 'servers:status', 'compartido');
  assert.equal(status.status, 200);
  assert.equal(status.body.result.state, 'offline');
  assert.equal((await invoke(amigo, 'servers:status', 'deana')).status, 404);
  assert.equal((await invoke(amigo, 'app:connectionInfo')).status, 200);
  assert.equal((await invoke(amigo, 'app:setPublicAddress', 'hackeado.example')).status, 403);

  const admin = await login('admin', 'clave-admin');
  assert.equal((await invoke(admin, 'app:setPublicAddress', 'tuservidor.duckdns.org')).status, 200);
  assert.equal((await invoke(amigo, 'app:connectionInfo')).body.result.publicAddress, 'tuservidor.duckdns.org');
});

test('DuckDNS: solo el admin puede verlo o cambiarlo', async () => {
  const amigo = await login('amigo', 'clave-amigo');
  for (const channel of ['app:getDuckDns', 'app:setDuckDns', 'app:updateDuckDnsNow', 'app:removeDuckDns']) {
    assert.equal((await invoke(amigo, channel, {})).status, 403, channel);
  }
  const admin = await login('admin', 'clave-admin');
  assert.equal((await invoke(admin, 'app:getDuckDns')).body.result.configured, false);
});

test('registro desde la web: pendiente, el admin lo aprueba y ya puede entrar', async () => {
  const reg = await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nuevo', password: 'clave-nuevo-1' }),
  });
  assert.equal(reg.status, 200);

  const early = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nuevo', password: 'clave-nuevo-1' }),
  });
  assert.equal(early.status, 403);

  const amigo = await login('amigo', 'clave-amigo');
  assert.equal((await invoke(amigo, 'users:list')).status, 403);
  assert.equal((await invoke(amigo, 'users:approve', 'nuevo')).status, 403);

  const admin = await login('admin', 'clave-admin');
  const pending = (await invoke(admin, 'users:list')).body.result.find((u) => u.username === 'nuevo');
  assert.equal(pending.status, 'pendiente');
  assert.ok(!('hash' in pending) && !('salt' in pending));
  assert.equal((await invoke(admin, 'users:approve', 'nuevo')).status, 200);
  await login('nuevo', 'clave-nuevo-1');

  assert.equal((await invoke(admin, 'users:delete', 'admin')).status, 500); // no puede borrarse a sí mismo
  const temporary = (await invoke(admin, 'users:resetPassword', 'nuevo')).body.result;
  const nuevo = await login('nuevo', temporary);
  assert.equal((await invoke(nuevo, 'account:changePassword', { current: temporary, next: 'mi-clave-nueva' })).status, 200);
  await login('nuevo', 'mi-clave-nueva');
});

test('playit: solo el admin pone la dirección de cada servidor, y todos la ven', async () => {
  const amigo = await login('amigo', 'clave-amigo');
  assert.equal((await invoke(amigo, 'servers:setJoinAddress', { id: 'compartido', address: 'x.joinmc.link' })).status, 403);

  const admin = await login('admin', 'clave-admin');
  assert.equal((await invoke(admin, 'servers:setJoinAddress', { id: 'compartido', address: 'mi-tunel.joinmc.link' })).status, 200);
  assert.equal((await invoke(admin, 'servers:setJoinAddress', { id: 'compartido', address: 'no vale' })).status, 500);
  assert.equal((await invoke(amigo, 'servers:status', 'compartido')).body.result.joinAddress, 'mi-tunel.joinmc.link');
});

test('enlace público: solo admin, y a través del túnel se acepta su origen pero no otros', async () => {
  const amigo = await login('amigo', 'clave-amigo');
  for (const channel of ['webTunnel:status', 'webTunnel:start', 'webTunnel:stop', 'webTunnel:setAutostart']) {
    assert.equal((await invoke(amigo, channel)).status, 403, channel);
  }

  const st = await publicTunnel.start({
    launcher: { command: process.execPath, prefixArgs: [path.join(__dirname, '..', 'test-fixtures', 'fake-cloudflared.js')] },
  });
  try {
    const tunnelOrigin = st.url;
    const admin = await login('admin', 'clave-admin');
    // Como llegaría desde cloudflared: Host local, Origin del enlace público
    assert.equal((await invoke(admin, 'servers:list', undefined, { Origin: tunnelOrigin })).status, 200);
    assert.equal((await invoke(admin, 'servers:list', undefined, { Origin: 'https://otro-ajeno.trycloudflare.com' })).status, 403);
  } finally {
    publicTunnel.stop();
  }
  const admin = await login('admin', 'clave-admin');
  assert.equal((await invoke(admin, 'servers:list', undefined, { Origin: st.url })).status, 403); // ya no está activo
});

test('detrás de Cloudflare: IP real de Cf-Connecting-Ip y http:// redirige a https://', async () => {
  const fakeReq = (headers, remoteAddress) => ({ headers, socket: { remoteAddress } });
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '198.51.100.9' }, '127.0.0.1')), '198.51.100.9');
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, '::1')), '198.51.100.7');
  // Si no llega por un proxy local, las cabeceras no se creen (se podrían falsificar)
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '1.1.1.1' }, '203.0.113.5')), '203.0.113.5');

  const res = await fetch(`${base}/login`, {
    redirect: 'manual',
    headers: { 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'algo.trycloudflare.com' },
  });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://algo.trycloudflare.com/login');
});

test('cola: si no hay memoria, el arranque espera y sale solo cuando se libera', async () => {
  const os = require('os');
  const javaProcess = require('../src/javaProcess');
  const original = { isRunning: javaProcess.isRunning, startServer: javaProcess.startServer };
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const big = Math.floor(totalMb * 0.6); // dos de estos no caben a la vez
  store.saveServer({ ...fake('grande1'), memory: big });
  store.saveServer({ ...fake('grande2'), memory: big });

  let running = new Set(['grande1']);
  const started = [];
  javaProcess.isRunning = (id) => running.has(id);
  javaProcess.startServer = (server) => { started.push(server.id); running.add(server.id); };
  try {
    const amigo = await login('amigo', 'clave-amigo');
    const res = await invoke(amigo, 'servers:start', 'grande2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, { queued: true, position: 1 });
    assert.equal((await invoke(amigo, 'servers:status', 'grande2')).body.result.queuePosition, 1);

    // Puede salir de la cola...
    await invoke(amigo, 'servers:leaveQueue', 'grande2');
    assert.equal((await invoke(amigo, 'servers:status', 'grande2')).body.result.queuePosition, null);

    // ...y volver a entrar. Al apagarse el otro, arranca solo.
    await invoke(amigo, 'servers:start', 'grande2');
    processStartQueue();
    assert.deepEqual(started, [], 'mientras el otro siga encendido, espera');
    running.delete('grande1');
    processStartQueue();
    assert.deepEqual(started, ['grande2']);
    assert.equal(startQueue.length, 0);
  } finally {
    Object.assign(javaProcess, original);
    store.deleteServer('grande1');
    store.deleteServer('grande2');
  }
});

test('crear servidor: se deniega antes de descargar nada si está en su límite', async () => {
  const cookie = await login('lleno', 'clave-lleno');
  const res = await invoke(cookie, 'servers:create', { name: 'Otro', loader: 'vanilla', mcVersion: '1.21.1', memory: 1024 });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /máximo/);
});

test('la portada marca el rol para ocultar los controles de admin', async () => {
  const cookie = await login('amigo', 'clave-amigo');
  const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
  assert.match(html, /data-role="amigo"/);
  assert.match(html, /data-commands="no"/);
  assert.match(html, /\/web\/roles\.css/);

  const shim = html.indexOf('/web/electron-shim.js');
  const preload = html.indexOf('/web/preload.js');
  const renderer = html.indexOf('renderer.js');
  assert.ok(shim > 0 && shim < preload && preload < renderer);
});

test('rechaza peticiones enviadas desde otra web (CSRF)', async () => {
  const cookie = await login('admin', 'clave-admin');
  const res = await invoke(cookie, 'servers:list', undefined, { Origin: 'https://web-maliciosa.example' });
  assert.equal(res.status, 403);
});

test('WebSocket: rechaza sin sesión y difunde eventos con sesión', async () => {
  const wsUrl = base.replace('http', 'ws') + '/ws';

  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    })
  );

  const cookie = await login('amigo', 'clave-amigo');
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const received = new Promise((resolve) => ws.on('message', (m) => resolve(JSON.parse(m.toString()))));

  // La consola del servidor de otro amigo NO le llega; la del compartido sí.
  broadcast('servers:log:deana', 'secreto de ana');
  broadcast('servers:log:compartido', 'hola');
  assert.deepEqual(await received, { channel: 'servers:log:compartido', payload: 'hola' });
  ws.close();
});

test('cerrar sesión invalida la cookie', async () => {
  const cookie = await login('admin', 'clave-admin');
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal((await invoke(cookie, 'servers:list')).status, 401);
});

test('lo que crea un amigo queda a su nombre, con un puerto libre de su rango', async () => {
  // Se sustituye la descarga real de Minecraft por un servidor falso: aquí lo
  // que se prueba es el reparto de dueño y puerto, no la descarga.
  const serverManager = require('../src/serverManager');
  const original = serverManager.createServer;
  serverManager.createServer = async (options) => {
    const created = fake('creado-por-amigo');
    created.name = options.name;
    created.memory = options.memory;
    created.properties = { ...created.properties, ...options.properties };
    store.saveServer(created);
    return created;
  };
  try {
    const cookie = await login('amigo', 'clave-amigo');
    const res = await invoke(cookie, 'servers:create', {
      name: 'Mi mundo', loader: 'vanilla', mcVersion: '1.21.1', memory: 2048,
      properties: { 'server-port': 25565, difficulty: 'hard' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.server.owner, 'amigo');
    assert.equal(res.body.result.server.access, 'owner');
    assert.equal(res.body.result.server.properties['server-port'], 25566); // no el 25565 que pidió
    assert.equal(res.body.result.server.properties.difficulty, 'hard');
    assert.equal(store.getServer('creado-por-amigo').owner, 'amigo');

    // Y Ana no lo ve
    auth.addUser({ username: 'ana', password: 'clave-ana-12', role: 'amigo' });
    const anaCookie = await login('ana', 'clave-ana-12');
    const anaList = (await invoke(anaCookie, 'servers:list')).body.result.map((srv) => srv.id);
    assert.ok(!anaList.includes('creado-por-amigo'));
  } finally {
    serverManager.createServer = original;
  }
});
