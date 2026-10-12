const fs = require('fs');
const path = require('path');
const { createZip, extractZip, extractZipAsync, readZipEntries } = require('./zipWriter');

// Backups del mundo: "backup-<mundo>-<fecha>.zip". Backups completos: "completo-<fecha>.zip".
const FULL_PREFIX = 'completo-';

// Lo que NO entra en un backup completo: las propias copias (si no, cada backup
// contendría a los anteriores), logs e informes de errores (se regeneran y
// pueden ocupar mucho), y el candado de sesión del mundo (lo crea el servidor
// al arrancar y en Windows está bloqueado mientras funciona).
const FULL_EXCLUDED_TOP = new Set(['backups', 'logs', 'crash-reports', 'debug']);
const ALWAYS_EXCLUDED_FILES = new Set(['session.lock']);
const SAVED_ASIDE_MARK = '.antes-de-restaurar-';

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

function isFullBackup(fileName) {
  return String(fileName).startsWith(FULL_PREFIX);
}

/**
 * Ruta de un backup a partir de su nombre. Solo vale un nombre de fichero .zip
 * dentro de backups/: nada de "../" ni rutas, para que nadie pueda leer, borrar
 * o restaurar ficheros fuera de esa carpeta.
 */
function backupPath(server, fileName) {
  const name = String(fileName || '');
  if (
    !name.toLowerCase().endsWith('.zip') ||
    name !== path.basename(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name.startsWith('.')
  ) {
    throw new Error('Nombre de backup no válido.');
  }
  return path.join(backupsDir(server), name);
}

function listBackups(server) {
  const dir = backupsDir(server);
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return {
        fileName: f,
        path: full,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: isFullBackup(f) ? 'full' : 'world',
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function walk(dir, baseDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, baseDir));
    } else if (entry.isFile() && !ALWAYS_EXCLUDED_FILES.has(entry.name.toLowerCase())) {
      out.push({ name: path.relative(baseDir, full).split(path.sep).join('/'), filePath: full });
    }
  }
  return out;
}

/** Borra los backups más antiguos de un tipo ("world" o "full") por encima de max. */
function prune(server, kind, max) {
  const ofKind = listBackups(server).filter((b) => b.kind === kind);
  for (const old of ofKind.slice(max)) fs.rmSync(old.path, { force: true });
}

/**
 * Comprime la carpeta del mundo tal cual está ahora mismo en backups/.
 * Poda automáticamente los backups de mundo más antiguos por encima de maxBackups.
 * onProgress(info) se reenvía tal cual desde createZip (ver zipWriter.js).
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
  const { skipped } = await createZip(entries, outPath, onProgress, { skipUnreadable: true });

  prune(server, 'world', maxBackups);
  return { fileName, path: outPath, size: fs.statSync(outPath).size, kind: 'world', skipped };
}

/** Ficheros que entran en un backup completo (rutas relativas a la carpeta del servidor). */
function fullBackupEntries(server) {
  const out = [];
  for (const entry of fs.readdirSync(server.dir, { withFileTypes: true })) {
    const lower = entry.name.toLowerCase();
    if (FULL_EXCLUDED_TOP.has(lower) || entry.name.includes(SAVED_ASIDE_MARK)) continue;
    const full = path.join(server.dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, server.dir));
    else if (entry.isFile() && !ALWAYS_EXCLUDED_FILES.has(lower)) out.push({ name: entry.name, filePath: full });
  }
  return out;
}

/**
 * Backup COMPLETO: toda la carpeta del servidor (mods, config, server.properties,
 * mundo, listas de jugadores, librerías de Forge/NeoForge, scripts de arranque...)
 * menos backups/, logs/ y crash-reports/. Se guarda como backups/completo-<fecha>.zip
 * y se conservan los maxFullBackups más recientes (ocupan mucho más que los del mundo).
 */
