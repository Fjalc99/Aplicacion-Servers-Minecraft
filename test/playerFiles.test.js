const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readList, removeByNameFromFile, REMOVE_COMMANDS } = require('../src/playerFiles');
const { tmpDir, writeFile } = require('./helpers');

test('readList devuelve [] si no existe o está corrupto', () => {
  const dir = tmpDir();
  assert.deepEqual(readList(dir, 'ops'), []);
  writeFile(path.join(dir, 'ops.json'), '{no es json');
  assert.deepEqual(readList(dir, 'ops'), []);
});

test('readList rechaza tipos de lista desconocidos', () => {
  assert.throws(() => readList(tmpDir(), 'inventada'), /Lista desconocida/);
});

test('removeByNameFromFile elimina sin distinguir mayúsculas y guarda', () => {
  const dir = tmpDir();
  writeFile(
    path.join(dir, 'whitelist.json'),
    JSON.stringify([{ uuid: '1', name: 'Steve' }, { uuid: '2', name: 'Alex' }])
  );
  const left = removeByNameFromFile(dir, 'whitelist', 'steve');
  assert.deepEqual(left.map((p) => p.name), ['Alex']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf-8'));
  assert.deepEqual(onDisk.map((p) => p.name), ['Alex']);
});

test('REMOVE_COMMANDS genera los comandos correctos', () => {
  assert.equal(REMOVE_COMMANDS.whitelist('Steve'), 'whitelist remove Steve');
  assert.equal(REMOVE_COMMANDS.ops('Steve'), 'deop Steve');
  assert.equal(REMOVE_COMMANDS.bans('Steve'), 'pardon Steve');
});
