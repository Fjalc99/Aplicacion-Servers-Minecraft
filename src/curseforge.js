/**
 * CurseForge: identifica mods por su "huella" (fingerprint), igual que hace la
 * app de CurseForge, para los mods que no están en Modrinth.
 *
 * La API de CurseForge exige una clave (gratuita) que se pide en
 * https://console.curseforge.com. Se guarda en settings.json (clave
 * "curseforgeApiKey") o se lee de la variable de entorno CURSEFORGE_API_KEY.
 * La clave nunca se devuelve a la interfaz: solo si está puesta o no.
 */
const settings = require('./settings');

const API = () => process.env.MSM_CURSEFORGE_URL || 'https://api.curseforge.com'; // la variable es solo para tests
const MINECRAFT_GAME_ID = 432;

/**
 * MurmurHash2 de 32 bits (semilla 1), quitando antes los bytes de espacio en
 * blanco (tab, salto de línea, retorno de carro y espacio). Es el "fingerprint"
 * con el que CurseForge identifica cada archivo.
 */
function fingerprint(buffer) {
  let length = 0;
  const clean = Buffer.allocUnsafe(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) clean[length++] = b;
  }
  return murmur2(clean.subarray(0, length), 1);
}

function murmur2(data, seed) {
  const m = 0x5bd1e995;
  let len = data.length;
  let h = (seed ^ len) >>> 0;
  let i = 0;
  while (len >= 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
    i += 4;
    len -= 4;
  }
  switch (len) {
    case 3:
      h ^= data[i + 2] << 16;
    // falls through
    case 2:
      h ^= data[i + 1] << 8;
    // falls through
    case 1:
      h ^= data[i];
      h = Math.imul(h, m);
  }
  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h >>> 0;
}

function getApiKey() {
  return settings.readSettings().curseforgeApiKey || process.env.CURSEFORGE_API_KEY || null;
}

/** Lo que puede ver la interfaz: si hay clave y de dónde sale, nunca la clave. */
function publicInfo() {
  const saved = settings.readSettings().curseforgeApiKey;
  if (saved) return { configured: true, source: 'settings', keyHint: `…${saved.slice(-4)}` };
  if (process.env.CURSEFORGE_API_KEY) return { configured: true, source: 'env', keyHint: 'variable CURSEFORGE_API_KEY' };
  return { configured: false };
}

async function request(pathname, { method = 'GET', body, apiKey, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${API()}${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error('No se ha podido contactar con CurseForge. Comprueba la conexión a internet.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'CurseForge ha rechazado la clave (error ' + response.status + '). Si la has copiado entera con el botón de copiar, ' +
        'lo más probable es que tu cuenta aún no tenga acceso a la API: las apps que no son juegos tienen que pedirlo con el ' +
        'formulario "apply for a key" de docs.curseforge.com/rest-api. Cuando te lo aprueben, esta misma clave funcionará.'
    );
  }
  if (!response.ok) throw new Error(`CurseForge ha respondido con un error (${response.status}).`);
  return response.json();
}

/** Guarda la clave tras comprobar que CurseForge la acepta. */
async function setApiKey(value, { fetchImpl = fetch } = {}) {
  const key = String(value || '').trim();
  if (key.length < 20 || /\s/.test(key)) {
    throw new Error('Eso no parece una clave de API de CurseForge. Cópiala entera desde console.curseforge.com → API keys.');
  }
  await request(`/v1/games/${MINECRAFT_GAME_ID}`, { apiKey: key, fetchImpl });
  const current = settings.readSettings();
  current.curseforgeApiKey = key;
  settings.writeSettings(current);
  return publicInfo();
}

function removeApiKey() {
  const current = settings.readSettings();
  delete current.curseforgeApiKey;
  settings.writeSettings(current);
  return publicInfo();
}

/**
 * Lado (cliente/servidor) según las etiquetas de entorno que CurseForge pone
 * en gameVersions ("Client", "Server"). null si el autor no las ha indicado.
 */
function sideFromGameVersions(gameVersions) {
  const tags = new Set((gameVersions || []).map((v) => String(v).toLowerCase()));
  const client = tags.has('client');
  const server = tags.has('server');
  if (server) return 'server';
  if (client) return 'client-only';
  return null;
}

/** Qué etiquetas de entorno trae el archivo: { client: bool, server: bool }. */
function environmentTags(gameVersions) {
  const tags = new Set((gameVersions || []).map((v) => String(v).toLowerCase()));
  return { client: tags.has('client'), server: tags.has('server') };
}

/**
 * Busca en CurseForge una lista de fingerprints. Devuelve un Map
 * fingerprint -> { modId, name, url, side } solo con los que reconoce.
 */
async function lookupFingerprints(fingerprints, { apiKey = getApiKey(), fetchImpl = fetch } = {}) {
  const found = new Map();
  if (!apiKey || fingerprints.length === 0) return found;

  const matches = [];
  for (let i = 0; i < fingerprints.length; i += 500) {
    const group = fingerprints.slice(i, i + 500);
    const result = await request(`/v1/fingerprints/${MINECRAFT_GAME_ID}`, {
      method: 'POST',
      body: { fingerprints: group },
      apiKey,
      fetchImpl,
    });
    matches.push(...((result && result.data && result.data.exactMatches) || []));
  }
  if (matches.length === 0) return found;

  const modIds = [...new Set(matches.map((m) => m.id || (m.file && m.file.modId)).filter(Boolean))];
  const modsById = new Map();
  for (let i = 0; i < modIds.length; i += 500) {
    const result = await request('/v1/mods', {
      method: 'POST',
      body: { modIds: modIds.slice(i, i + 500), filterPcOnly: false },
      apiKey,
      fetchImpl,
    });
    for (const mod of (result && result.data) || []) modsById.set(mod.id, mod);
  }

  for (const match of matches) {
    const file = match.file || {};
    const modId = match.id || file.modId;
    const mod = modsById.get(modId);
    const print = Number(file.fileFingerprint);
    if (!print) continue;
    found.set(print >>> 0, {
      modId,
      name: (mod && mod.name) || file.displayName || null,
      url: (mod && mod.links && mod.links.websiteUrl) || (mod && mod.slug ? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}` : null),
      side: sideFromGameVersions(file.gameVersions),
      ...environmentTags(file.gameVersions),
    });
  }
  return found;
}

module.exports = { fingerprint, murmur2, getApiKey, publicInfo, setApiKey, removeApiKey, lookupFingerprints, sideFromGameVersions };