async function createFullBackup(server, { maxFullBackups = 3, onProgress } = {}) {
  if (!fs.existsSync(server.dir)) throw new Error('No se encuentra la carpeta del servidor.');
  const entries = fullBackupEntries(server);
  if (entries.length === 0) throw new Error('La carpeta del servidor está vacía; no hay nada que respaldar.');

  const fileName = `${FULL_PREFIX}${timestamp()}.zip`;
  const outPath = path.join(backupsDir(server), fileName);
  const { skipped } = await createZip(entries, outPath, onProgress, { skipUnreadable: true });

  prune(server, 'full', maxFullBackups);
  return { fileName, path: outPath, size: fs.statSync(outPath).size, kind: 'full', skipped };
}

/**
 * Restaura un backup del mundo. El mundo actual (si existe) NO se borra: se
 * renombra con un sufijo "antes-de-restaurar-<fecha>" por seguridad.
 */
function restoreBackup(server, fileName) {
  const zipPath = backupPath(server, fileName);
  if (!fs.existsSync(zipPath)) throw new Error('No se encuentra ese backup.');
  if (isFullBackup(fileName)) throw new Error('Ese es un backup completo; usa restoreFullBackup.');
  readZipEntries(zipPath, server.dir); // valida el ZIP antes de tocar nada

  const { levelName, dir } = worldInfo(server);
  let renamedTo = null;
  if (fs.existsSync(dir)) {
    renamedTo = `${levelName}${SAVED_ASIDE_MARK}${timestamp()}`;
    fs.renameSync(dir, path.join(server.dir, renamedTo));
  }
  extractZip(zipPath, server.dir);
  return { restoredTo: dir, previousWorldSavedAs: renamedTo };
}

/**
 * Restaura un backup completo: deja TODA la carpeta del servidor como estaba en
 * ese momento. Lo que hay ahora no se borra: se mueve entero a
 * backups/antes-de-restaurar-completo-<fecha>/ (mover dentro del mismo disco es
 * instantáneo). Si algo falla a mitad, se deshace y todo queda como estaba.
 * El servidor tiene que estar apagado (lo comprueba quien llama).
 */
async function restoreFullBackup(server, fileName, { onProgress } = {}) {
  const zipPath = backupPath(server, fileName);
  if (!fs.existsSync(zipPath)) throw new Error('No se encuentra ese backup.');
  if (!isFullBackup(fileName)) throw new Error('Ese backup es solo del mundo, no completo.');
  const entries = readZipEntries(zipPath, server.dir); // valida el ZIP antes de tocar nada
  if (entries.length === 0) throw new Error('El backup está vacío.');

  const asideName = `antes-de-restaurar-completo-${timestamp()}`;
  const asideDir = path.join(backupsDir(server), asideName);
  fs.mkdirSync(asideDir);

  const moved = [];
  const putBack = () => {
    for (const name of moved.reverse()) {
      try {
        fs.renameSync(path.join(asideDir, name), path.join(server.dir, name));
      } catch (err) {
        /* se queda en la carpeta apartada; no se pierde */
      }
    }
    try {
      fs.rmdirSync(asideDir);
    } catch (err) {
      /* no estaba vacía: mejor dejarla */
    }
  };

  try {
    for (const name of fs.readdirSync(server.dir)) {
      if (name.toLowerCase() === 'backups') continue;
      fs.renameSync(path.join(server.dir, name), path.join(asideDir, name));
      moved.push(name);
    }
  } catch (err) {
    putBack();
    throw new Error(
      `No se pudo apartar la versión actual (${err.code || err.message}). ¿Tienes algún archivo del servidor abierto en otro programa?`
    );
  }

  try {
    await extractZipAsync(zipPath, server.dir, onProgress);
  } catch (err) {
    // Se quita lo que se llegó a extraer y se devuelve todo a su sitio.
    for (const name of fs.readdirSync(server.dir)) {
      if (name.toLowerCase() === 'backups') continue;
      fs.rmSync(path.join(server.dir, name), { recursive: true, force: true });
    }
    putBack();
    throw new Error(`No se pudo restaurar el backup (${err.message}). Se ha dejado todo como estaba.`);
  }

  return { previousSavedAs: `backups/${asideName}` };
}

function deleteBackup(server, fileName) {
  fs.rmSync(backupPath(server, fileName), { force: true });
}

module.exports = {
  listBackups,
  createBackup,
  createFullBackup,
  restoreBackup,
  restoreFullBackup,
  deleteBackup,
  backupPath,
  isFullBackup,
};
