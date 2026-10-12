const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir, writeFile } = require('./helpers');
const { compareClientWithServer, applyClientSync } = require('../src/clientSync');
const { createZip } = require('../src/zipWriter');

async function jar(dir, fileName, files) {
  const src = tmpDir();
  const entries = Object.entries(files).map(([name, content]) => ({ name, filePath: writeFile(path.join(src, name), content) }));
  await createZip(entries, path.join(dir, fileName));
  return path.join(dir, fileName);
}
const toml = (id, extra = '') => ({ 'META-INF/neoforge.mods.toml': `[[mods]]\nmodId="${id}"\ndisplayName="${id}"\n${extra}` });
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

/**
 * Montaje:
 *   servidor: create (igual), jei (otra versión), spark (solo servidor), ftblib (falta en el cliente),
 *             ferritecore (opcional en cliente, falta), addon-raro (sin identificar, falta)
 *   cliente:  create (igual), jei (vieja), spark (sobra), sodium (solo cliente), cosa-extra (no está en el servidor)
 */
async function setup() {
  const client = tmpDir();
  const server = tmpDir();
  const projects = {};
  const reg = (file, id, client_side, server_side = 'required') => {
    projects[sha1(file)] = { id, title: id, slug: id, client_side, server_side };
  };
  const createC = await jar(client, 'create-6.0.jar', toml('create'));
  fs.copyFileSync(createC, path.join(server, 'create-6.0.jar'));
  reg(createC, 'create', 'required');
  reg(await jar(client, 'jei-19.1.jar', toml('jei', 'version="19.1"')), 'jei', 'required');
  reg(await jar(server, 'jei-19.2.jar', toml('jei', 'version="19.2"')), 'jei', 'required');
  const sparkC = await jar(client, 'spark.jar', toml('spark'));
  fs.copyFileSync(sparkC, path.join(server, 'spark.jar'));
  reg(sparkC, 'spark', 'unsupported');
  reg(await jar(client, 'sodium.jar', toml('sodium')), 'sodium', 'required', 'unsupported');
  reg(await jar(client, 'cosa-extra.jar', toml('cosa')), 'cosa', 'required');
  reg(await jar(server, 'ftblib.jar', toml('ftblib')), 'ftblib', 'required');
  reg(await jar(server, 'ferritecore.jar', toml('ferritecore')), 'ferritecore', 'optional');
  await jar(server, 'addon-raro.jar', toml('addonraro'));

  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith('/version_files')) {
      return json(Object.fromEntries(body.hashes.filter((h) => projects[h]).map((h) => [h, { project_id: projects[h].id }])));
    }
    const ids = JSON.parse(decodeURIComponent(url.split('ids=')[1]));
    const all = Object.values(projects);
    return json(ids.map((id) => all.find((p) => p.id === id)));
  };
  return { client, server, opts: { fetchImpl, curseforgeKey: null } };
}

test('compara cliente y servidor: falta, otra versión, sobra, no está en el servidor, solo cliente', async () => {
  const { client, server, opts } = await setup();
  const r = await compareClientWithServer(client, server, opts);
  const names = (list) => list.map((m) => m.fileName);

  assert.deepEqual(names(r.same), ['create-6.0.jar']);
  assert.deepEqual(names(r.different), ['jei-19.1.jar']);
  assert.equal(r.different[0].server.fileName, 'jei-19.2.jar');
  assert.deepEqual(names(r.serverOnly), ['spark.jar'], 'spark es solo de servidor: sobra en el cliente');
  assert.deepEqual(names(r.clientOnly), ['sodium.jar']);
  assert.deepEqual(names(r.notOnServer), ['cosa-extra.jar']);

  const missing = Object.fromEntries(r.missing.map((m) => [m.fileName, m.need]));
  assert.deepEqual(missing, { 'addon-raro.jar': 'unknown', 'ferritecore.jar': 'optional', 'ftblib.jar': 'required' });
  assert.ok(!('spark.jar' in missing), 'lo solo de servidor no se propone para el cliente');
});

test('aplicar: copia lo que falta, sustituye versiones y aparta lo que sobra (sin borrar nada)', async () => {
  const { client, server } = await setup();
  const result = applyClientSync(client, server, {
    remove: ['spark.jar'],
    copy: ['ftblib.jar'],
    replace: [{ client: 'jei-19.1.jar', server: 'jei-19.2.jar' }],
  });
  assert.deepEqual(result.failed, []);
  const inClient = fs.readdirSync(client).sort();
  assert.deepEqual(inClient, ['cosa-extra.jar', 'create-6.0.jar', 'ftblib.jar', 'jei-19.2.jar', 'sodium.jar']);
  assert.match(path.basename(result.asideDir), /^mods-quitados-\d{8}-\d{6}$/);
  assert.equal(path.dirname(result.asideDir), path.dirname(client), 'junto a la carpeta mods, no dentro');
  assert.deepEqual(fs.readdirSync(result.asideDir).sort(), ['jei-19.1.jar', 'spark.jar']);
  // El servidor no se toca
  assert.ok(fs.existsSync(path.join(server, 'spark.jar')));
  assert.ok(fs.existsSync(path.join(server, 'ftblib.jar')));
});

test('aplicar rechaza nombres con rutas', async () => {
  const { client, server } = await setup();
  const result = applyClientSync(client, server, { remove: ['../algo.jar'], copy: ['..\\x.jar', 'sub/y.jar'] });
  assert.equal(result.removed.length + result.copied.length, 0);
  assert.equal(result.failed.length, 3);
  assert.equal(result.asideDir, null);
});
