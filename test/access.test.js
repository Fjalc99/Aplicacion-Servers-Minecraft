const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-access-');
const access = require('../web/access');

const admin = { username: 'fran', role: 'admin' };
const pepe = { username: 'pepe', role: 'amigo', canSendCommands: false };
const ana = { username: 'ana', role: 'amigo', canSendCommands: false };

const server = (id, extra = {}) => ({
  id, name: id, memory: 2048, properties: { 'server-port': 25565, 'level-name': 'world' }, ...extra,
});

function ctx(servers, running = [], totalMemMb = 64000) {
  return { allServers: servers, isRunning: (id) => running.includes(id), totalMemMb };
}

test('quién ve cada servidor', () => {
  const compartido = server('compartido');
  const dePepe = server('p1', { owner: 'pepe' });
  assert.equal(access.accessTo(admin, dePepe), 'admin');
  assert.equal(access.accessTo(pepe, compartido), 'shared');
  assert.equal(access.accessTo(pepe, dePepe), 'owner');
  assert.equal(access.accessTo({ ...pepe, username: 'PEPE' }, dePepe), 'owner'); // sin distinguir mayúsculas
  assert.equal(access.accessTo(ana, dePepe), null);
});

test('un amigo no puede tocar servidores de otro amigo (ni saber si existen)', () => {
  const servers = [server('p1', { owner: 'pepe' })];
  const res = access.authorize(ana, 'servers:start', 'p1', ctx(servers));
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(access.authorize(ana, 'servers:start', 'no-existe', ctx(servers)).status, 404);
});

test('crear: límite de servidores, de RAM y puerto libre asignado automáticamente', () => {
  const used = [server('a', { properties: { 'server-port': 25566 } }), server('b', { properties: { 'server-port': 25567 } })];
  const ok = access.authorize(pepe, 'servers:create', { name: 'Mío', memory: 3072, properties: { 'server-port': 25565 } }, ctx(used));
  assert.equal(ok.ok, true);
  assert.equal(ok.arg.properties['server-port'], 25568);

  assert.match(access.authorize(pepe, 'servers:create', { memory: 16384 }, ctx([])).error, /RAM/);

  const full = [server('p1', { owner: 'pepe' }), server('p2', { owner: 'pepe' })];
  assert.match(access.authorize(pepe, 'servers:create', { memory: 2048 }, ctx(full)).error, /máximo/);
  // Los servidores de otros no cuentan para su límite
  assert.equal(access.authorize(ana, 'servers:create', { memory: 2048 }, ctx(full)).ok, true);

  assert.match(access.authorize(pepe, 'servers:create', { properties: { 'level-name': '../../Windows' } }, ctx([])).error, /nombre del mundo/);
});

test('en sus servidores: puede configurar, pero sin rutas raras, puertos ajenos ni RAM de más', () => {
  const mine = server('p1', { owner: 'pepe', properties: { 'server-port': 25566, 'level-name': 'world' } });
  const other = server('x', { properties: { 'server-port': 25570 } });
  const c = ctx([mine, other]);

  assert.equal(access.authorize(pepe, 'servers:updateProperties', { id: 'p1', properties: { difficulty: 'hard', 'server-port': 25566 } }, c).ok, true);
  assert.equal(access.authorize(pepe, 'servers:updateProperties', { id: 'p1', properties: { 'server-port': 25571 } }, c).ok, true);
  assert.match(access.authorize(pepe, 'servers:updateProperties', { id: 'p1', properties: { 'level-name': '../../../x' } }, c).error, /nombre del mundo/);
  assert.match(access.authorize(pepe, 'servers:updateProperties', { id: 'p1', properties: { 'server-port': 25570 } }, c).error, /puerto/);
  assert.match(access.authorize(pepe, 'servers:updateProperties', { id: 'p1', properties: { 'server-port': 80 } }, c).error, /puerto/);

  assert.equal(access.authorize(pepe, 'servers:updateMemory', { id: 'p1', memory: 4096 }, c).ok, true);
  assert.match(access.authorize(pepe, 'servers:updateMemory', { id: 'p1', memory: 8192 }, c).error, /RAM/);

  for (const ch of ['servers:delete', 'servers:restoreBackup', 'servers:sendCommand']) {
    assert.equal(access.authorize(pepe, ch, { id: 'p1' }, c).ok, true, ch);
  }
  assert.equal(access.authorize(pepe, 'servers:stop', { id: 'p1', force: true }, c).ok, true);
});

test('nunca puede usar rutas del disco, ni en sus propios servidores', () => {
  const c = ctx([server('p1', { owner: 'pepe' })]);
  for (const [ch, arg] of [
    ['servers:importWorld', { serverId: 'p1', worldFolder: 'C:\\Users' }],
    ['mods:analyze', { folder: 'C:\\', serverId: 'p1' }],
    ['mods:apply', { serverId: 'p1', results: [] }],
    ['servers:openFolder', 'p1'],
    ['servers:import', { folderPath: 'C:\\' }],
    ['servers:detectExisting', 'C:\\'],
  ]) {
    assert.equal(access.authorize(pepe, ch, arg, c).ok, false, ch);
  }
});

test('encender: uno propio a la vez y sin pasarse de la RAM del PC', () => {
  const p1 = server('p1', { owner: 'pepe' });
  const p2 = server('p2', { owner: 'pepe' });
  const shared = server('compartido', { memory: 6000 });

  assert.match(access.authorize(pepe, 'servers:start', 'p2', ctx([p1, p2], ['p1'])).error, /a la vez/);
  assert.equal(access.authorize(pepe, 'servers:start', 'p2', ctx([p1, p2], [])).ok, true);

  // PC de 8 GB: con el compartido (6000 MB) encendido no caben 2048 MB más
  assert.match(access.authorize(pepe, 'servers:start', 'p1', ctx([p1, shared], ['compartido'], 8192)).error, /memoria/);
  // Y tampoco puede encender el compartido si ya hay otro que lo impida
  assert.match(access.authorize(ana, 'servers:start', 'compartido', ctx([p1, shared], ['p1'], 8192)).error, /memoria/);
});

test('servidores compartidos: se mantienen las reglas limitadas', () => {
  const c = ctx([server('compartido')]);
  assert.equal(access.authorize(pepe, 'servers:start', 'compartido', c).ok, true);
  assert.equal(access.authorize(pepe, 'servers:createBackup', 'compartido', c).ok, true);
  assert.equal(access.authorize(pepe, 'servers:delete', { id: 'compartido' }, c).ok, false);
  assert.equal(access.authorize(pepe, 'servers:stop', { id: 'compartido', force: true }, c).ok, false);
  assert.equal(access.authorize(pepe, 'servers:sendCommand', { id: 'compartido', command: 'op pepe' }, c).ok, false);
  assert.equal(access.authorize({ ...pepe, canSendCommands: true }, 'servers:sendCommand', { id: 'compartido' }, c).ok, true);
});

test('el admin puede con todo', () => {
  const c = ctx([server('p1', { owner: 'pepe' })]);
  for (const ch of ['servers:delete', 'mods:analyze', 'servers:import', 'servers:start']) {
    assert.equal(access.authorize(admin, ch, { id: 'p1' }, c).ok, true, ch);
  }
});
