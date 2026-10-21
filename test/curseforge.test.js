const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-cf-');
delete process.env.CURSEFORGE_API_KEY;
const curseforge = require('../src/curseforge');
const settings = require('../src/settings');

test('fingerprint: MurmurHash2 (semilla 1) ignorando espacios, tabs y saltos de línea', () => {
  const clean = curseforge.fingerprint(Buffer.from('abcde'));
  assert.equal(curseforge.fingerprint(Buffer.from(' a b\tc\r\nd e ')), clean);
  assert.equal(clean, curseforge.murmur2(Buffer.from('abcde'), 1));
  assert.notEqual(curseforge.fingerprint(Buffer.from('abcdf')), clean);
  assert.equal(curseforge.murmur2(Buffer.alloc(0), 1), curseforge.murmur2(Buffer.alloc(0), 1) >>> 0);
});

test('lado según las etiquetas de entorno de CurseForge', () => {
  assert.equal(curseforge.sideFromGameVersions(['1.21.1', 'NeoForge', 'Client']), 'client-only');
  assert.equal(curseforge.sideFromGameVersions(['1.21.1', 'Client', 'Server']), 'server');
  assert.equal(curseforge.sideFromGameVersions(['1.21.1', 'Server']), 'server');
  assert.equal(curseforge.sideFromGameVersions(['1.21.1', 'NeoForge']), null);
});

function fakeCurseForge({ status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const body = options.body ? JSON.parse(options.body) : null;
    let data = {};
    if (url.endsWith('/v1/games/432')) data = { id: 432, name: 'Minecraft' };
    if (url.endsWith('/v1/fingerprints/432')) {
      data = {
        exactMatches: body.fingerprints
          .filter((f) => f === 111 || f === 222)
          .map((f) => ({
            id: f === 111 ? 5001 : 5002,
            file: { modId: f === 111 ? 5001 : 5002, fileFingerprint: f, gameVersions: f === 111 ? ['1.21.1', 'Client'] : ['1.21.1'] },
          })),
      };
    }
    if (url.endsWith('/v1/mods')) {
      data = body.modIds.map((id) => ({ id, name: `Mod ${id}`, slug: `mod-${id}`, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/mod-${id}` } }));
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetchImpl, calls };
}

test('lookupFingerprints: nombre, enlace y lado de lo que reconoce; manda la clave en x-api-key', async () => {
  const { fetchImpl, calls } = fakeCurseForge();
  const found = await curseforge.lookupFingerprints([111, 222, 333], { apiKey: 'clave-de-prueba-123456789', fetchImpl });
  assert.equal(found.size, 2);
  assert.deepEqual(found.get(111), { modId: 5001, name: 'Mod 5001', url: 'https://www.curseforge.com/minecraft/mc-mods/mod-5001', side: 'client-only', client: true, server: false, fileId: null, displayName: null, fileDate: null, releaseType: null });
  assert.equal(found.get(222).side, null);
  assert.equal(found.has(333), false);
  assert.ok(calls.every((c) => c.options.headers['x-api-key'] === 'clave-de-prueba-123456789'));
});

test('sin clave no se consulta CurseForge', async () => {
  const { fetchImpl, calls } = fakeCurseForge();
  const found = await curseforge.lookupFingerprints([111], { apiKey: null, fetchImpl });
  assert.equal(found.size, 0);
  assert.equal(calls.length, 0);
});

test('la clave se comprueba antes de guardarla y nunca se devuelve a la interfaz', async () => {
  await assert.rejects(curseforge.setApiKey('corta'), /no parece una clave/);
  await assert.rejects(
    curseforge.setApiKey('$2a$10$claveRechazadaPorCurseForge', { fetchImpl: fakeCurseForge({ status: 403 }).fetchImpl }),
    /rechazado la clave/
  );
  assert.equal(curseforge.publicInfo().configured, false);

  const info = await curseforge.setApiKey('  $2a$10$claveBuenaDeCurseForgeXYZ1234  ', { fetchImpl: fakeCurseForge().fetchImpl });
  assert.deepEqual(info, { configured: true, source: 'settings', keyHint: '…1234' });
  assert.ok(!JSON.stringify(info).includes('claveBuena'));
  assert.equal(settings.readSettings().curseforgeApiKey, '$2a$10$claveBuenaDeCurseForgeXYZ1234');
  assert.equal(curseforge.getApiKey(), '$2a$10$claveBuenaDeCurseForgeXYZ1234');

  curseforge.removeApiKey();
  assert.equal(curseforge.publicInfo().configured, false);
});
