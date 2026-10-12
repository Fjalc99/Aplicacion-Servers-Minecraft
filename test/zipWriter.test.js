const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createZip, extractZip, createZipFromDirectory } = require('../src/zipWriter');
const { tmpDir, writeFile } = require('./helpers');

test('createZip + extractZip conservan contenido y estructura', async () => {
  const src = tmpDir();
  const big = crypto.randomBytes(200 * 1024); // no comprimible
  const text = 'hola '.repeat(10000); // muy comprimible
  writeFile(path.join(src, 'a.txt'), text);
  writeFile(path.join(src, 'bin.dat'), big);

  const zipPath = path.join(tmpDir(), 'out.zip');
  await createZip(
    [
      { name: 'carpeta/a.txt', filePath: path.join(src, 'a.txt') },
      { name: 'carpeta/sub/bin.dat', filePath: path.join(src, 'bin.dat') },
    ],
    zipPath
  );

  const dest = tmpDir();
  const extracted = extractZip(zipPath, dest);
  assert.deepEqual(extracted.sort(), ['carpeta/a.txt', 'carpeta/sub/bin.dat']);
  assert.equal(fs.readFileSync(path.join(dest, 'carpeta/a.txt'), 'utf-8'), text);
  assert.ok(fs.readFileSync(path.join(dest, 'carpeta/sub/bin.dat')).equals(big));
});

test('createZip informa del progreso hasta completarse', async () => {
  const src = tmpDir();
  writeFile(path.join(src, 'x.txt'), 'x'.repeat(5000));
  const updates = [];
  await createZip([{ name: 'x.txt', filePath: path.join(src, 'x.txt') }], path.join(src, 'x.zip'), (info) =>
    updates.push(info)
  );
  assert.ok(updates.length > 0, 'debe emitir al menos un evento de progreso');
});

test('createZipFromDirectory usa la carpeta como primer nivel', async () => {
  const world = path.join(tmpDir(), 'world');
  writeFile(path.join(world, 'level.dat'), 'nivel');
  writeFile(path.join(world, 'region', 'r.0.0.mca'), 'region');
  const zipPath = path.join(tmpDir(), 'w.zip');
  await createZipFromDirectory(world, zipPath);

  const dest = tmpDir();
  extractZip(zipPath, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'world', 'level.dat'), 'utf-8'), 'nivel');
  assert.equal(fs.readFileSync(path.join(dest, 'world', 'region', 'r.0.0.mca'), 'utf-8'), 'region');
});

test('extractZip rechaza un fichero que no es ZIP', () => {
  const bad = writeFile(path.join(tmpDir(), 'bad.zip'), 'esto no es un zip');
  assert.throws(() => extractZip(bad, tmpDir()), /ZIP no válido/);
});

test('extractZip se niega a escribir fuera de la carpeta destino ("../")', async () => {
  const src = tmpDir();
  writeFile(path.join(src, 'x.txt'), 'malo');
  const zipPath = path.join(tmpDir(), 'evil.zip');
  await createZip([{ name: '../fuera.txt', filePath: path.join(src, 'x.txt') }], zipPath);

  const parent = tmpDir();
  const dest = path.join(parent, 'dest');
  fs.mkdirSync(dest);
  assert.throws(() => extractZip(zipPath, dest), /ruta no permitida/);
  assert.equal(fs.existsSync(path.join(parent, 'fuera.txt')), false);
});

test('createZip escribe primero en .part y no deja restos si falla', async () => {
  const outDir = tmpDir();
  const zipPath = path.join(outDir, 'out.zip');
  await assert.rejects(createZip([{ name: 'no.txt', filePath: path.join(outDir, 'no-existe.txt') }], zipPath));
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('createZip con skipUnreadable salta lo que no puede leer y lo informa', async () => {
  const src = tmpDir();
  writeFile(path.join(src, 'ok.txt'), 'bien');
  const zipPath = path.join(tmpDir(), 'out.zip');
  const result = await createZip(
    [
      { name: 'ok.txt', filePath: path.join(src, 'ok.txt') },
      { name: 'desaparecido.txt', filePath: path.join(src, 'desaparecido.txt') },
    ],
    zipPath,
    null,
    { skipUnreadable: true }
  );
  assert.equal(result.count, 1);
  assert.deepEqual(result.skipped.map((s) => s.name), ['desaparecido.txt']);
  const dest = tmpDir();
  assert.deepEqual(extractZip(zipPath, dest), ['ok.txt']);
});

test('extractZipAsync extrae igual que extractZip e informa del progreso', async () => {
  const { extractZipAsync } = require('../src/zipWriter');
  const src = tmpDir();
  writeFile(path.join(src, 'mods', 'a.jar'), crypto.randomBytes(300 * 1024));
  writeFile(path.join(src, 'config', 'b.toml'), 'x = 1');
  const zipPath = path.join(tmpDir(), 'out.zip');
  await createZipFromDirectory(src, zipPath, 'srv');

  const dest = tmpDir();
  let last = null;
  await extractZipAsync(zipPath, dest, (info) => (last = info));
  assert.equal(last.doneCount, 2);
  assert.equal(last.doneBytes, last.totalBytes);
  assert.ok(fs.readFileSync(path.join(dest, 'srv', 'mods', 'a.jar')).equals(fs.readFileSync(path.join(src, 'mods', 'a.jar'))));
  assert.equal(fs.readFileSync(path.join(dest, 'srv', 'config', 'b.toml'), 'utf-8'), 'x = 1');
});
