const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const toml = require('../src/tomlConfig');
const modConfig = require('../src/modConfig');
const nbt = require('../src/nbt');
const { tmpDir, writeFile } = require('./helpers');

const SAMPLE = `#Opciones generales
[general]
\t#Percentage of players needed to sleep
\t# Default: 50
\t# Range: 0 ~ 100
\tsleepPercentage = 50
\t#Clear the weather
\tclearWeather = true # comentario al final
\t#Allowed Values: NONE, FIXED, DISTANCE
\tcostMode = "DISTANCE"
\tratio = 0.5
\tblacklist = [
\t\t"minecraft:the_nether",
\t\t"minecraft:the_end"
\t]
\t"quoted key" = 'literal'

[[rules]]
\tname = "a"
`;

function compound(entries) {
  return { type: nbt.T.COMPOUND, value: new Map(entries) };
}
function str(v) {
  return { type: nbt.T.STRING, value: v };
}

function makeServer({ running } = {}) {
  const dir = tmpDir('msm-cfg-');
  const server = { id: 's1', dir, properties: { 'level-name': 'world' } };
  writeFile(path.join(dir, 'config', 'waystones-common.toml'), SAMPLE);
  writeFile(path.join(dir, 'config', 'jei-client.toml'), '[x]\n\ta = 1\n');
  writeFile(path.join(dir, 'config', 'cobblemon', 'main.json'), '{"a": 1}');
  writeFile(path.join(dir, 'world', 'serverconfig', 'easiersleeping-server.toml'), '[sleep]\n\tpercent = 50\n');
  writeFile(path.join(dir, 'defaultconfigs', 'easiersleeping-server.toml'), '[sleep]\n\tpercent = 50\n');
  writeFile(path.join(dir, 'server.properties'), 'secreto=1\n');
  const level = compound([['Data', compound([['GameRules', compound([['keepInventory', str('false')], ['playersSleepingPercentage', str('100')], ['modRule', str('7')]])], ['LevelName', str('world')]])]]);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  nbt.writeFile(fs, path.join(dir, 'world', 'level.dat'), { name: '', root: level });
  return server;
}

test('toml: lee tipos, rangos, opciones permitidas y valores por defecto', () => {
  const doc = toml.describe(SAMPLE);
  const opts = Object.fromEntries(doc.sections.flatMap((s) => s.options).map((o) => [o.id, o]));
  assert.equal(opts['general.sleepPercentage'].type, 'int');
  assert.deepEqual(opts['general.sleepPercentage'].range, { min: 0, max: 100 });
  assert.equal(opts['general.sleepPercentage'].default, 50);
  assert.equal(opts['general.clearWeather'].value, true);
  assert.equal(opts['general.costMode'].type, 'enum');
  assert.deepEqual(opts['general.costMode'].choices, ['NONE', 'FIXED', 'DISTANCE']);
  assert.equal(opts['general.ratio'].type, 'float');
  assert.deepEqual(opts['general.blacklist'].value, ['minecraft:the_nether', 'minecraft:the_end']);
  assert.equal(opts['general.quoted key'].value, 'literal');
  assert.ok(Object.values(opts).some((o) => o.readOnly), 'los [[arrays de tablas]] son de solo lectura');
});

