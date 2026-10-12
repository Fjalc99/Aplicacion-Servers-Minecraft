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

// ---------------------------------------------------------------------------
// Backups completos (carpeta entera del servidor)
// ---------------------------------------------------------------------------
const { createFullBackup, restoreFullBackup, backupPath } = require('../src/backupManager');
const { readZipEntries } = require('../src/zipWriter');

function fakeFullServer() {
  const server = fakeServer();
  writeFile(path.join(server.dir, 'mods', 'create.jar'), 'mod-v1');
  writeFile(path.join(server.dir, 'config', 'create-common.toml'), 'cfg-v1');
  writeFile(path.join(server.dir, 'server.properties'), 'level-name=world\nserver-port=25565\n');
  writeFile(path.join(server.dir, 'ops.json'), '[]');
  writeFile(path.join(server.dir, 'libraries', 'net', 'neoforge', 'x.jar'), 'lib');
  // Lo que NO debe entrar:
  writeFile(path.join(server.dir, 'logs', 'latest.log'), 'log');
  writeFile(path.join(server.dir, 'crash-reports', 'crash.txt'), 'crash');
  writeFile(path.join(server.dir, 'world', 'session.lock'), 'lock');
  writeFile(path.join(server.dir, 'world.antes-de-restaurar-20250101-000000', 'level.dat'), 'viejo');
  writeFile(path.join(server.dir, 'backups', 'backup-world-anterior.zip'), 'zip');
  return server;
}

test('createFullBackup incluye mods, config, mundo... y excluye logs, backups y copias apartadas', async () => {
  const server = fakeFullServer();
  const result = await createFullBackup(server);
  assert.match(result.fileName, /^completo-\d{8}-\d{6}\.zip$/);
  assert.equal(result.kind, 'full');

  const names = readZipEntries(result.path).map((e) => e.name).sort();
  assert.deepEqual(names, [
    'config/create-common.toml',
    'libraries/net/neoforge/x.jar',
    'mods/create.jar',
    'ops.json',
    'server.properties',
    'world/level.dat',
    'world/region/r.0.0.mca',
  ]);

  const kinds = listBackups(server).map((b) => [b.fileName.split('-')[0], b.kind]);
  assert.ok(kinds.some(([p, k]) => p === 'completo' && k === 'full'));
  assert.ok(kinds.some(([p, k]) => p === 'backup' && k === 'world'));
});

test('restoreFullBackup devuelve la carpeta entera a ese momento y aparta la actual', async () => {
  const server = fakeFullServer();
  const { fileName } = await createFullBackup(server);

  // Cambios después del backup: mod actualizado, mod nuevo, config y mundo distintos
  fs.writeFileSync(path.join(server.dir, 'mods', 'create.jar'), 'mod-v2');
  writeFile(path.join(server.dir, 'mods', 'roto.jar'), 'mod que rompe el server');
  fs.writeFileSync(path.join(server.dir, 'config', 'create-common.toml'), 'cfg-v2');
  fs.writeFileSync(path.join(server.dir, 'world', 'level.dat'), 'v2');

  let progress = null;
  const result = await restoreFullBackup(server, fileName, { onProgress: (info) => (progress = info) });
  const read = (...p) => fs.readFileSync(path.join(server.dir, ...p), 'utf-8');

  assert.equal(read('mods', 'create.jar'), 'mod-v1');
  assert.equal(fs.existsSync(path.join(server.dir, 'mods', 'roto.jar')), false, 'el mod añadido después ya no está');
  assert.equal(read('config', 'create-common.toml'), 'cfg-v1');
  assert.equal(read('world', 'level.dat'), 'v1');
  assert.equal(progress.doneBytes, progress.totalBytes);

  // La versión anterior se conserva entera
  assert.match(result.previousSavedAs, /^backups\/antes-de-restaurar-completo-/);
  const aside = path.join(server.dir, ...result.previousSavedAs.split('/'));
  assert.equal(fs.readFileSync(path.join(aside, 'mods', 'roto.jar'), 'utf-8'), 'mod que rompe el server');
  assert.equal(fs.readFileSync(path.join(aside, 'world', 'level.dat'), 'utf-8'), 'v2');

  // Los backups siguen ahí
  assert.ok(listBackups(server).some((b) => b.fileName === fileName));
});

test('restoreFullBackup no toca nada si el ZIP está dañado', async () => {
  const server = fakeFullServer();
  writeFile(path.join(server.dir, 'backups', 'completo-20250101-000000.zip'), 'esto no es un zip');
  await assert.rejects(restoreFullBackup(server, 'completo-20250101-000000.zip'), /ZIP no válido/);
  assert.equal(fs.readFileSync(path.join(server.dir, 'mods', 'create.jar'), 'utf-8'), 'mod-v1');
  assert.ok(!fs.readdirSync(path.join(server.dir, 'backups')).some((f) => f.startsWith('antes-de-restaurar')));
});

test('los backups completos se podan aparte de los del mundo', async () => {
  const server = fakeFullServer();
  const dir = path.join(server.dir, 'backups');
  for (let i = 0; i < 3; i++) {
    const f = writeFile(path.join(dir, `completo-viejo-${i}.zip`), 'x');
    const t = new Date(Date.now() - (i + 1) * 3600 * 1000);
    fs.utimesSync(f, t, t);
  }
  await createFullBackup(server, { maxFullBackups: 2 });
  const names = listBackups(server).map((b) => b.fileName);
  assert.equal(names.filter((n) => n.startsWith('completo-')).length, 2);
  assert.ok(names.includes('completo-viejo-0.zip'));
  assert.ok(names.includes('backup-world-anterior.zip'), 'no se tocan los backups del mundo');
});

test('no se aceptan nombres de backup con rutas (../)', () => {
  const server = fakeServer();
  for (const bad of ['../server.properties.zip', '..\\x.zip', 'sub/x.zip', 'x.txt', '', '.zip']) {
    assert.throws(() => backupPath(server, bad), /no válido/, bad);
  }
  assert.throws(() => deleteBackup(server, '../../importante.zip'), /no válido/);
  assert.throws(() => restoreBackup(server, '../otro/backup.zip'), /no válido/);
});
