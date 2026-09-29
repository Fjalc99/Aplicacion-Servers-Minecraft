const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers');

// Carpeta sin usuarios: la web tiene que pedir crear el primer administrador.
process.env.DATA_DIR = tmpDir('msm-setup-');
const auth = require('../web/auth');
const { createWebServer } = require('../web/server');

let server;
let base;
test.before(async () => {
  ({ server } = createWebServer());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('sin administrador, todo lleva a /setup y hace falta el código de la terminal', async () => {
  for (const path of ['/', '/login']) {
    const res = await fetch(base + path, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/setup');
  }
  assert.equal((await fetch(base + '/setup')).status, 200);

  const wrong = await post('/api/setup', { code: 'MAL', username: 'jefa', password: 'clave-jefa-1' });
  assert.equal(wrong.status, 403);
  assert.equal(auth.hasAdmin(), false);

  const ok = await post('/api/setup', { code: auth.getSetupCode(), username: 'jefa', password: 'clave-jefa-1' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /msm_session=/);
  assert.equal(auth.hasAdmin(), true);

  // Una vez creado, /setup ya no sirve y no se puede crear otro por esa vía
  assert.equal((await fetch(base + '/setup', { redirect: 'manual' })).headers.get('location'), '/login');
  const again = await post('/api/setup', { code: 'X', username: 'otro', password: 'clave-otro-1' });
  assert.equal(again.status, 401);
  assert.equal(auth.listUsers().some((u) => u.username === 'otro'), false);
});
