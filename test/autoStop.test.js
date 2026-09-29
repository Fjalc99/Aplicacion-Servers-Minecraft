const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-autostop-');
const store = require('../src/store');
const javaProcess = require('../src/javaProcess');
const { createAppCore, autoStopConfig } = require('../src/appCore');

const MINUTE = 20; // en los tests, "un minuto" son 20 ms
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Se simula el proceso de Minecraft: se guardan los avisos que el núcleo le
// pasa (listo, jugadores...) y se controla qué estado devuelve.
const original = { ...javaProcess };
let callbacks = null;
let fakeStatus = { state: 'offline', players: [] };
let stopped = [];

test.beforeEach(() => {
  callbacks = null;
  stopped = [];
  fakeStatus = { state: 'starting', players: [], startedAt: Date.now(), readyAt: null };
  javaProcess.startServer = (server, cbs) => { callbacks = cbs; };
  javaProcess.getStatus = () => fakeStatus;
  javaProcess.isRunning = () => fakeStatus.state !== 'offline';
  javaProcess.stopServer = (id) => { stopped.push(id); fakeStatus = { ...fakeStatus, state: 'stopping' }; };
});
test.afterEach(() => Object.assign(javaProcess, original));

function saveServer(extra = {}) {
  store.saveServer({
    id: 's1', name: 'Mundo', dir: path.join(process.env.DATA_DIR, 's1'), memory: 1024,
    properties: { 'server-port': 25565 }, launch: { type: 'jar', value: 'server.jar' },
    createdAt: new Date().toISOString(), ...extra,
  });
}

function goOnline(core, players = []) {
  fakeStatus = { ...fakeStatus, state: 'online', players, readyAt: Date.now() };
  callbacks.onReady();
}

test('viene activado por defecto a los 10 minutos', () => {
  assert.deepEqual(autoStopConfig({}), { enabled: true, minutes: 10 });
  assert.deepEqual(autoStopConfig({ autoStop: { enabled: false, minutes: 30 } }), { enabled: false, minutes: 30 });
});

test('mientras carga no cuenta; ya en línea y vacío, se apaga solo', async () => {
  saveServer({ autoStop: { enabled: true, minutes: 3 } });
  const core = createAppCore({ send() {}, notify() {}, minuteMs: MINUTE });
  core.handlers['servers:start']('s1');

  await wait(MINUTE * 5);
  assert.deepEqual(stopped, [], 'no debe apagarse mientras está arrancando');

  goOnline(core);
  const status = core.handlers['servers:status']('s1');
  assert.ok(status.autoStopAt > Date.now(), 'la cuenta atrás tiene que verse en el estado');

  await wait(MINUTE * 3 + 40);
  assert.deepEqual(stopped, ['s1']);
});

test('si entra alguien se cancela, y al irse todos vuelve a empezar', async () => {
  saveServer({ autoStop: { enabled: true, minutes: 3 } });
  const core = createAppCore({ send() {}, notify() {}, minuteMs: MINUTE });
  core.handlers['servers:start']('s1');
  goOnline(core);

  fakeStatus = { ...fakeStatus, players: ['Steve'] };
  callbacks.onPlayersChange(['Steve']);
  assert.equal(core.handlers['servers:status']('s1').autoStopAt, null);
  await wait(MINUTE * 5);
  assert.deepEqual(stopped, [], 'con alguien jugando no se apaga');

  fakeStatus = { ...fakeStatus, players: [] };
  callbacks.onPlayersChange([]);
  await wait(MINUTE * 3 + 40);
  assert.deepEqual(stopped, ['s1']);
});

test('desactivado no se apaga, y los minutos se validan', async () => {
  saveServer();
  const core = createAppCore({ send() {}, notify() {}, minuteMs: MINUTE });
  assert.throws(() => core.handlers['servers:updateAutoStop']({ id: 's1', enabled: true, minutes: 0 }), /entre 1 y 240/);
  core.handlers['servers:updateAutoStop']({ id: 's1', enabled: false, minutes: 1 });

  core.handlers['servers:start']('s1');
  goOnline(core);
  await wait(MINUTE * 4);
  assert.deepEqual(stopped, []);
  assert.equal(store.getServer('s1').autoStop.enabled, false);
});

test('al apagarse el servidor se cancela la cuenta atrás', async () => {
  saveServer({ autoStop: { enabled: true, minutes: 3 } });
  const core = createAppCore({ send() {}, notify() {}, minuteMs: MINUTE });
  core.handlers['servers:start']('s1');
  goOnline(core);
  fakeStatus = { state: 'offline', players: [] };
  await callbacks.onExit({ code: 0, crashed: false, recentLogText: '' });
  await wait(MINUTE * 4);
  assert.deepEqual(stopped, []);
});
