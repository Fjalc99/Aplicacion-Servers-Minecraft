const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeFile } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-fullbackup-');
const store = require('../src/store');
const javaProcess = require('../src/javaProcess');
const { createAppCore } = require('../src/appCore');

const original = { ...javaProcess };
let running = false;
let commands = [];
let callbacks = null;

test.beforeEach(() => {
  running = false;
  commands = [];
  callbacks = null;
  javaProcess.isRunning = () => running;
  javaProcess.getStatus = () => ({ state: running ? 'online' : 'offline', players: [] });
  javaProcess.startServer = (server, cbs) => { callbacks = cbs; running = true; };
  javaProcess.sendCommand = (id, cmd) => {
    commands.push(cmd);
    // El servidor "de verdad" contesta al guardar
    if (cmd === 'save-all flush') setImmediate(() => callbacks && callbacks.onLog('[Server thread/INFO]: Saved the game\n'));
  };
});
test.afterEach(() => Object.assign(javaProcess, original));

function makeServer(id = 'srv') {
  const dir = path.join(process.env.DATA_DIR, id);
  writeFile(path.join(dir, 'world', 'level.dat'), 'v1');
  writeFile(path.join(dir, 'mods', 'a.jar'), 'mod');
  writeFile(path.join(dir, 'server.properties'), 'level-name=world\nserver-port=25565\nmotd=Antes\n');
  const server = {
    id, name: 'Prueba', dir, memory: 1024,
    properties: { 'level-name': 'world', 'server-port': 25570, motd: 'Antes' },
    launch: { type: 'jar', value: 'server.jar' }, createdAt: new Date().toISOString(),
  };
  store.saveServer(server);
  return server;
}

const ctx = { reply: () => {} };
const newCore = () => createAppCore({ send: () => {}, notify: () => {} });

test('backup completo con el servidor encendido: save-off, save-all flush y save-on al terminar', async () => {
  const core = newCore();
  const server = makeServer('enmarcha');
  core.handlers['servers:start'](server.id, ctx);

  const result = await core.handlers['servers:createFullBackup'](server.id, ctx);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(commands, ['save-off', 'save-all flush', 'save-on']);
});

test('backup con el servidor apagado: no manda comandos', async () => {
  const core = newCore();
  const server = makeServer('apagado');
  const result = await core.handlers['servers:createFullBackup'](server.id, ctx);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(commands, []);
});

test('no se pueden hacer dos backups a la vez del mismo servidor', async () => {
  const core = newCore();
  const server = makeServer('doble');
  const [a, b] = await Promise.all([
    core.handlers['servers:createFullBackup'](server.id, ctx),
    core.handlers['servers:createBackup'](server.id, ctx),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.error, /Ya se está haciendo un backup/);
});

test('restaurar un backup completo: rechazado si está encendido; si no, recarga server.properties manteniendo el puerto', async () => {
  const core = newCore();
  const server = makeServer('restaurar');
  const { fileName } = await core.handlers['servers:createFullBackup'](server.id, ctx);

  fs.writeFileSync(path.join(server.dir, 'server.properties'), 'level-name=world\nserver-port=25570\nmotd=Despues\n');

  running = true;
  const refused = await core.handlers['servers:restoreBackup']({ id: server.id, fileName }, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Detén el servidor/);

  running = false;
  const result = await core.handlers['servers:restoreBackup']({ id: server.id, fileName }, ctx);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.kind, 'full');
  const saved = store.getServer(server.id);
  assert.equal(saved.properties.motd, 'Antes', 'se recarga la configuración del backup');
  assert.equal(Number(saved.properties['server-port']), 25570, 'el puerto actual se mantiene');
  assert.match(fs.readFileSync(path.join(server.dir, 'server.properties'), 'utf-8'), /server-port=25570/);
});

test('mientras se restaura no se puede encender el servidor', async () => {
  const core = newCore();
  const server = makeServer('bloqueo');
  // Un backup con bastantes ficheros para que la restauración dure varios ciclos
  for (let i = 0; i < 200; i++) writeFile(path.join(server.dir, 'world', 'region', `r.${i}.mca`), 'x'.repeat(1000));
  const { fileName } = await core.handlers['servers:createFullBackup'](server.id, ctx);

  const restoring = core.handlers['servers:restoreBackup']({ id: server.id, fileName }, ctx);
  assert.throws(() => core.handlers['servers:start'](server.id, ctx), /Se está restaurando/);
  assert.equal((await restoring).ok, true);
  core.handlers['servers:start'](server.id, ctx); // ya se puede
  assert.equal(running, true);
});

test('backupFilePath solo devuelve backups existentes de ese servidor', async () => {
  const core = newCore();
  const server = makeServer('ruta');
  const { fileName } = await core.handlers['servers:createFullBackup'](server.id, ctx);
  assert.equal(core.backupFilePath(server.id, fileName), path.join(server.dir, 'backups', fileName));
  assert.throws(() => core.backupFilePath(server.id, '../server.properties.zip'), /no válido/);
  assert.throws(() => core.backupFilePath(server.id, 'completo-nada.zip'), /No se encuentra/);
});

test('mods:analyze sobre la carpeta mods del propio servidor: no compara consigo misma (todo queda marcado)', async () => {
  const core = newCore();
  const server = makeServer('modsrv');
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); // Modrinth sin resultados
  try {
    const own = await core.handlers['mods:analyze']({ folder: path.join(server.dir, 'mods'), serverId: server.id }, ctx);
    assert.equal(own.ok, true, own.error);
    assert.equal(own.isServerModsFolder, true);
    assert.equal(own.results[0].serverState, undefined, 'sin "Ya está igual"');

    const clientDir = path.join(process.env.DATA_DIR, 'cliente-mods');
    writeFile(path.join(clientDir, 'a.jar'), 'mod');
    const client = await core.handlers['mods:analyze']({ folder: clientDir, serverId: server.id }, ctx);
    assert.equal(client.isServerModsFolder, false);
    assert.equal(client.results[0].serverState, 'same');
  } finally {
    global.fetch = originalFetch;
  }
});