test('toml: al guardar solo cambian los valores; comentarios y orden se quedan', () => {
  const out = toml.applyChanges(SAMPLE, {
    'general.sleepPercentage': 25,
    'general.clearWeather': false,
    'general.costMode': 'FIXED',
    'general.ratio': 1,
    'general.quoted key': 'con "comillas"',
  });
  assert.match(out, /\tsleepPercentage = 25\n/);
  assert.match(out, /clearWeather = false # comentario al final/);
  assert.match(out, /costMode = "FIXED"/);
  assert.match(out, /ratio = 1\.0/);
  assert.match(out, /"quoted key" = "con \\"comillas\\""/);
  assert.ok(out.startsWith('#Opciones generales\n[general]\n\t#Percentage'));
  assert.ok(out.includes('\t\t"minecraft:the_nether",'), 'la lista no tocada sigue igual');
  // Y se vuelve a leer bien
  const again = toml.describe(out).sections[0].options.find((o) => o.key === 'quoted key');
  assert.equal(again.value, 'con "comillas"');
});

test('toml: rechaza valores fuera de rango o que no están permitidos', () => {
  assert.throws(() => toml.applyChanges(SAMPLE, { 'general.sleepPercentage': 150 }), /mayor que 100/);
  assert.throws(() => toml.applyChanges(SAMPLE, { 'general.sleepPercentage': 2.5 }), /entero/);
  assert.throws(() => toml.applyChanges(SAMPLE, { 'general.costMode': 'GRATIS' }), /una de/);
  assert.throws(() => toml.applyChanges(SAMPLE, { 'general.clearWeather': 'si' }), /sí o no/);
  assert.throws(() => toml.applyChanges(SAMPLE, { 'general.noExiste': 1 }), /ya no está/);
});

test('lista las configuraciones por mod y marca cuál manda', () => {
  const server = makeServer();
  const { groups, worldExists } = modConfig.listConfigs(server);
  assert.equal(worldExists, true);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  assert.ok(byId.waystones && byId.cobblemon && byId.easiersleeping && byId.jei);
  const sleep = byId.easiersleeping.files;
  assert.equal(sleep[0].scope, 'serverconfig', 'el de serverconfig va primero');
  assert.match(sleep[1].note, /mundos nuevos/);
  assert.equal(byId.jei.serverRelevant, false, 'los -client.toml no afectan al servidor');
  assert.equal(byId.cobblemon.files[0].kind, 'text');
});

test('no deja leer ni escribir fuera de las carpetas de configuración', () => {
  const server = makeServer();
  for (const bad of ['server.properties', '../x.toml', 'config/../server.properties', '/etc/passwd', 'C:/x.toml', 'config/x.jar']) {
    assert.throws(() => modConfig.readConfig(server, bad), /no válida|no es de configuración|no se puede editar/, bad);
  }
});

test('guardar: copia antes, aplica cambios y detecta si el archivo ha cambiado', () => {
  const server = makeServer();
  const read = modConfig.readConfig(server, 'config/waystones-common.toml');
  assert.equal(read.kind, 'toml');
  const res = modConfig.saveConfig(server, { rel: read.rel, hash: read.hash, changes: { 'general.sleepPercentage': 10 } });
  assert.equal(res.changed, true);
  const now = fs.readFileSync(path.join(server.dir, 'config', 'waystones-common.toml'), 'utf-8');
  assert.match(now, /sleepPercentage = 10/);
  const copy = fs.readFileSync(path.join(server.dir, res.backupDir, 'config', 'waystones-common.toml'), 'utf-8');
  assert.equal(copy, SAMPLE, 'la copia es el archivo de antes');
  // Con el hash viejo ya no deja guardar
  assert.throws(() => modConfig.saveConfig(server, { rel: read.rel, hash: read.hash, changes: { 'general.sleepPercentage': 20 } }), /ha cambiado/);
});

test('guardar como texto: comprueba que el JSON / TOML sea válido', () => {
  const server = makeServer();
  const read = modConfig.readConfig(server, 'config/cobblemon/main.json');
  assert.throws(() => modConfig.saveConfig(server, { rel: read.rel, hash: read.hash, content: '{roto' }), /JSON válido/);
  const ok = modConfig.saveConfig(server, { rel: read.rel, hash: read.hash, content: '{"a": 2}' });
  assert.equal(ok.changed, true);
  const t = modConfig.readConfig(server, 'config/waystones-common.toml');
  assert.throws(() => modConfig.saveConfig(server, { rel: t.rel, hash: t.hash, content: 'a = "sin cerrar' }), /TOML válido/);
});

test('reglas del mundo: lee level.dat, valida y escribe con copia', () => {
  const server = makeServer();
  const { rules, worldExists } = modConfig.listGameRules(server);
  assert.equal(worldExists, true);
  const byKey = Object.fromEntries(rules.map((r) => [r.key, r]));
  assert.equal(byKey.keepInventory.value, false);
  assert.equal(byKey.playersSleepingPercentage.value, 100);
  assert.equal(byKey.modRule.value, 7, 'las reglas de mods también salen');
  assert.equal(byKey.doFireTick.value, true, 'las que no están en el mundo salen con su valor por defecto');

  assert.throws(() => modConfig.validateGameRuleChanges(server, { playersSleepingPercentage: 150 }), /mayor que 100/);
  assert.throws(() => modConfig.validateGameRuleChanges(server, { 'x y': true }), /no válida/);
  assert.throws(() => modConfig.validateGameRuleChanges(server, { inventada: true }), /no existe/);

  const values = modConfig.validateGameRuleChanges(server, { keepInventory: true, playersSleepingPercentage: 30 });
  assert.deepEqual(values, { keepInventory: 'true', playersSleepingPercentage: '30' });
  const { backupDir } = modConfig.writeGameRulesToLevel(server, values);
  assert.ok(fs.existsSync(path.join(server.dir, backupDir, 'world', 'level.dat')));
  const after = Object.fromEntries(modConfig.listGameRules(server).rules.map((r) => [r.key, r.value]));
  assert.equal(after.keepInventory, true);
  assert.equal(after.playersSleepingPercentage, 30);
  const data = nbt.readFile(fs, path.join(server.dir, 'world', 'level.dat')).root.value.get('Data').value;
  assert.equal(data.get('LevelName').value, 'world', 'el resto de level.dat intacto');
});
