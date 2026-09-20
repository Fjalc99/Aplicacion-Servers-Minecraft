const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODRINTH_API = 'https://api.modrinth.com/v2';

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/**
 * Analiza una carpeta de mods de cliente y determina, mod a mod, si hace falta
 * (o es opcional) en el servidor, si es exclusivo de cliente, o si no se ha
 * podido identificar en Modrinth (requiere decisión manual).
 *
 * Devuelve: [{ file, fileName, sha1, name, status, serverSide, clientSide, modrinthUrl }]
 * status ∈ 'needed' | 'client-only' | 'unknown'
 */
async function analyzeMods(clientModsFolder) {
  const files = fs
    .readdirSync(clientModsFolder)
    .filter((f) => f.toLowerCase().endsWith('.jar'))
    .map((f) => path.join(clientModsFolder, f));

  if (files.length === 0) return [];

  const hashes = await Promise.all(files.map((f) => sha1File(f)));

  // Modrinth soporta hasta ~unos cientos de hashes por lote; usamos lotes de 50 por seguridad
  const hashToVersion = {};
  for (const group of chunk(hashes, 50)) {
    const res = await fetch(`${MODRINTH_API}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: group, algorithm: 'sha1' }),
    });
    if (res.ok) {
      const data = await res.json();
      Object.assign(hashToVersion, data);
    }
  }

  const projectIds = [
    ...new Set(Object.values(hashToVersion).map((v) => v.project_id)),
  ];

  let projectsById = {};
  if (projectIds.length > 0) {
    for (const group of chunk(projectIds, 50)) {
      const idsParam = encodeURIComponent(JSON.stringify(group));
      const res = await fetch(`${MODRINTH_API}/projects?ids=${idsParam}`);
      if (res.ok) {
        const projects = await res.json();
        for (const p of projects) projectsById[p.id] = p;
      }
    }
  }

  const results = files.map((file, i) => {
    const fileName = path.basename(file);
    const sha1 = hashes[i];
    const version = hashToVersion[sha1];

    if (!version) {
      return {
        file,
        fileName,
        sha1,
        name: fileName,
        status: 'unknown',
        serverSide: null,
        clientSide: null,
        modrinthUrl: null,
      };
    }

    const project = projectsById[version.project_id];
    const serverSide = project ? project.server_side : null; // required | optional | unsupported
    const clientSide = project ? project.client_side : null;
    const status = serverSide === 'unsupported' ? 'client-only' : 'needed';

    return {
      file,
      fileName,
      sha1,
      name: project ? project.title : fileName,
      status,
      serverSide,
      clientSide,
      modrinthUrl: project ? `https://modrinth.com/mod/${project.slug}` : null,
    };
  });

  return results;
}

/**
 * Copia a la carpeta mods/ del servidor los ficheros indicados (por defecto,
 * todos los que no sean 'client-only'). Verifica cada copia justo después de
 * hacerla (por si el antivirus la elimina al instante) y distingue entre
 * ficheros nuevos y ficheros que ya existían con ese nombre.
 */
function applyModsToServer(serverModsDir, analysisResults, { includeUnknown = true } = {}) {
  fs.mkdirSync(serverModsDir, { recursive: true });
  const copiedNew = [];
  const copiedOverwritten = [];
  const skipped = [];
  const failed = [];

  for (const r of analysisResults) {
    const shouldCopy =
      r.status === 'needed' || (r.status === 'unknown' && includeUnknown);
    if (!shouldCopy) {
      skipped.push(r.fileName);
      continue;
    }

    const dest = path.join(serverModsDir, r.fileName);
    const existedBefore = fs.existsSync(dest);

    try {
      fs.copyFileSync(r.file, dest);
    } catch (err) {
      failed.push({ fileName: r.fileName, error: err.message });
      continue;
    }

    if (!fs.existsSync(dest)) {
      // Se copió sin error pero ya no está: normalmente es el antivirus
      // eliminándolo justo después (los .jar de mods son un falso positivo habitual).
      failed.push({
        fileName: r.fileName,
        error: 'El fichero desapareció justo después de copiarse (probablemente lo ha eliminado el antivirus).',
      });
      continue;
    }

    if (existedBefore) copiedOverwritten.push(r.fileName);
    else copiedNew.push(r.fileName);
  }

  return { destination: serverModsDir, copiedNew, copiedOverwritten, skipped, failed };
}

module.exports = { analyzeMods, applyModsToServer, sha1File, selectModsForServer };

/**
 * Filtra los resultados del análisis dejando solo los que deben ir al servidor.
 */
function selectModsForServer(analysisResults, { includeUnknown = true } = {}) {
  return analysisResults.filter(
    (r) => r.status === 'needed' || (r.status === 'unknown' && includeUnknown)
  );
}
