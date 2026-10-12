const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { promisify } = require('util');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0xf) << 5) |
    (date.getDate() & 0x1f);
  return { time, dosDate };
}

const fsp = fs.promises;
const deflateRawAsync = promisify(zlib.deflateRaw);
const inflateRawAsync = promisify(zlib.inflateRaw);

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
// Errores de lectura que significan "otro programa tiene este fichero abierto/bloqueado"
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Crea un .zip estándar (sin dependencias externas) con los ficheros indicados.
 * entries: [{ name, filePath }].
 *
 * Se escribe directamente a disco fichero a fichero (no se monta el ZIP entero
 * en memoria), así que sirve para backups completos de varios GB. Usa ZIP64
 * automáticamente si el ZIP pasa de 4 GB o de 65.535 ficheros. Mientras se
 * escribe se llama "<nombre>.zip.part" y solo se renombra al terminar, para que
 * nunca aparezca un backup a medias en la lista.
 *
 * onProgress(info) se llama después de cada fichero con
 * { doneCount, totalCount, doneBytes, totalBytes, currentFile }.
 *
 * options.skipUnreadable: si un fichero está bloqueado por otro programa (p. ej.
 * el servidor en marcha en Windows), se salta en vez de fallar todo el backup.
 *
 * Devuelve { path, count, skipped: [{ name, reason }] }.
 */
async function createZip(entries, outputPath, onProgress, { skipUnreadable = false } = {}) {
  const sizes = entries.map((e) => {
    try {
      return fs.statSync(e.filePath).size;
    } catch (err) {
      return 0;
    }
  });
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const { time, dosDate } = toDosDateTime(new Date());

  const tmpPath = `${outputPath}.part`;
  const fh = await fsp.open(tmpPath, 'w');
  const centralRecords = [];
  const skipped = [];
  let offset = 0;
  let doneBytes = 0;

  const write = async (buf) => {
    await fh.write(buf, 0, buf.length, null);
    offset += buf.length;
  };

  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let data;
      try {
        data = sizes[i] < 256 * 1024 ? fs.readFileSync(entry.filePath) : await fsp.readFile(entry.filePath);
      } catch (err) {
        if (!skipUnreadable || !LOCKED_CODES.has(err.code)) throw err;
        skipped.push({ name: entry.name, reason: err.code });
        data = null;
      }

      if (data) {
        const crc = crc32(data);
        // Los ficheros pequeños se comprimen en el momento (más rápido); los
        // grandes en segundo plano para no congelar la app.
        const compressed =
          data.length === 0 ? data : data.length < 256 * 1024 ? zlib.deflateRawSync(data) : await deflateRawAsync(data);
        const useDeflate = compressed.length < data.length;
        const payload = useDeflate ? compressed : data;
        const method = useDeflate ? 8 : 0;
        const nameBuf = Buffer.from(entry.name, 'utf-8');
        const localOffset = offset;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6); // nombres en UTF-8
        localHeader.writeUInt16LE(method, 8);
        localHeader.writeUInt16LE(time, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(payload.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);
        await write(Buffer.concat([localHeader, nameBuf, payload]));

        // Si el fichero empieza más allá de los 4 GB, su posición va en un campo ZIP64.
        const needsZip64 = localOffset > UINT32_MAX;
        const extra = Buffer.alloc(needsZip64 ? 12 : 0);
        if (needsZip64) {
          extra.writeUInt16LE(0x0001, 0);
          extra.writeUInt16LE(8, 2);
          extra.writeBigUInt64LE(BigInt(localOffset), 4);
        }

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(needsZip64 ? 45 : 20, 4);
        centralHeader.writeUInt16LE(needsZip64 ? 45 : 20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(method, 10);
        centralHeader.writeUInt16LE(time, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(payload.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(extra.length, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(needsZip64 ? UINT32_MAX : localOffset, 42);
        centralRecords.push(Buffer.concat([centralHeader, nameBuf, extra]));
      }

      doneBytes += sizes[i];
      if (onProgress) {
        onProgress({
          doneCount: i + 1,
          totalCount: entries.length,
          doneBytes,
          totalBytes,
          currentFile: entry.name,
        });
      }
      // Cede el hilo de vez en cuando para que el resto de la app siga respondiendo.
      if (i % 20 === 0) await yieldToEventLoop();
    }

    const count = centralRecords.length;
    const centralDirStart = offset;
    const centralDirBuf = Buffer.concat(centralRecords);
    await write(centralDirBuf);

    const zip64 = count > UINT16_MAX - 1 || centralDirStart > UINT32_MAX - 1 || centralDirBuf.length > UINT32_MAX - 1;
    if (zip64) {
      const zip64EndOffset = offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(centralDirBuf.length), 40);
      rec.writeBigUInt64LE(BigInt(centralDirStart), 48);
      await write(rec);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
      locator.writeUInt32LE(1, 16);
      await write(locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64 ? UINT16_MAX : count, 8);
    end.writeUInt16LE(zip64 ? UINT16_MAX : count, 10);
    end.writeUInt32LE(zip64 ? UINT32_MAX : centralDirBuf.length, 12);
    end.writeUInt32LE(zip64 ? UINT32_MAX : centralDirStart, 16);
    end.writeUInt16LE(0, 20);
    await write(end);

    await fh.close();
    fs.renameSync(tmpPath, outputPath);
    return { path: outputPath, count, skipped };
  } catch (err) {
    await fh.close().catch(() => {});
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Lee el índice (directorio central) de un ZIP sin cargar el fichero entero en
 * memoria. Admite ZIP64. Devuelve [{ name, method, compSize, size, localOffset }].
 */
function readCentralDirectory(fd) {
  const fileSize = fs.fstatSync(fd).size;
  const tailLen = Math.min(fileSize, 22 + 65535 + 20);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen);

  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Fichero ZIP no válido o corrupto.');

  let total = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (total === UINT16_MAX || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const rec = Buffer.alloc(56);
      fs.readSync(fd, rec, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('El ZIP (ZIP64) está corrupto.');
      total = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
  }

  if (cdOffset + cdSize > fileSize) throw new Error('El directorio central del ZIP está corrupto.');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);

  const entries = [];
  let p = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('El directorio central del ZIP está corrupto.');
    }
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf-8', p + 46, p + 46 + nameLen);

    // Campo extra ZIP64: solo trae los valores que no cabían (en este orden).
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === UINT32_MAX) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (compSize === UINT32_MAX) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (localOffset === UINT32_MAX) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }

    entries.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Ruta de destino segura: un ZIP no puede escribir fuera de destDir (rutas con "../" o absolutas). */
function safeDestination(destDir, name) {
  const base = path.resolve(destDir);
  const full = path.resolve(base, name);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`El ZIP contiene una ruta no permitida: "${name}"`);
  }
  return full;
}

