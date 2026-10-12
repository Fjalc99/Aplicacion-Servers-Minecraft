const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const curseforge = require('./curseforge');
const { readZipEntry } = require('./zipWriter');

const MODRINTH_API = process.env.MSM_MODRINTH_URL || 'https://api.modrinth.com/v2'; // la variable es solo para tests
// Modrinth pide identificar la app que hace las peticiones.
const USER_AGENT = 'Fjalc99/Aplicacion-Servers-Minecraft (minecraft-server-manager)';

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

/** Ejecuta fn sobre cada elemento con como mucho "limit" a la vez, conservando el orden. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Lee la ficha que lleva cada mod dentro del .jar (META-INF/neoforge.mods.toml,
 * META-INF/mods.toml o fabric.mod.json): su nombre "bonito" y, si el propio
 * autor lo indica, que es solo de cliente. Se usa para los mods que no están
 * en Modrinth ni en CurseForge. Devuelve null si no se puede leer.
 */
function readJarMetadata(file) {
  try {
    for (const entry of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
      const buf = readZipEntry(file, entry);
      if (!buf) continue;
      const text = buf.toString('utf-8');
      // Solo cuenta lo que hay dentro del bloque [[mods]]: los bloques
      // [[dependencies.x]] también tienen modId (el de la dependencia, no el suyo).
      const block = modsBlock(text);
      const idMatch = block.match(/^\s*modId\s*=\s*["']([^"'\r\n]+)["']/m);
      const nameMatch = block.match(/^\s*displayName\s*=\s*["']([^"'\r\n]+)["']/m);
      const testMatch = text.match(/^\s*displayTest\s*=\s*["']([A-Z_]+)["']/m);
      const name = nameMatch && !nameMatch[1].includes('${') ? nameMatch[1].trim() : null;
      // IGNORE_SERVER_VERSION = "este mod no necesita estar en el servidor" (mods de cliente).
      const side = testMatch && testMatch[1] === 'IGNORE_SERVER_VERSION' ? 'client-only' : null;
      return { name, side, modId: idMatch ? idMatch[1].trim().toLowerCase() : null };
    }
    const fabric = readZipEntry(file, 'fabric.mod.json');
    if (fabric) {
      const json = JSON.parse(fabric.toString('utf-8'));
      return {
        name: json.name || null,
        side: json.environment === 'client' ? 'client-only' : null,
        modId: json.id ? String(json.id).toLowerCase() : null,
      };
    }
  } catch (err) {
    /* jar dañado o ficha ilegible: no pasa nada, se queda sin identificar */
  }
  return null;
}

/** Texto del primer bloque [[mods]] de un mods.toml (hasta la siguiente cabecera). */
function modsBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\[\s*mods\s*\]\]/.test(l));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

async function modrinthLookup(hashes, fetchImpl) {
  const hashToVersion = {};
  for (const group of chunk(hashes, 100)) {
    const res = await fetchImpl(`${MODRINTH_API}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ hashes: group, algorithm: 'sha1' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Modrinth ha respondido con un error (${res.status}).`);
    Object.assign(hashToVersion, await res.json());
  }

  const projectIds = [...new Set(Object.values(hashToVersion).map((v) => v.project_id))];
  const projectsById = {};
  for (const group of chunk(projectIds, 100)) {
    const idsParam = encodeURIComponent(JSON.stringify(group));
    const res = await fetchImpl(`${MODRINTH_API}/projects?ids=${idsParam}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Modrinth ha respondido con un error (${res.status}).`);
    for (const p of await res.json()) projectsById[p.id] = p;
  }
  return { hashToVersion, projectsById };
}

