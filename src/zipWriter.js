const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Crea un .zip válido (formato ZIP estándar, sin dependencias externas) con los
 * ficheros indicados. entries: [{ name, filePath }]. Devuelve la ruta creada.
 *
 * onProgress(info) se llama después de procesar cada fichero, con
 * { doneCount, totalCount, doneBytes, totalBytes, currentFile }, para poder
 * mostrar una barra de progreso real (por bytes, no solo por número de
 * ficheros, ya que un backup de mundo o un pack de mods tiene tamaños muy
 * dispares por fichero). Es async y cede el hilo entre fichero y fichero para
 * no bloquear el resto de la app mientras comprime.
 */
async function createZip(entries, outputPath, onProgress) {
  const parts = [];
  const centralRecords = [];
  let offset = 0;
  const { time, dosDate } = toDosDateTime(new Date());

  const totalBytes = entries.reduce((sum, e) => {
    try {
      return sum + fs.statSync(e.filePath).size;
    } catch (err) {
      return sum;
    }
  }, 0);
  let doneBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const data = fs.readFileSync(entry.filePath);
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(entry.name, 'utf-8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localOffset = offset;
    parts.push(localHeader, nameBuf, payload);
    offset += localHeader.length + nameBuf.length + payload.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralRecords.push(Buffer.concat([centralHeader, nameBuf]));

    doneBytes += data.length;
    if (onProgress) {
      onProgress({
        doneCount: i + 1,
        totalCount: entries.length,
        doneBytes,
        totalBytes,
        currentFile: entry.name,
      });
    }
    // Cede el hilo cada pocos ficheros para que el resto de la app (IPC, UI)
    // pueda seguir respondiendo mientras se comprime.
    if (i % 3 === 0) await yieldToEventLoop();
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralRecords);
  offset += centralDirBuf.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirBuf.length, 12);
  end.writeUInt32LE(centralDirStart, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outputPath, Buffer.concat([...parts, centralDirBuf, end]));
  return outputPath;
}

/**
 * Extrae un .zip estándar (nuestro o de cualquier otro origen) dentro de destDir,
 * recreando la estructura de carpetas que tenga guardada. Sin dependencias externas.
 */
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);

  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Fichero ZIP no válido o corrupto.');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16); // inicio del directorio central

  const extracted = [];

  for (let n = 0; n < totalEntries; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('El directorio central del ZIP está corrupto.');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf-8', offset + 46, offset + 46 + nameLen);

    const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const rawData = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(rawData) : rawData;

    const destPath = path.join(destDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, data);
    }
    extracted.push(name);

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return extracted;
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

module.exports = { createZip, extractZip, createZipFromDirectory };