/** Lista el contenido de un ZIP (y comprueba que se puede leer y que sus rutas son seguras). */
function readZipEntries(zipPath, destDirForCheck = os.tmpdir()) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const entries = readCentralDirectory(fd);
    for (const entry of entries) {
      safeDestination(destDirForCheck, entry.name);
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`"${entry.name}" usa un tipo de compresión no soportado.`);
      }
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function readEntryData(fd, entry) {
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, entry.localOffset);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('El ZIP está corrupto.');
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = Buffer.alloc(entry.compSize);
  if (entry.compSize > 0) fs.readSync(fd, raw, 0, entry.compSize, dataStart);
  return raw;
}

/**
 * Lee un único archivo de dentro de un ZIP/JAR (p. ej. META-INF/mods.toml de un
 * mod) sin extraer nada. Devuelve un Buffer, o null si no existe.
 */
function readZipEntry(zipPath, entryName) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const entry = readCentralDirectory(fd).find((e) => e.name === entryName);
    if (!entry || (entry.method !== 0 && entry.method !== 8)) return null;
    const raw = readEntryData(fd, entry);
    return entry.method === 8 ? zlib.inflateRawSync(raw) : raw;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extrae un .zip estándar (nuestro o de cualquier otro origen) dentro de destDir,
 * recreando la estructura de carpetas. Se niega a escribir fuera de destDir.
 */
function extractZip(zipPath, destDir) {
  const entries = readZipEntries(zipPath, destDir);
  const fd = fs.openSync(zipPath, 'r');
  try {
    for (const entry of entries) {
      const destPath = safeDestination(destDir, entry.name);
      if (entry.name.endsWith('/')) {
        fs.mkdirSync(destPath, { recursive: true });
        continue;
      }
      const raw = readEntryData(fd, entry);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.method === 8 ? zlib.inflateRawSync(raw) : raw);
    }
  } finally {
    fs.closeSync(fd);
  }
  return entries.map((e) => e.name);
}

/**
 * Igual que extractZip pero sin bloquear la app (para restaurar backups de
 * varios GB) y con el mismo onProgress que createZip.
 */
async function extractZipAsync(zipPath, destDir, onProgress) {
  const entries = readZipEntries(zipPath, destDir);
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  let doneBytes = 0;
  const fd = fs.openSync(zipPath, 'r');
  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const destPath = safeDestination(destDir, entry.name);
      if (entry.name.endsWith('/')) {
        fs.mkdirSync(destPath, { recursive: true });
      } else {
        const raw = readEntryData(fd, entry);
        let data = raw;
        if (entry.method === 8) data = raw.length < 256 * 1024 ? zlib.inflateRawSync(raw) : await inflateRawAsync(raw);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        await fsp.writeFile(destPath, data);
      }
      doneBytes += entry.size;
      if (onProgress) {
        onProgress({ doneCount: i + 1, totalCount: entries.length, doneBytes, totalBytes, currentFile: entry.name });
      }
      if (i % 20 === 0) await yieldToEventLoop();
    }
  } finally {
    fs.closeSync(fd);
  }
  return entries.map((e) => e.name);
}

/**
 * Recorre una carpeta recursivamente y devuelve entries [{name, filePath}]
 * con rutas relativas en formato ZIP (separador "/"), listas para createZip.
 */
function listDirectoryEntries(rootDir, baseName) {
  const entries = [];
  function walk(currentDir, relPrefix) {
    for (const item of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, item.name);
      const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(fullPath, relPath);
      } else if (item.isFile()) {
        entries.push({ name: relPath, filePath: fullPath });
      }
    }
  }
  walk(rootDir, baseName || '');
  return entries;
}

/**
 * Comprime una carpeta entera (recursivo) en un .zip, con la propia carpeta
 * como primer nivel dentro del zip (p.ej. "world/level.dat", "world/region/...").
 * Acepta el mismo onProgress que createZip.
 */
async function createZipFromDirectory(dirPath, outputPath, baseName, onProgress) {
  const name = baseName || path.basename(dirPath);
  const entries = listDirectoryEntries(dirPath, name);
  return createZip(entries, outputPath, onProgress);
}

module.exports = { createZip, extractZip, extractZipAsync, readZipEntries, readZipEntry, createZipFromDirectory, listDirectoryEntries };
