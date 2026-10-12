/**
 * Comparar los mods de un CLIENTE (tu Minecraft o el de un amigo) con los del
 * servidor, para que coincidan y se pueda entrar a jugar:
 *
 *   - missing      -> el servidor lo tiene, el cliente no, y hace falta en el cliente.
 *   - different    -> los dos lo tienen, pero en otra versión.
 *   - serverOnly   -> el cliente tiene un mod que es solo de servidor (sobra).
 *   - notOnServer  -> el cliente tiene un mod "de los dos lados" que el servidor
 *                     no tiene (al conectar, el servidor suele echarte por esto).
 *   - clientOnly   -> mods solo de cliente (gráficos, minimapa...): están bien.
 *   - same         -> idénticos en los dos.
 *
 * Aplicar los cambios NUNCA borra nada del cliente: lo que sobra o se sustituye
 * se mueve a una carpeta "mods-quitados-<fecha>" junto a la carpeta de mods.
 */
const fs = require('fs');
const path = require('path');
const { analyzeMods } = require('./modAnalyzer');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Índice para encontrar "el mismo mod" aunque cambie el nombre del archivo o la versión. */
function buildIndex(list) {
  const index = { sha: new Map(), project: new Map(), modId: new Map(), file: new Map() };
  for (const r of list) {
    if (!index.sha.has(r.sha1)) index.sha.set(r.sha1, r);
    if (r.projectId && !index.project.has(r.projectId)) index.project.set(r.projectId, r);
    if (r.modId && !index.modId.has(r.modId)) index.modId.set(r.modId, r);
    const fileKey = r.fileName.toLowerCase();
    if (!index.file.has(fileKey)) index.file.set(fileKey, r);
  }
  return index;
}

function findMatch(r, index) {
  return (
    index.sha.get(r.sha1) ||
    (r.projectId && index.project.get(r.projectId)) ||
    (r.modId && index.modId.get(r.modId)) ||
    index.file.get(r.fileName.toLowerCase()) ||
    null
  );
}

/**
 * Cuánto necesita el CLIENTE un mod del servidor:
 *   'required' | 'optional' | 'server-only' | 'unknown'
 */
function clientNeed(r) {
  if (r.clientSide === 'required') return 'required';
  if (r.clientSide === 'optional') return 'optional';
  if (r.clientSide === 'unsupported') return 'server-only';
  return 'unknown';
}

const pick = (r) => ({
  fileName: r.fileName,
  name: r.name,
  file: r.file,
  modrinthUrl: r.modrinthUrl,
  curseforgeUrl: r.curseforgeUrl,
  source: r.source,
});

/**
 * Compara una carpeta de mods de cliente con la carpeta mods del servidor.
 * opts se pasa tal cual a analyzeMods (fetchImpl, curseforgeKey) para los tests.
 */
async function compareClientWithServer(clientDir, serverModsDir, opts = {}) {
  if (!fs.existsSync(serverModsDir)) throw new Error('El servidor todavía no tiene carpeta mods.');
  const [client, server] = await Promise.all([analyzeMods(clientDir, opts), analyzeMods(serverModsDir, opts)]);
  const serverIndex = buildIndex(server.results);
  const clientIndex = buildIndex(client.results);

  const out = { missing: [], different: [], serverOnly: [], notOnServer: [], clientOnly: [], same: [] };

  for (const c of client.results) {
    // Un mod solo de servidor sobra en el cliente aunque el servidor también lo tenga.
    if (c.clientSide === 'unsupported') {
      out.serverOnly.push(pick(c));
      continue;
    }
    const s = findMatch(c, serverIndex);
    if (s) {
      if (s.sha1 === c.sha1) out.same.push(pick(c));
      else out.different.push({ ...pick(c), server: pick(s) });
      continue;
    }
    if (c.status === 'client-only') out.clientOnly.push(pick(c));
    else out.notOnServer.push({ ...pick(c), status: c.status });
  }

  for (const s of server.results) {
    if (findMatch(s, clientIndex)) continue;
    const need = clientNeed(s);
    if (need === 'server-only') continue; // no hace falta en el cliente
    if (s.status === 'client-only') continue; // mod de cliente metido en el servidor: no se propone
    out.missing.push({ ...pick(s), need });
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  for (const list of Object.values(out)) list.sort(byName);

  const warnings = [...new Set([...client.warnings, ...server.warnings])];
  return { ...out, warnings };
}

/** Solo nombres de archivo .jar sueltos (sin rutas) que existan dentro de dir. */
function safeJar(dir, fileName) {
  const name = String(fileName || '');
  if (!name.toLowerCase().endsWith('.jar') || name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new Error(`Nombre de mod no válido: ${name}`);
  }
  return path.join(dir, name);
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to); // otra unidad: copiar y borrar
    fs.rmSync(from, { force: true });
  }
}

/**
 * Aplica los cambios elegidos en la carpeta del cliente:
 *   remove:  [nombre de archivo del cliente]          -> se aparta
 *   copy:    [nombre de archivo del servidor]         -> se copia al cliente
 *   replace: [{ client, server }]                     -> se aparta el del cliente y se copia el del servidor
 */
function applyClientSync(clientDir, serverModsDir, { remove = [], copy = [], replace = [] } = {}) {
  if (!fs.existsSync(clientDir)) throw new Error('No se encuentra la carpeta del cliente.');
  let asideDir = null;
  const aside = () => {
    if (!asideDir) {
      asideDir = path.join(path.dirname(path.resolve(clientDir)), `mods-quitados-${timestamp()}`);
      fs.mkdirSync(asideDir, { recursive: true });
    }
    return asideDir;
  };

  const result = { removed: [], copied: [], replaced: [], failed: [], asideDir: null };

  const putAside = (fileName) => {
    const from = safeJar(clientDir, fileName);
    if (fs.existsSync(from)) moveFile(from, path.join(aside(), fileName));
  };

  const copyFromServer = (fileName) => {
    const from = safeJar(serverModsDir, fileName);
    const to = safeJar(clientDir, fileName);
    if (!fs.existsSync(from)) throw new Error('ya no está en el servidor');
    if (fs.existsSync(to)) putAside(fileName); // mismo nombre con otro contenido: el viejo se aparta
    fs.copyFileSync(from, to);
    if (!fs.existsSync(to)) throw new Error('desapareció justo después de copiarse (¿antivirus?)');
  };

  for (const fileName of remove) {
    try {
      putAside(fileName);
      result.removed.push(fileName);
    } catch (err) {
      result.failed.push({ fileName, error: err.message });
    }
  }
  for (const pair of replace) {
    try {
      putAside(pair.client);
      copyFromServer(pair.server);
      result.replaced.push(pair);
    } catch (err) {
      result.failed.push({ fileName: pair.client, error: err.message });
    }
  }
  for (const fileName of copy) {
    try {
      copyFromServer(fileName);
      result.copied.push(fileName);
    } catch (err) {
      result.failed.push({ fileName, error: err.message });
    }
  }

  result.asideDir = asideDir;
  return result;
}

module.exports = { compareClientWithServer, applyClientSync };
