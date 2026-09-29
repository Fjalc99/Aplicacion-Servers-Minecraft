const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-duck-');
delete process.env.MSM_DIRECCION_PUBLICA;
delete process.env.MSM_DUCKDNS_URL;

const duckdns = require('../src/duckdns');
const settings = require('../src/settings');

const TOKEN = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// DuckDNS simulado: guarda las URLs pedidas y responde lo que se le diga.
function fakeDuck(body) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (body instanceof Error) throw body;
    return { text: async () => body };
  };
  return { fetchImpl, calls };
}
const OK = 'OK\n203.0.113.7\n\nUPDATED';

test('acepta el subdominio de varias formas y valida el token', () => {
  for (const value of ['miserver', 'MiServer', 'miserver.duckdns.org', 'https://miserver.duckdns.org/']) {
    assert.equal(duckdns.normalizeSubdomain(value), 'miserver');
  }
  assert.throws(() => duckdns.normalizeSubdomain('mi server'), /letras, números y guiones/);
  assert.throws(() => duckdns.normalizeSubdomain(''), /letras/);
  assert.equal(duckdns.normalizeToken(` ${TOKEN.toUpperCase()} `), TOKEN);
  assert.throws(() => duckdns.normalizeToken('no-es-un-token'), /formato/);
});

test('llama a DuckDNS con la IP vacía (para que use la de tu conexión) y entiende OK/KO', async () => {
  const ok = fakeDuck(OK);
  const result = await duckdns.callDuckDns('miserver', TOKEN, ok.fetchImpl);
  assert.equal(result.ip, '203.0.113.7');
  assert.equal(result.changed, true);
  assert.match(ok.calls[0], /^https:\/\/www\.duckdns\.org\/update\?domains=miserver&token=a1b2c3d4-[^&]+&ip=&verbose=true$/);

  await assert.rejects(duckdns.callDuckDns('miserver', TOKEN, fakeDuck('KO').fetchImpl), /rechazado/);
  await assert.rejects(duckdns.callDuckDns('miserver', TOKEN, fakeDuck(new Error('sin red')).fetchImpl), /conexión a internet/);
});

test('si DuckDNS rechaza los datos, no se guarda nada', async () => {
  await assert.rejects(duckdns.configure({ subdomain: 'miserver', token: TOKEN }, fakeDuck('KO').fetchImpl), /rechazado/);
  assert.equal(duckdns.publicInfo().configured, false);
  assert.equal(settings.getPublicAddress(), null);
});

test('con datos correctos se guarda, se pone como dirección pública y el token nunca sale', async () => {
  const info = await duckdns.configure({ subdomain: 'miserver.duckdns.org', token: TOKEN }, fakeDuck(OK).fetchImpl);
  assert.equal(info.configured, true);
  assert.equal(info.domain, 'miserver.duckdns.org');
  assert.equal(info.tokenHint, '…7890');
  assert.ok(!JSON.stringify(info).includes(TOKEN));
  assert.equal(settings.getPublicAddress(), 'miserver.duckdns.org');

  // Cambiar el subdominio sin volver a escribir el token reutiliza el guardado
  const fake = fakeDuck(OK);
  await duckdns.configure({ subdomain: 'otro', token: '' }, fake.fetchImpl);
  assert.match(fake.calls[0], /domains=otro&token=a1b2c3d4-/);
});

test('las actualizaciones periódicas no rompen nada si fallan: guardan el error y se recuperan', async () => {
  const failed = await duckdns.updateNow(fakeDuck(new Error('sin red')).fetchImpl);
  assert.match(failed.lastError, /conexión/);
  const recovered = await duckdns.updateNow(fakeDuck(OK).fetchImpl);
  assert.equal(recovered.lastError, null);
  assert.ok(recovered.lastUpdate);
});

test('quitar DuckDNS borra el token y la dirección que puso', () => {
  duckdns.remove();
  assert.equal(duckdns.publicInfo().configured, false);
  assert.equal(settings.getPublicAddress(), null);
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.json'), 'utf-8');
  assert.ok(!raw.includes(TOKEN));
});
