const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeFile } = require('./helpers');
const nbt = require('../src/nbt');
const lw = require('../src/localWorld');

const FRAN = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const AMIGO = '11111111-2222-3333-4444-555555555555';
const { T } = nbt;
const compound = (entries) => ({ type: T.COMPOUND, value: new Map(entries) });

function writeDat(file, root) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  nbt.writeFile(fs, file, { name: '', root });
}
function readDat(file) {
  return nbt.readFile(fs, file).root;
}
function playerTag(item, count) {
  return compound([
    ['Inventory', { type: T.LIST, value: { elementType: T.COMPOUND, items: [compound([['id', { type: T.STRING, value: item }], ['count', { type: T.INT, value: count }]])] } }],
    ['Pos', { type: T.LIST, value: { elementType: T.DOUBLE, items: [100.5, 70, -20.5].map((v) => ({ type: T.DOUBLE, value: v })) } }],
  ]);
}

function makeServer() {
  const dir = tmpDir();
  const world = path.join(dir, 'world');
  writeDat(path.join(world, 'level.dat'), compound([['Data', compound([
    ['LevelName', { type: T.STRING, value: 'world' }],
    ['Difficulty', { type: T.BYTE, value: 1 }],
    ['DataVersion', { type: T.INT, value: 3955 }],
  ])]]));
  writeDat(path.join(world, 'playerdata', `${FRAN}.dat`), playerTag('minecraft:diamond', 12));
  writeDat(path.join(world, 'playerdata', `${AMIGO}.dat`), playerTag('minecraft:dirt', 1));
  writeFile(path.join(world, 'region', 'r.0.0.mca'), 'chunks');
  writeFile(path.join(world, 'serverconfig', 'create-server.toml'), 'x=1');
  writeFile(path.join(world, 'session.lock'), 'lock');
  writeFile(path.join(dir, 'usercache.json'), JSON.stringify([{ name: 'Franp1999', uuid: FRAN }, { name: 'Amigo', uuid: AMIGO }]));
  writeFile(path.join(dir, 'ops.json'), JSON.stringify([{ uuid: FRAN, name: 'Franp1999', level: 4 }]));
  writeFile(path.join(dir, 'config', 'create-common.toml'), 'server=1');
  writeFile(path.join(dir, 'config', 'jei', 'jei-client.toml'), 'del servidor');
  return { id: 'srv1', name: 'Los Mineros', dir, properties: { 'level-name': 'world', difficulty: 'hard' } };
}

function makeInstance() {
  const dir = tmpDir();
  writeFile(path.join(dir, 'mods', 'create.jar'), 'jar');
  fs.mkdirSync(path.join(dir, 'saves'));
  writeFile(path.join(dir, 'config', 'create-common.toml'), 'mio=1');
  writeFile(path.join(dir, 'config', 'jei', 'jei-client.toml'), 'mis teclas');
  return dir;
}

test('jugadores del servidor: nombre desde usercache y los OP primero', () => {
  const players = lw.listPlayers(makeServer());
  assert.deepEqual(players.map((p) => [p.name, p.op]), [['Franp1999', true], ['Amigo', false]]);
});

test('exportar: tu inventario va a level.dat, dificultad y trucos del servidor, y la config de mods', () => {
  const server = makeServer();
  const instance = makeInstance();
  const r = lw.exportToLocal(server, { instanceDir: instance, uuid: FRAN, saveName: 'Los Mineros' });

  assert.equal(r.saveFolder, 'Los Mineros');
  assert.equal(r.playerApplied, true);
  const save = path.join(instance, 'saves', 'Los Mineros');
  assert.ok(fs.existsSync(path.join(save, 'region', 'r.0.0.mca')));
  assert.ok(fs.existsSync(path.join(save, 'serverconfig', 'create-server.toml')), 'la config de servidor del mundo viaja con él');
  assert.equal(fs.existsSync(path.join(save, 'session.lock')), false);

  const data = readDat(path.join(save, 'level.dat')).value.get('Data').value;
  const inv = data.get('Player').value.get('Inventory').value.items[0].value;
  assert.equal(inv.get('id').value, 'minecraft:diamond');
  assert.equal(inv.get('count').value, 12);
  assert.equal(data.get('Difficulty').value, 3, 'hard');
  assert.equal(data.get('allowCommands').value, 1, 'eres OP: trucos activados');
  assert.equal(data.get('LevelName').value, 'Los Mineros');
  assert.equal(data.get('DataVersion').value, 3955, 'el resto de level.dat intacto');

  // Config: la común se copia (guardando la tuya), la de cliente no se toca
  assert.equal(fs.readFileSync(path.join(instance, 'config', 'create-common.toml'), 'utf-8'), 'server=1');
  assert.equal(fs.readFileSync(path.join(instance, 'config', 'jei', 'jei-client.toml'), 'utf-8'), 'mis teclas');
  assert.equal(r.config.replaced, 1);
  assert.equal(fs.readFileSync(path.join(r.config.backupDir, 'create-common.toml'), 'utf-8'), 'mio=1');

  // El servidor no se toca
  assert.ok(!readDat(path.join(server.dir, 'world', 'level.dat')).value.get('Data').value.has('Player'));

  // Exportar otra vez no pisa la partida anterior
  assert.equal(lw.exportToLocal(server, { instanceDir: instance, uuid: FRAN, saveName: 'Los Mineros', copyConfig: false }).saveFolder, 'Los Mineros (2)');
});

