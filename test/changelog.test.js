const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeFile } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-changelog-');
const store = require('../src/store');
const javaProcess = require('../src/javaProcess');
const { createZip } = require('../src/zipWriter');
const changelog = require('../src/changelog');
const { createAppCore } = require('../src/appCore');

async function jar(dir, fileName, id, name, version) {
  const src = tmpDir();
  const toml = `[[mods]]\nmodId="${id}"\ndisplayName="${name}"\n${version ? `version="${version}"\n` : ''}`;
  await createZip([{ name: 'META-INF/neoforge.mods.toml', filePath: writeFile(path.join(src, 'm.toml'), toml) }], path.join(dir, fileName));
}

let n = 0;
async function makeServer() {
  const id = `srv${++n}`;
  const dir = path.join(process.env.DATA_DIR, id);
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  await jar(mods, 'create-6.0.4.jar', 'create', 'Create', '6.0.4');
  await jar(mods, 'jei-19.1.jar', 'jei', 'Just Enough Items', '19.1');
  await jar(mods, 'ferrite.jar', 'ferritecore', 'FerriteCore', '7.0');
  const server = { id, name: 'Los Mineros', dir, loader: 'neoforge', mcVersion: '1.21.1', loaderVersion: '21.1.263', memory: 1024, properties: { 'level-name': 'world' } };
  store.saveServer(server);
  return server;
}

test('la primera vez guarda la foto de los mods; luego detecta añadidos, quitados, actualizados y desactivados', async () => {
  const server = await makeServer();
  const first = changelog.list(server);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].items, [{ type: 'baseline', count: 3 }]);

  const mods = path.join(server.dir, 'mods');
  fs.unlinkSync(path.join(mods, 'jei-19.1.jar'));
  await jar(mods, 'jei-19.2.jar', 'jei', 'Just Enough Items', '19.2');
  fs.renameSync(path.join(mods, 'ferrite.jar'), path.join(mods, 'ferrite.jar.disabled'));
  fs.unlinkSync(path.join(mods, 'create-6.0.4.jar'));
  await jar(mods, 'waystones.jar', 'waystones', 'Waystones', '21.1.5');

  const entries = changelog.list(server);
  assert.equal(entries.length, 2);
  const e = entries[0];
  assert.equal(e.source, 'detected', 'hecho a mano en la carpeta');
  const texts = e.items.map(changelog.itemText);
  assert.deepEqual(texts, [
    '➕ Añadido: Waystones 21.1.5',
    '⬆️ Actualizado: Just Enough Items 19.1 → 19.2',
    '➖ Quitado: Create 6.0.4',
    '⏸️ Desactivado: FerriteCore',
  ]);
  // Sin cambios nuevos no se añade nada
  assert.equal(changelog.list(server).length, 2);
});

test('las operaciones de la app se apuntan como de la app y se juntan si van seguidas', async () => {
  const original = { ...javaProcess };
  javaProcess.isRunning = () => false;
  try {
    const server = await makeServer();
    const core = createAppCore({ send: () => {}, notify: () => {} });
    core.handlers['changelog:list'](server.id); // foto inicial
    const ctx = { user: { username: 'fran' }, reply: () => {} };

    let res = core.handlers['mods:setEnabled']({ serverId: server.id, fileNames: ['jei-19.1.jar'], enabled: false }, ctx);
    assert.equal(res.ok, true);
    res = core.handlers['mods:removeServer']({ serverId: server.id, fileNames: ['ferrite.jar'] }, ctx);
    assert.equal(res.ok, true);

    const { entries } = core.handlers['changelog:list'](server.id);
    assert.equal(entries[0].source, 'app');
    assert.equal(entries[0].by, 'fran');
    assert.deepEqual(entries[0].items.map((i) => i.type), ['modDisabled', 'modRemoved'], 'las dos operaciones en la misma entrada');

    const note = core.handlers['changelog:addNote']({ serverId: server.id, text: 'Nuevo modpack' }, ctx);
    assert.equal(note.ok, true);
    const text = core.handlers['changelog:discordText']({ serverId: server.id, entryIds: [entries[0].id, note.entry.id] });
    assert.match(text.text, /\*\*📋 Cambios en Los Mineros\*\*/);
    assert.match(text.text, /⏸️ Desactivado: Just Enough Items/);
    assert.match(text.text, /➖ Quitado: FerriteCore 7\.0/);
    assert.match(text.text, /📝 Nuevo modpack/);
    assert.match(text.text, /Actualizad vuestros mods/);

    assert.equal(core.handlers['changelog:deleteEntry']({ serverId: server.id, entryId: note.entry.id }).ok, true);
    assert.equal(core.handlers['changelog:list'](server.id).entries.some((e) => e.id === note.entry.id), false);
  } finally {
    Object.assign(javaProcess, original);
  }
});

test('reglas del mundo: se apunta el valor de antes y el nuevo', async () => {
  const original = { ...javaProcess };
  const sent = [];
  javaProcess.isRunning = () => true;
  javaProcess.sendCommand = (id, cmd) => sent.push(cmd);
  try {
    const server = await makeServer();
    const nbt = require('../src/nbt');
    const C = (e) => ({ type: nbt.T.COMPOUND, value: new Map(e) });
    const S = (v) => ({ type: nbt.T.STRING, value: v });
    fs.mkdirSync(path.join(server.dir, 'world'), { recursive: true });
    nbt.writeFile(fs, path.join(server.dir, 'world', 'level.dat'), { name: '', root: C([['Data', C([['GameRules', C([['playersSleepingPercentage', S('100')]])]])]]) });
    const core = createAppCore({ send: () => {}, notify: () => {} });
    const res = core.handlers['config:setGameRules']({ serverId: server.id, changes: { playersSleepingPercentage: 30 } }, {});
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(sent, ['gamerule playersSleepingPercentage 30']);
    const { entries } = core.handlers['changelog:list'](server.id);
    const item = entries.flatMap((e) => e.items).find((i) => i.type === 'gamerule');
    assert.equal(changelog.itemText(item), '🌍 Regla del mundo: Porcentaje de jugadores que tienen que dormir 100 → 30');
  } finally {
    Object.assign(javaProcess, original);
  }
});

test('un id de servidor raro no puede escribir fuera de la carpeta del historial', () => {
  assert.throws(() => changelog.list({ id: '../../x', dir: tmpDir() }), /no válido/);
});
