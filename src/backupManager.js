const fs = require('fs');
const path = require('path');
const { createZip, extractZip } = require('./zipWriter');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function worldInfo(server) {
  const levelName = (server.properties && server.properties['level-name']) || 'world';
  return { levelName, dir: path.join(server.dir, levelName) };
}

function backupsDir(server) {
  const dir = path.join(server.dir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups(server) {
  const dir = backupsDir(server);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { fileName: f, path: full, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function walk(dir, baseDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, baseDir));
    } else if (entry.isFile()) {
      out.push({ name: path.relative(baseDir, full).split(path.sep).join('/'), filePath: full });
    }
  }
  return out;
}

/**
 * Comprime la carpeta del mundo tal cual está ahora mismo en backups/<server.dir>.
 * Poda automáticamente los backups más antiguos por encima de maxBackups.
 * onProgress(info) se reenvía tal cual desde createZip (ver zipWriter.js) para
 * poder mostrar una barra de progreso real durante el backup.
 */
async function createBackup(server, { maxBackups = 10, onProgress } = {}) {
  const { levelName, dir } = worldInfo(server);
  if (!fs.existsSync(dir)) {
    throw new Error(`No se encuentra la carpeta del mundo ("${levelName}"); todavía no hay nada que respaldar.`);
  }
  const entries = walk(dir, server.dir); // nombres relativos empiezan por "<levelName>/..."
  if (entries.length === 0) {
    throw new Error('La carpeta del mundo está vacía; no hay nada que respaldar.');
  }

  const fileName = `backup-${levelName}-${timestamp()}.zip`;
  const outPath = path.join(backupsDir(server), fileName);
  await createZip(entries, outPath, onProgress);

  const all = listBackups(server);
  if (all.length > maxBackups) {
    for (const old of all.slice(maxBackups)) {
      fs.rmSync(old.path, { force: true });
    }
  }

  return { fileName, path: outPath, size: fs.statSync(outPath).size };
}

/**
 * Restaura un backup. El mundo actual (si existe) NO se borra: se renombra con
 * un sufijo "antes-de-restaurar-<fecha>" por seguridad, en vez de eliminarlo.
 */
function restoreBackup(server, fileName) {
  const zipPath = path.join(backupsDir(server), fileName);
  if (!fs.existsSync(zipPath)) throw new Error('No se encuentra ese backup.');

  const { levelName, dir } = worldInfo(server);
  let renamedTo = null;
  if (fs.existsSync(dir)) {
    renamedTo = `${levelName}.antes-de-restaurar-${timestamp()}`;
    fs.renameSync(dir, path.join(server.dir, renamedTo));
  }
  extractZip(zipPath, server.dir);
  return { restoredTo: dir, previousWorldSavedAs: renamedTo };
}

function deleteBackup(server, fileName) {
  const zipPath = path.join(backupsDir(server), fileName);
  fs.rmSync(zipPath, { force: true });
}

module.exports = { listBackups, createBackup, restoreBackup, deleteBackup };
