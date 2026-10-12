const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { applyModsToServer, diffAgainstServer, selectModsForServer, sha1File } = require('../src/modAnalyzer');
const { tmpDir, writeFile } = require('./helpers');

function mod(dir, fileName, content, status) {
  const file = writeFile(path.join(dir, fileName), content);
  const sha1 = crypto.createHash('sha1').update(content).digest('hex');
  return { file, fileName, sha1, name: fileName, status };
}

test('sha1File calcula el hash correcto', async () => {
  const f = writeFile(path.join(tmpDir(), 'a.jar'), 'contenido');
  const expected = crypto.createHash('sha1').update('contenido').digest('hex');
  assert.equal(await sha1File(f), expected);
});

test('selectModsForServer excluye client-only y respeta includeUnknown', () => {
  const results = [
    { fileName: 'a', status: 'needed' },
    { fileName: 'b', status: 'client-only' },
    { fileName: 'c', status: 'unknown' },
  ];
  assert.deepEqual(selectModsForServer(results).map((r) => r.fileName), ['a', 'c']);
  assert.deepEqual(selectModsForServer(results, { includeUnknown: false }).map((r) => r.fileName), ['a']);
});

test('applyModsToServer copia, distingue nuevos/sobrescritos y omite client-only', () => {
  const client = tmpDir();
  const serverMods = path.join(tmpDir(), 'mods');
  writeFile(path.join(serverMods, 'existente.jar'), 'viejo');

  const results = [
    mod(client, 'nuevo.jar', 'n', 'needed'),
    mod(client, 'existente.jar', 'nuevo contenido', 'needed'),
    mod(client, 'cliente.jar', 'c', 'client-only'),
    mod(client, 'raro.jar', 'r', 'unknown'),
  ];

  const out = applyModsToServer(serverMods, results, { includeUnknown: false });
  assert.deepEqual(out.copiedNew, ['nuevo.jar']);
  assert.deepEqual(out.copiedOverwritten, ['existente.jar']);
  assert.deepEqual(out.skipped.sort(), ['cliente.jar', 'raro.jar']);
  assert.deepEqual(out.failed, []);
  assert.equal(fs.readFileSync(path.join(serverMods, 'existente.jar'), 'utf-8'), 'nuevo contenido');
  assert.ok(!fs.existsSync(path.join(serverMods, 'cliente.jar')));
});

test('applyModsToServer registra fallos sin abortar el resto', () => {
  const serverMods = path.join(tmpDir(), 'mods');
  const client = tmpDir();
  const ok = mod(client, 'ok.jar', 'ok', 'needed');
  const missing = { file: path.join(client, 'no-existe.jar'), fileName: 'no-existe.jar', status: 'needed' };
  const out = applyModsToServer(serverMods, [missing, ok]);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].fileName, 'no-existe.jar');
  assert.deepEqual(out.copiedNew, ['ok.jar']);
});

test('diffAgainstServer marca new / same / different por hash', async () => {
  const client = tmpDir();
  const serverMods = tmpDir();
  const same = mod(client, 'igual.jar', 'A', 'needed');
  const diff = mod(client, 'cambia.jar', 'B2', 'needed');
  const fresh = mod(client, 'nuevo.jar', 'C', 'needed');
  writeFile(path.join(serverMods, 'igual.jar'), 'A');
  writeFile(path.join(serverMods, 'cambia.jar'), 'B1');

  const out = await diffAgainstServer([same, diff, fresh], serverMods);
  const byName = Object.fromEntries(out.map((r) => [r.fileName, r.serverState]));
  assert.deepEqual(byName, { 'igual.jar': 'same', 'cambia.jar': 'different', 'nuevo.jar': 'new' });
});

// ---------------------------------------------------------------------------
// analyzeMods: Modrinth -> CurseForge -> ficha del propio .jar
// ---------------------------------------------------------------------------
const { analyzeMods, readJarMetadata } = require('../src/modAnalyzer');
const { createZip } = require('../src/zipWriter');
const curseforge = require('../src/curseforge');

