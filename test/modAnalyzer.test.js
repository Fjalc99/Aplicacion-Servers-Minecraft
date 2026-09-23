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
