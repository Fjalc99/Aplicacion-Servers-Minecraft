const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-home-');
delete process.env.MSM_DIRECCION_PUBLICA;

const settings = require('../src/settings');
const javaProcess = require('../src/javaProcess');
const store = require('../src/store');
const { createAppCore } = require('../src/appCore');

test('un servidor que no está en marcha aparece como apagado', () => {
  assert.deepEqual(javaProcess.getStatus('no-existe'), { state: 'offline', players: [], startedAt: null, readyAt: null });
});

test('dirección pública: se guarda limpia y se valida', () => {
  assert.equal(settings.getPublicAddress(), null);
  assert.equal(settings.setPublicAddress('  https://tuservidor.duckdns.org/  '), 'tuservidor.duckdns.org');
  assert.equal(settings.getPublicAddress(), 'tuservidor.duckdns.org');
  assert.throws(() => settings.setPublicAddress('no vale con espacios'), /dominio/);
  assert.equal(settings.setPublicAddress(''), null); // vacío = quitarla
  assert.equal(settings.getPublicAddress(), null);

  process.env.MSM_DIRECCION_PUBLICA = 'desde-variable.example';
  assert.equal(settings.getPublicAddress(), 'desde-variable.example');
  delete process.env.MSM_DIRECCION_PUBLICA;
});

test('servers:status junta estado, jugadores máximos y puerto', () => {
  const core = createAppCore({ send() {}, notify() {} });
  store.saveServer({
    id: 's1', name: 's1', dir: path.join(process.env.DATA_DIR, 's1'), memory: 1024,
    properties: { 'max-players': 8, 'server-port': 25570 }, launch: { type: 'jar', value: 'server.jar' },
    createdAt: new Date().toISOString(),
  });
  const status = core.handlers['servers:status']('s1');
  assert.equal(status.state, 'offline');
  assert.equal(status.maxPlayers, 8);
  assert.equal(status.port, 25570);
  assert.ok(Math.abs(status.now - Date.now()) < 1000, 'incluye la hora del PC servidor para el reloj');
  assert.throws(() => core.handlers['servers:status']('no-existe'), /no encontrado/i);
});

test('app:connectionInfo devuelve la dirección pública y una IP local (o null)', () => {
  const core = createAppCore({ send() {}, notify() {} });
  core.handlers['app:setPublicAddress']('mi.dominio.org');
  const info = core.handlers['app:connectionInfo']();
  assert.equal(info.publicAddress, 'mi.dominio.org');
  assert.ok(info.lanIp === null || /^\d+\.\d+\.\d+\.\d+$/.test(info.lanIp));
});
