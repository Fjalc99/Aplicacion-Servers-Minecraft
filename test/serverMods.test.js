const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeFile } = require('./helpers');
const { createZip } = require('../src/zipWriter');
const { listServerMods, setModEnabled, removeServerMods } = require('../src/serverMods');
const { readJarMetadata } = require('../src/modAnalyzer');

async function jar(dir, fileName, toml) {
  const src = tmpDir();
  await createZip([{ name: 'META-INF/neoforge.mods.toml', filePath: writeFile(path.join(src, 'm.toml'), toml) }], path.join(dir, fileName));
}
const offline = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), curseforgeKey: null };

async function server() {
  const dir = tmpDir();
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods);
  await jar(mods, 'create-6.0.jar', '[[mods]]\nmodId="create"\nversion="6.0.4"\ndisplayName="Create"\n[[dependencies.create]]\nmodId="neoforge"\ntype="required"\n');
  await jar(mods, 'addictives.jar', '[[mods]]\nmodId="addictives"\ndisplayName="Create: Addictives"\n[[dependencies.addictives]]\nmodId="create"\ntype="required"\n[[dependencies.addictives]]\nmodId="jei"\ntype="optional"\n');
  await jar(mods, 'oldforge.jar', '[[mods]]\nmodId="oldaddon"\ndisplayName="Old Addon"\n[[dependencies.oldaddon]]\nmodId="create"\nmandatory=true\n');
  await jar(mods, 'minimap.jar', '[[mods]]\nmodId="minimap"\ndisplayName="Minimapa"\ndisplayTest="IGNORE_SERVER_VERSION"\n');
  await jar(mods, 'cobble-1.8.1.jar', '[[mods]]\nmodId="cobblemon"\nversion="1.8.1"\ndisplayName="Cobblemon"\n');
  await jar(mods, 'cobble-1.8.2.jar', '[[mods]]\nmodId="cobblemon"\nversion="1.8.2"\ndisplayName="Cobblemon"\n');
  await jar(mods, 'ferrite.jar.disabled', '[[mods]]\nmodId="ferritecore"\ndisplayName="FerriteCore"\n');
  return { id: 's', dir, loader: 'neoforge', mcVersion: '1.21.1' };
}

test('lee versión y dependencias obligatorias de cada .jar (NeoForge y Forge antiguo)', async () => {
  const dir = tmpDir();
  await jar(dir, 'a.jar', '[[mods]]\nmodId="a"\nversion="${file.jarVersion}"\n[[dependencies.a]]\nmodId="create"\ntype="required"\n[[dependencies.a]]\nmodId="jei"\ntype="optional"\n[[dependencies.a]]\nmodId="minecraft"\ntype="required"\n');
  const meta = readJarMetadata(path.join(dir, 'a.jar'));
  assert.equal(meta.version, null, 'los ${...} no cuentan');
  assert.deepEqual(meta.requires, ['create']);
});

test('lista de mods: desactivados, duplicados, solo cliente y quién necesita a quién', async () => {
  const srv = await server();
  const { mods } = await listServerMods(srv, offline);
  const by = Object.fromEntries(mods.map((m) => [m.fileName, m]));
  assert.equal(mods.length, 7);
  assert.equal(by['ferrite.jar.disabled'].disabled, true);
  assert.equal(by['create-6.0.jar'].version, '6.0.4');
  assert.deepEqual(by['create-6.0.jar'].dependents.sort(), ['Create: Addictives', 'Old Addon']);
  assert.equal(by['minimap.jar'].problem, 'Sobra aquí');
  assert.equal(by['minimap.jar'].side, 'client');
  const dupes = mods.filter((m) => m.problem === 'Duplicado').map((m) => m.fileName);
  assert.deepEqual(dupes, ['cobble-1.8.1.jar'], 'se queda la versión más alta');
  assert.equal(by['cobble-1.8.2.jar'].problem, null);
});

test('activar/desactivar renombra a .jar.disabled y quitar mueve a mods-quitados', async () => {
  const srv = await server();
  const mods = path.join(srv.dir, 'mods');
  assert.equal(setModEnabled(srv, 'create-6.0.jar', false), 'create-6.0.jar.disabled');
  assert.ok(fs.existsSync(path.join(mods, 'create-6.0.jar.disabled')));
  assert.equal(setModEnabled(srv, 'create-6.0.jar.disabled', true), 'create-6.0.jar');
  assert.throws(() => setModEnabled(srv, '../server.properties.jar', false), /no válido/);

  const r = removeServerMods(srv, ['minimap.jar', 'no-existe.jar', '../x.jar']);
  assert.deepEqual(r.removed, ['minimap.jar']);
  assert.equal(r.failed.length, 2);
  assert.ok(fs.existsSync(path.join(r.asideDir, 'minimap.jar')));
  assert.match(path.basename(r.asideDir), /^mods-quitados-/);
});