/**
 * Analiza una carpeta de mods y decide, mod a mod, si va en el servidor.
 * Busca en este orden:
 *   1. Modrinth (por hash SHA-1).
 *   2. CurseForge (por fingerprint), si hay clave de API configurada.
 *   3. La ficha que trae el propio .jar (nombre y si se declara solo de cliente).
 *
 * Devuelve { results, warnings }. Cada resultado:
 *   { file, fileName, sha1, fingerprint, name, status, source, serverSide, clientSide,
 *     modrinthUrl, curseforgeUrl }
 *   status ∈ 'needed' | 'client-only' | 'unknown'
 *   source ∈ 'modrinth' | 'curseforge' | 'jar' | null (de dónde sale la decisión)
 */
async function analyzeMods(folder, { fetchImpl = fetch, curseforgeKey = curseforge.getApiKey() } = {}) {
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error('No se encuentra esa carpeta.');
  }
  const files = fs
    .readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith('.jar'))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(folder, f));
  if (files.length === 0) return { results: [], warnings: [] };

  const warnings = [];

  // Cada .jar se lee una sola vez para sacar sus dos "huellas".
  const prints = await mapLimit(files, 4, async (file) => {
    const data = await fs.promises.readFile(file);
    return {
      sha1: crypto.createHash('sha1').update(data).digest('hex'),
      fingerprint: curseforgeKey ? curseforge.fingerprint(data) : null,
    };
  });

  let modrinth = { hashToVersion: {}, projectsById: {} };
  try {
    modrinth = await modrinthLookup(prints.map((p) => p.sha1), fetchImpl);
  } catch (err) {
    warnings.push(`No se ha podido consultar Modrinth: ${err.message || err}`);
  }

  // CurseForge solo para lo que Modrinth no conoce.
  let cfByPrint = new Map();
  const missing = prints.filter((p) => !modrinth.hashToVersion[p.sha1]).map((p) => p.fingerprint);
  if (!curseforgeKey) {
    if (missing.length > 0) warnings.push('curseforge-sin-clave');
  } else if (missing.length > 0) {
    try {
      cfByPrint = await curseforge.lookupFingerprints(missing, { apiKey: curseforgeKey, fetchImpl });
    } catch (err) {
      warnings.push(`No se ha podido consultar CurseForge: ${err.message}`);
    }
  }

  const metas = files.map((file) => readJarMetadata(file));

  const results = files.map((file, i) => {
    const fileName = path.basename(file);
    const { sha1, fingerprint } = prints[i];
    const meta = metas[i];
    const base = {
      file,
      fileName,
      sha1,
      fingerprint,
      name: fileName,
      status: 'unknown',
      source: null,
      serverSide: null,
      clientSide: null,
      modrinthUrl: null,
      curseforgeUrl: null,
      modId: meta ? meta.modId : null,
      projectId: null,
    };

    const version = modrinth.hashToVersion[sha1];
    if (version) {
      const project = modrinth.projectsById[version.project_id];
      const serverSide = project ? project.server_side : null; // required | optional | unsupported
      return {
        ...base,
        name: project ? project.title : fileName,
        status: serverSide === 'unsupported' ? 'client-only' : 'needed',
        source: 'modrinth',
        projectId: version.project_id,
        serverSide,
        clientSide: project ? project.client_side : null,
        modrinthUrl: project ? `https://modrinth.com/mod/${project.slug}` : null,
      };
    }

    const cf = fingerprint != null ? cfByPrint.get(fingerprint) : null;
    if (cf) {
      const side = cf.side || (meta && meta.side);
      return {
        ...base,
        name: cf.name || (meta && meta.name) || fileName,
        // Si CurseForge no dice el lado (muchos autores no lo marcan), se deja
        // como "por revisar", aunque ya con su nombre y su enlace.
        status: side === 'client-only' ? 'client-only' : side === 'server' ? 'needed' : 'unknown',
        source: cf.side ? 'curseforge' : meta && meta.side ? 'jar' : 'curseforge',
        serverSide: cf.server ? 'required' : cf.client ? 'unsupported' : null,
        // Lado cliente: con la etiqueta "Client" hace falta en el cliente; con solo
        // "Server", es un mod solo de servidor.
        clientSide: cf.client ? 'required' : cf.server ? 'unsupported' : null,
        curseforgeUrl: cf.url,
      };
    }

    if (meta) {
      return {
        ...base,
        name: meta.name || fileName,
        status: meta.side === 'client-only' ? 'client-only' : 'unknown',
        source: meta.side ? 'jar' : null,
        clientSide: meta.side === 'client-only' ? 'required' : null,
      };
    }
    return base;
  });

  markDuplicates(results);
  return { results, warnings };
}

