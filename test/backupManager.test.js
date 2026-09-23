const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBackup, listBackups, restoreBackup, deleteBackup } = require('../src/backupManager');
const { tmpDir, writeFile } = require('./helpers');

function fakeServer() {
  const dir = tmpDir();
  writeFile(path.join(dir, 'world', 'level.dat'), 'v1');
  writeFile(path.join(dir, 'world', 'region', 'r.0.0.mca'), 'region-v1');
  return { id: 'x', dir, properties: { 'level-name': 'world' } };
}

test('createBackup falla si no hay mundo', async () => {
  const server = { dir: tmpDir(), properties: {} };
  await assert.rejects(createBackup(server), /No se encuentra la carpeta del mundo/);
});

test('createBackup + restoreBackup recupera el mundo y guarda el anterior', async () => {
  const server = fakeServer();
  const { fileName } = await createBackup(server);
  assert.equal(listBackups(server).length, 1);

  // Se modifica el mundo después del backup
  fs.writeFileSync(path.join(server.dir, 'world', 'level.dat'), 'v2');

  const result = restoreBackup(server, fileName);
  assert.equal(fs.readFileSync(path.join(server.dir, 'world', 'level.dat'), 'utf-8'), 'v1');
  assert.equal(fs.readFileSync(path.join(server.dir, 'world', 'region', 'r.0.0.mca'), 'utf-8'), 'region-v1');
  assert.ok(result.previousWorldSavedAs, 'el mundo anterior debe conservarse renombrado');
  assert.equal(
    fs.readFileSync(path.join(server.dir, result.previousWorldSavedAs, 'level.dat'), 'utf-8'),
    'v2'
  );
});

test('createBackup poda los backups más antiguos por encima de maxBackups', async () => {
  const server = fakeServer();
  const backupsDir = path.join(server.dir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  // Backups "viejos" con fechas escalonadas en el pasado
  for (let i = 0; i < 3; i++) {
    const f = writeFile(path.join(backupsDir, `backup-world-viejo-${i}.zip`), 'x');
    const t = new Date(Date.now() - (i + 1) * 3600 * 1000);
    fs.utimesSync(f, t, t);
  }
  await createBackup(server, { maxBackups: 2 });
  const names = listBackups(server).map((b) => b.fileName);
  assert.equal(names.length, 2);
  assert.ok(names.includes('backup-world-viejo-0.zip'), 'se conserva el viejo más reciente');
  assert.ok(!names.includes('backup-world-viejo-2.zip'), 'se borra el más antiguo');
});

test('deleteBackup elimina el fichero', async () => {
  const server = fakeServer();
  const { fileName } = await createBackup(server);
  deleteBackup(server, fileName);
  assert.equal(listBackups(server).length, 0);
});
