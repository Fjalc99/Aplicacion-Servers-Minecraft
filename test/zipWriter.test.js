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