/**
 * Detecta el mismo mod repetido en varias versiones (mismo modId del .jar o
 * mismo proyecto de Modrinth): en el servidor eso impide arrancar. Añade a cada
 * uno duplicateGroup (nombres de los otros ficheros) y, de cada grupo, marca
 * con keep=true el que conviene dejar (el que ya está igual en el servidor, si
 * no el identificado, si no el de nombre más alto).
 */
function markDuplicates(results) {
  const groups = new Map();
  results.forEach((r, i) => {
    const keys = [r.modId && `id:${r.modId}`, r.projectId && `p:${r.projectId}`].filter(Boolean);
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(i);
    }
  });
  const seen = new Set();
  for (const set of groups.values()) {
    const members = [...set];
    if (members.length < 2) continue;
    const signature = members.sort((a, b) => a - b).join(',');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const score = (r) => (r.serverState === 'same' ? 4 : 0) + (r.source === 'modrinth' || r.source === 'curseforge' ? 2 : 0);
    const keep = members.slice().sort((a, b) =>
      score(results[b]) - score(results[a]) || results[b].fileName.localeCompare(results[a].fileName, undefined, { numeric: true })
    )[0];
    for (const i of members) {
      results[i].duplicateOf = members.filter((j) => j !== i).map((j) => results[j].fileName);
      results[i].keepDuplicate = i === keep;
    }
  }
}

/** ¿Son la misma ruta? (en Windows, sin distinguir mayúsculas). */
function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
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
  const alreadySame = [];
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
    if (samePath(r.file, dest)) {
      // Se está analizando la propia carpeta mods del servidor: ya está ahí.
      skipped.push(r.fileName);
      continue;
    }
    const existedBefore = fs.existsSync(dest);
    // Ya está idéntico en el servidor (según el análisis): no hace falta reescribirlo.
    if (existedBefore && r.serverState === 'same') {
      alreadySame.push(r.fileName);
      continue;
    }

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

  return { destination: serverModsDir, copiedNew, copiedOverwritten, alreadySame, skipped, failed };
}

/**
 * Añade a cada resultado del análisis un campo serverState comparándolo con lo
 * que YA hay en la carpeta mods/ del servidor, por hash (no solo por nombre):
 * 'new' (no existe ahí), 'same' (existe y es idéntico), 'different' (existe
 * con ese nombre pero el contenido no coincide: probablemente una actualización).
 * Así, en re-análisis sucesivos, solo hace falta fijarse en 'new'/'different'.
 */
async function diffAgainstServer(analysisResults, serverModsDir) {
  return Promise.all(
    analysisResults.map(async (r) => {
      const destPath = path.join(serverModsDir, r.fileName);
      if (!fs.existsSync(destPath)) {
        return { ...r, serverState: 'new' };
      }
      try {
        const existingHash = await sha1File(destPath);
        return { ...r, serverState: existingHash === r.sha1 ? 'same' : 'different' };
      } catch (e) {
        return { ...r, serverState: 'new' };
      }
    })
  );
}

module.exports = {
  analyzeMods,
  applyModsToServer,
  sha1File,
  selectModsForServer,
  diffAgainstServer,
  readJarMetadata,
  samePath,
  markDuplicates,
};

/**
 * Filtra los resultados del análisis dejando solo los que deben ir al servidor.
 */
function selectModsForServer(analysisResults, { includeUnknown = true } = {}) {
  return analysisResults.filter(
    (r) => r.status === 'needed' || (r.status === 'unknown' && includeUnknown)
  );
}