test('traer de vuelta: lo jugado en local vuelve al servidor, con tu inventario en playerdata', () => {
  const server = makeServer();
  const instance = makeInstance();
  const { saveFolder } = lw.exportToLocal(server, { instanceDir: instance, uuid: FRAN, copyConfig: false });
  const save = path.join(instance, 'saves', saveFolder);

  // "Jugamos" en local: cambia el inventario del anfitrión y el mundo
  const levelFile = path.join(save, 'level.dat');
  const doc = nbt.readFile(fs, levelFile);
  doc.root.value.get('Data').value.set('Player', playerTag('minecraft:netherite_ingot', 5));
  nbt.writeFile(fs, levelFile, doc);
  fs.writeFileSync(path.join(save, 'region', 'r.0.0.mca'), 'chunks nuevos');

  const saves = lw.listSaves(instance);
  assert.equal(saves[0].folder, saveFolder);
  assert.equal(saves[0].exported.serverId, 'srv1');

  const r = lw.importFromLocal(server, { instanceDir: instance, saveFolder });
  assert.equal(r.playerRestored, true);
  const world = path.join(server.dir, 'world');
  assert.equal(fs.readFileSync(path.join(world, 'region', 'r.0.0.mca'), 'utf-8'), 'chunks nuevos');
  const fran = readDat(path.join(world, 'playerdata', `${FRAN}.dat`)).value.get('Inventory').value.items[0].value;
  assert.equal(fran.get('id').value, 'minecraft:netherite_ingot');
  assert.ok(!readDat(path.join(world, 'level.dat')).value.get('Data').value.has('Player'), 'en el servidor no se usa');
  assert.ok(fs.existsSync(path.join(world, 'playerdata', `${AMIGO}.dat`)), 'los amigos siguen');
  assert.equal(fs.existsSync(path.join(world, lw.EXPORT_META)), false);
  assert.ok(fs.existsSync(path.join(server.dir, r.previousWorldSavedAs, 'level.dat')), 'el mundo anterior se guarda aparte');
});

test('traer de vuelta avisa si en el servidor se ha jugado después de exportar', () => {
  const server = makeServer();
  const instance = makeInstance();
  const { saveFolder } = lw.exportToLocal(server, { instanceDir: instance, uuid: FRAN, copyConfig: false });
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(server.dir, 'world', 'level.dat'), later, later);

  const r = lw.importFromLocal(server, { instanceDir: instance, saveFolder });
  assert.equal(r.needsConfirm, true);
  assert.match(r.reason, /ha cambiado/);
  assert.ok(fs.existsSync(path.join(server.dir, 'world')), 'sin confirmar no se toca nada');
  assert.equal(fs.readdirSync(server.dir).filter((f) => f.includes('antes-de-restaurar') || f.includes('importando')).length, 0);

  assert.equal(lw.importFromLocal(server, { instanceDir: instance, saveFolder, force: true }).playerRestored, true);
});

test('detecta instancias de CurseForge / Prism / .minecraft', () => {
  const home = tmpDir();
  writeFile(path.join(home, 'cf', 'All The Mods', 'mods', 'a.jar'), 'x');
  writeFile(path.join(home, 'cf', 'Vacía', 'nada.txt'), 'x');
  fs.mkdirSync(path.join(home, 'prism', 'Mi pack', 'minecraft', 'saves'), { recursive: true });
  fs.mkdirSync(path.join(home, '.minecraft', 'saves'), { recursive: true });
  const found = lw.detectInstances([
    { launcher: 'CurseForge', dir: path.join(home, 'cf'), sub: '' },
    { launcher: 'Prism', dir: path.join(home, 'prism'), sub: 'minecraft' },
    { launcher: 'Minecraft', single: path.join(home, '.minecraft') },
  ]);
  assert.deepEqual(found.map((f) => f.label), ['All The Mods (CurseForge)', '.minecraft (Minecraft)', 'Mi pack (Prism)']);
});

test('valida carpeta, jugador y nombre de partida', () => {
  const server = makeServer();
  assert.throws(() => lw.exportToLocal(server, { instanceDir: tmpDir(), uuid: FRAN }), /no parece de Minecraft/);
  assert.throws(() => lw.exportToLocal(server, { instanceDir: makeInstance(), uuid: 'yo' }), /qué jugador/);
  assert.throws(() => lw.importFromLocal(server, { instanceDir: makeInstance(), saveFolder: '../world', uuid: FRAN }), /no válida/);
});
