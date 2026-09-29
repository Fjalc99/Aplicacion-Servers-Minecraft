const test = require('node:test');
const assert = require('node:assert/strict');
const playit = require('../src/playit');

test('dirección de playit: se limpia y se valida', () => {
  assert.equal(playit.normalizeJoinAddress('  algo.joinmc.link '), 'algo.joinmc.link');
  assert.equal(playit.normalizeJoinAddress('algo.gl.joinmc.link:12345'), 'algo.gl.joinmc.link:12345');
  assert.equal(playit.normalizeJoinAddress('tcp://algo.joinmc.link/'), 'algo.joinmc.link');
  assert.equal(playit.normalizeJoinAddress(''), null);
  assert.throws(() => playit.normalizeJoinAddress('con espacios.link'), /joinmc/);
  assert.throws(() => playit.normalizeJoinAddress('algo.link:99999'), /joinmc/);
});

test('detectar el programa de playit devuelve sí o no, sin romper', async () => {
  assert.equal(typeof (await playit.isAgentRunning()), 'boolean');
});