/** Crea un .jar (un ZIP) con los ficheros indicados. */
async function makeJar(dir, fileName, files) {
  const srcDir = tmpDir();
  const entries = Object.entries(files).map(([name, content]) => ({
    name,
    filePath: writeFile(path.join(srcDir, name), content),
  }));
  const jar = path.join(dir, fileName);
  await createZip(entries, jar);
  return jar;
}

const sha1Of = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const printOf = (file) => curseforge.fingerprint(fs.readFileSync(file));

async function modsFolder() {
  const dir = tmpDir();
  const jars = {
    create: await makeJar(dir, 'create-1.21.1.jar', { 'a.class': 'create' }),
    sodium: await makeJar(dir, 'sodium.jar', { 'a.class': 'sodium' }),
    cfClient: await makeJar(dir, 'cf-client.jar', { 'a.class': 'solo en curseforge' }),
    cfNoSide: await makeJar(dir, 'cf-noside.jar', { 'a.class': 'curseforge sin lado' }),
    tomlClient: await makeJar(dir, 'mi-hud.jar', {
      'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="mihud"\ndisplayName="Mi HUD bonito"\ndisplayTest="IGNORE_SERVER_VERSION"\n',
    }),
    fabricClient: await makeJar(dir, 'fabric-cosa.jar', {
      'fabric.mod.json': JSON.stringify({ id: 'cosa', name: 'Cosa de Fabric', environment: 'client' }),
    }),
    tomlBoth: await makeJar(dir, 'libreria.jar', {
      'META-INF/mods.toml': 'displayName="Librería ${file.jarVersion}"\n',
    }),
  };
  writeFile(path.join(dir, 'roto.jar'), 'esto no es un zip');
  writeFile(path.join(dir, 'leeme.txt'), 'no es un mod');
  return { dir, jars };
}

