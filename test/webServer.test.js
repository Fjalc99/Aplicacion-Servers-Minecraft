const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir } = require('./helpers');

// La web guarda los datos en DATA_DIR: se usa una carpeta temporal para no
// tocar los servidores reales de quien ejecute los tests.
process.env.DATA_DIR = tmpDir('msm-web-');

const { createWebServer, safeJoin } = require('../web/server');

function start() {
  const { server, broadcast } = createWebServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, broadcast, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function invoke(base, channel, arg) {
  const res = await fetch(`${base}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, arg }),
  });
  return { status: res.status, body: await res.json() };
}

test('safeJoin no deja salir de la carpeta base', () => {
  const base = path.resolve('/srv/app/renderer');
  assert.equal(safeJoin(base, 'style.css'), path.join(base, 'style.css'));
  assert.ok(safeJoin(base, '../package.json').startsWith(base + path.sep));
  assert.ok(safeJoin(base, '..%2F..%2Fpackage.json').startsWith(base + path.sep));
});

test('la API devuelve resultados, 404 para canales desconocidos y 500 con el mensaje de error', async () => {
  const { server, base } = await start();
  try {
    const list = await invoke(base, 'servers:list');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.result, []);

    const unknown = await invoke(base, 'no:existe');
    assert.equal(unknown.status, 404);

    const failing = await invoke(base, 'servers:listBackups', 'id-inexistente');
    assert.equal(failing.status, 500);
    assert.match(failing.body.error, /no encontrado/i);
  } finally {
    server.close();
  }
});

test('index.html carga el Electron simulado y preload.js antes que renderer.js', async () => {
  const { server, base } = await start();
  try {
    const html = await (await fetch(base + '/')).text();
    const shim = html.indexOf('/web/electron-shim.js');
    const preload = html.indexOf('/web/preload.js');
    const renderer = html.indexOf('renderer.js');
    assert.ok(shim > 0 && shim < preload && preload < renderer);
    assert.match(html, /connect-src 'self' ws: wss:/);

    const preloadJs = await (await fetch(base + '/web/preload.js')).text();
    assert.match(preloadJs, /window\.__msmRequire/);
  } finally {
    server.close();
  }
});

test('los eventos se difunden por WebSocket', async () => {
  const { server, broadcast, base } = await start();
  try {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const received = new Promise((resolve) => {
      ws.onmessage = (m) => resolve(JSON.parse(m.data));
    });

    broadcast('servers:log:x', 'hola');

    assert.deepEqual(await received, { channel: 'servers:log:x', payload: 'hola' });
    ws.close();
  } finally {
    server.close();
  }
});
