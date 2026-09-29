const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-tunnel-');
const publicTunnel = require('../web/publicTunnel');

const fake = path.join(__dirname, '..', 'test-fixtures', 'fake-cloudflared.js');
const launcher = { command: process.execPath, prefixArgs: [fake] };

test.afterEach(() => {
  publicTunnel.stop();
  delete process.env.FAKE_CF_MODE;
});

test('arranca, lee el enlace de Cloudflare y se para', async () => {
  publicTunnel.setLocalPort(3123);
  const changes = [];
  publicTunnel.setUrlListener((url) => changes.push(url));

  const st = await publicTunnel.start({ launcher });
  assert.equal(st.phase, 'running');
  assert.match(st.url, /^https:\/\/prueba-feliz-\d+\.trycloudflare\.com$/);
  assert.equal(publicTunnel.activeHost(), new URL(st.url).host);
  assert.deepEqual(changes, [st.url]);

  const stopped = publicTunnel.stop();
  assert.equal(stopped.phase, 'stopped');
  assert.equal(publicTunnel.activeHost(), null);
});

test('si cloudflared se cae, se avisa y queda un error claro', async () => {
  process.env.FAKE_CF_MODE = 'crash';
  const changes = [];
  publicTunnel.setUrlListener((url) => changes.push(url));
  await publicTunnel.start({ launcher });
  await new Promise((r) => setTimeout(r, 700));
  const st = publicTunnel.status();
  assert.equal(st.phase, 'error');
  assert.match(st.error, /se ha cerrado/);
  assert.equal(changes.at(-1), null);
});

test('si Cloudflare no da enlace a tiempo, se corta con un error', async () => {
  process.env.FAKE_CF_MODE = 'silent';
  const st = await publicTunnel.start({ launcher, timeoutMs: 400 });
  assert.equal(st.phase, 'error');
  assert.match(st.error, /a tiempo/);
});

test('recordar si debe activarse al arrancar', () => {
  assert.equal(publicTunnel.setAutoStart(true).autoStart, true);
  assert.equal(publicTunnel.status().autoStart, true);
  assert.equal(publicTunnel.setAutoStart(false).autoStart, false);
});