function fakeApis(jars, { modrinthDown = false } = {}) {
  const modrinth = {
    [sha1Of(jars.create)]: { project_id: 'P1' },
    [sha1Of(jars.sodium)]: { project_id: 'P2' },
  };
  const cfPrints = new Map([
    [printOf(jars.cfClient), { id: 7, gameVersions: ['1.21.1', 'NeoForge', 'Client'] }],
    [printOf(jars.cfNoSide), { id: 8, gameVersions: ['1.21.1', 'NeoForge'] }],
  ]);
  const calls = [];
  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes('modrinth')) {
      if (modrinthDown) return { ok: false, status: 503, json: async () => ({}) };
      if (url.endsWith('/version_files')) {
        return json(Object.fromEntries(body.hashes.filter((h) => modrinth[h]).map((h) => [h, modrinth[h]])));
      }
      return json([
        { id: 'P1', title: 'Create', slug: 'create', server_side: 'required', client_side: 'required' },
        { id: 'P2', title: 'Sodium', slug: 'sodium', server_side: 'unsupported', client_side: 'required' },
      ]);
    }
    if (url.endsWith('/v1/fingerprints/432')) {
      return json({
        data: {
          exactMatches: body.fingerprints
            .filter((f) => cfPrints.has(f))
            .map((f) => ({ id: cfPrints.get(f).id, file: { modId: cfPrints.get(f).id, fileFingerprint: f, gameVersions: cfPrints.get(f).gameVersions } })),
        },
      });
    }
    if (url.endsWith('/v1/mods')) {
      return json({ data: body.modIds.map((id) => ({ id, name: `CF ${id}`, slug: `cf-${id}`, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/cf-${id}` } })) });
    }
    throw new Error(`URL inesperada ${url}`);
  };
  return { fetchImpl, calls };
}

test('analyzeMods: Modrinth, luego CurseForge, luego la ficha del .jar', async () => {
  const { dir, jars } = await modsFolder();
  const { fetchImpl } = fakeApis(jars);
  const { results, warnings } = await analyzeMods(dir, { fetchImpl, curseforgeKey: 'clave-de-prueba' });
  const by = Object.fromEntries(results.map((r) => [r.fileName, r]));

  assert.equal(results.length, 8, 'solo los .jar');
  assert.deepEqual(warnings, []);

  assert.equal(by['create-1.21.1.jar'].status, 'needed');
  assert.equal(by['create-1.21.1.jar'].source, 'modrinth');
  assert.equal(by['create-1.21.1.jar'].modrinthUrl, 'https://modrinth.com/mod/create');
  assert.equal(by['sodium.jar'].status, 'client-only');

  assert.equal(by['cf-client.jar'].status, 'client-only');
  assert.equal(by['cf-client.jar'].source, 'curseforge');
  assert.equal(by['cf-client.jar'].name, 'CF 7');
  assert.equal(by['cf-client.jar'].curseforgeUrl, 'https://www.curseforge.com/minecraft/mc-mods/cf-7');

  assert.equal(by['cf-noside.jar'].status, 'unknown', 'CurseForge sin lado: por revisar, pero con nombre y enlace');
  assert.equal(by['cf-noside.jar'].name, 'CF 8');
  assert.ok(by['cf-noside.jar'].curseforgeUrl);

  assert.equal(by['mi-hud.jar'].status, 'client-only');
  assert.equal(by['mi-hud.jar'].source, 'jar');
  assert.equal(by['mi-hud.jar'].name, 'Mi HUD bonito');
  assert.equal(by['fabric-cosa.jar'].status, 'client-only');
  assert.equal(by['fabric-cosa.jar'].name, 'Cosa de Fabric');

  assert.equal(by['libreria.jar'].status, 'unknown');
  assert.equal(by['libreria.jar'].name, 'libreria.jar', 'nombres con ${...} se ignoran');
  assert.equal(by['roto.jar'].status, 'unknown');
});

test('analyzeMods sin clave de CurseForge: avisa y no lo consulta', async () => {
  const { dir, jars } = await modsFolder();
  const { fetchImpl, calls } = fakeApis(jars);
  const { results, warnings } = await analyzeMods(dir, { fetchImpl, curseforgeKey: null });
  assert.deepEqual(warnings, ['curseforge-sin-clave']);
  assert.ok(!calls.some((u) => u.includes('curseforge')));
  assert.equal(results.find((r) => r.fileName === 'cf-client.jar').status, 'unknown');
  assert.equal(results.find((r) => r.fileName === 'mi-hud.jar').status, 'client-only', 'la ficha del jar sigue funcionando');
});

test('analyzeMods: si Modrinth falla, avisa y sigue con CurseForge', async () => {
  const { dir, jars } = await modsFolder();
  const { fetchImpl } = fakeApis(jars, { modrinthDown: true });
  const { results, warnings } = await analyzeMods(dir, { fetchImpl, curseforgeKey: 'clave' });
  assert.match(warnings[0], /No se ha podido consultar Modrinth/);
  assert.equal(results.find((r) => r.fileName === 'cf-client.jar').status, 'client-only');
});

test('analyzeMods da un error claro si la carpeta no existe', async () => {
  await assert.rejects(analyzeMods(path.join(tmpDir(), 'no-existe')), /No se encuentra esa carpeta/);
});

test('readJarMetadata no falla con jars rotos', () => {
  assert.equal(readJarMetadata(writeFile(path.join(tmpDir(), 'x.jar'), 'basura')), null);
});

test('copiar mods analizando la propia carpeta del servidor no los vacía', () => {
  const modsDir = tmpDir();
  const m = mod(modsDir, 'create.jar', 'contenido del mod', 'needed');
  const result = applyModsToServer(modsDir, [m]);
  assert.deepEqual(result.skipped, ['create.jar']);
  assert.equal(fs.readFileSync(path.join(modsDir, 'create.jar'), 'utf-8'), 'contenido del mod');
});

test('copiar: los que el análisis marcó como "ya está igual" no se reescriben', () => {
  const modsDir = tmpDir();
  const clientDir = tmpDir();
  writeFile(path.join(modsDir, 'create.jar'), 'mismo');
  const same = { ...mod(clientDir, 'create.jar', 'mismo', 'needed'), serverState: 'same' };
  const fresh = { ...mod(clientDir, 'nuevo.jar', 'nuevo', 'needed'), serverState: 'new' };
  const result = applyModsToServer(modsDir, [same, fresh]);
  assert.deepEqual(result.alreadySame, ['create.jar']);
  assert.deepEqual(result.copiedNew, ['nuevo.jar']);
});

test('detecta el mismo mod en dos versiones y deja marcado solo uno', async () => {
  const dir = tmpDir();
  const toml = (v) => ({ 'META-INF/neoforge.mods.toml': `[[mods]]\nmodId="cobblemon"\nversion="${v}"\ndisplayName="Cobblemon"\n` });
  await makeJar(dir, 'Cobblemon-neoforge-1.8.1+1.21.1-fixed.jar', toml('1.8.1'));
  await makeJar(dir, 'Cobblemon-neoforge-1.8.2+1.21.1.jar', toml('1.8.2'));
  await makeJar(dir, 'otro.jar', { 'META-INF/neoforge.mods.toml': 'modId="otro"\n' });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const { results } = await analyzeMods(dir, { fetchImpl, curseforgeKey: null });
  const by = Object.fromEntries(results.map((r) => [r.fileName, r]));
  assert.equal(by['Cobblemon-neoforge-1.8.2+1.21.1.jar'].keepDuplicate, true, 'se queda la versión más alta');
  assert.equal(by['Cobblemon-neoforge-1.8.1+1.21.1-fixed.jar'].keepDuplicate, false);
  assert.deepEqual(by['Cobblemon-neoforge-1.8.1+1.21.1-fixed.jar'].duplicateOf, ['Cobblemon-neoforge-1.8.2+1.21.1.jar']);
  assert.equal(by['otro.jar'].duplicateOf, undefined);

  // Si una versión ya está igual en el servidor, se prefiere esa
  const { markDuplicates } = require('../src/modAnalyzer');
  by['Cobblemon-neoforge-1.8.1+1.21.1-fixed.jar'].serverState = 'same';
  by['Cobblemon-neoforge-1.8.2+1.21.1.jar'].serverState = 'new';
  markDuplicates(results);
  assert.equal(by['Cobblemon-neoforge-1.8.1+1.21.1-fixed.jar'].keepDuplicate, true);
});

test('no confunde el modId de una dependencia con el del propio mod', async () => {
  const dir = tmpDir();
  const lib = 'modLoader="javafml"\n[[dependencies.moogsend]]\nmodId="mss"\nmandatory=true\n';
  await makeJar(dir, 'MoogsEndStructures.jar', { 'META-INF/neoforge.mods.toml': `${lib}[[mods]]\nmodId="moogsend"\ndisplayName="Moogs End"\n` });
  await makeJar(dir, 'MoogsNetherStructures.jar', { 'META-INF/neoforge.mods.toml': `[[dependencies.moogsnether]]\nmodId="mss"\n[[mods]]\nmodId="moogsnether"\n` });
  await makeJar(dir, 'MoogsStructureLib.jar', { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="mss"\n[[dependencies.mss]]\nmodId="neoforge"\n' });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const { results } = await analyzeMods(dir, { fetchImpl, curseforgeKey: null });
  assert.ok(results.every((r) => !r.duplicateOf), JSON.stringify(results.map((r) => [r.fileName, r.modId])));
  assert.deepEqual(results.map((r) => r.modId).sort(), ['moogsend', 'moogsnether', 'mss']);
  assert.equal(results.find((r) => r.fileName === 'MoogsEndStructures.jar').name, 'Moogs End');
});
