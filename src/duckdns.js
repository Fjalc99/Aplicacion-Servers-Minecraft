/**
 * DuckDNS: mantiene tu subdominio (p. ej. miserver.duckdns.org) apuntando a la
 * IP pública actual de tu conexión, para no tener que dar la IP a nadie ni
 * volver a avisar cuando tu operador la cambie.
 *
 * Ojo: DuckDNS NO oculta la IP, solo le pone nombre (quien resuelva el dominio
 * la ve). Para ocultarla de verdad hace falta un túnel (p. ej. playit.gg).
 *
 * La configuración se guarda en settings.json (clave "duckdns"). El token es
 * secreto: nunca se devuelve a la interfaz, solo si está puesto o no.
 */
const settings = require('./settings');

const UPDATE_EVERY_MS = 5 * 60 * 1000; // lo que recomienda DuckDNS
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Acepta "miserver", "miserver.duckdns.org" o "https://miserver.duckdns.org/". */
function normalizeSubdomain(value) {
  let clean = String(value || '').trim().toLowerCase();
  clean = clean.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/\.duckdns\.org$/, '');
  if (!SUBDOMAIN_PATTERN.test(clean)) {
    throw new Error('El subdominio solo puede tener letras, números y guiones (por ejemplo: miserver).');
  }
  return clean;
}

function normalizeToken(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!TOKEN_PATTERN.test(clean)) {
    throw new Error('El token no tiene el formato de DuckDNS (algo como a1b2c3d4-e5f6-7890-abcd-ef1234567890). Cópialo de la parte de arriba de duckdns.org.');
  }
  return clean;
}

/**
 * Pide a DuckDNS que actualice la IP. Con "ip" vacío, DuckDNS usa la IP desde
 * la que llega la petición, que es la pública de tu conexión.
 * Devuelve { ok, ip, changed, at } o lanza un error con un mensaje claro.
 */
async function callDuckDns(subdomain, token, fetchImpl = fetch) {
  // MSM_DUCKDNS_URL solo sirve para pruebas (apuntar a un DuckDNS simulado).
  const base = process.env.MSM_DUCKDNS_URL || 'https://www.duckdns.org/update';
  const url = `${base}?domains=${encodeURIComponent(subdomain)}&token=${encodeURIComponent(token)}&ip=&verbose=true`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new Error('No se ha podido contactar con DuckDNS. Comprueba la conexión a internet.');
  }
  const text = (await response.text()).trim();
  const lines = text.split(/\r?\n/);
  if (lines[0] !== 'OK') {
    throw new Error('DuckDNS ha rechazado la actualización: revisa que el subdominio sea tuyo y que el token sea correcto.');
  }
  return { ok: true, ip: lines[1] || null, changed: lines[3] === 'UPDATED', at: Date.now() };
}

function readConfig() {
  return settings.readSettings().duckdns || null;
}

function writeConfig(config) {
  const all = settings.readSettings();
  if (config) all.duckdns = config;
  else delete all.duckdns;
  settings.writeSettings(all);
}

/** Lo que puede ver la interfaz: nunca el token. */
function publicInfo() {
  const config = readConfig();
  if (!config) return { configured: false };
  return {
    configured: true,
    subdomain: config.subdomain,
    domain: `${config.subdomain}.duckdns.org`,
    tokenHint: `…${config.token.slice(-4)}`,
    lastUpdate: config.lastUpdate || null,
    lastIp: config.lastIp || null,
    lastError: config.lastError || null,
  };
}

/**
 * Comprueba los datos haciendo una actualización real y, solo si DuckDNS la
 * acepta, los guarda y pone ese dominio como dirección pública de la app.
 * Si ya había token guardado y no se escribe uno nuevo, se reutiliza.
 */
async function configure({ subdomain, token }, fetchImpl = fetch) {
  const cleanSubdomain = normalizeSubdomain(subdomain);
  const previous = readConfig();
  const cleanToken = token ? normalizeToken(token) : previous && previous.token;
  if (!cleanToken) throw new Error('Falta el token de DuckDNS.');

  const result = await callDuckDns(cleanSubdomain, cleanToken, fetchImpl);
  writeConfig({ subdomain: cleanSubdomain, token: cleanToken, lastUpdate: result.at, lastIp: result.ip, lastError: null });
  settings.setPublicAddress(`${cleanSubdomain}.duckdns.org`);
  return publicInfo();
}

/** Actualización periódica (o manual). No lanza: guarda el error para mostrarlo. */
async function updateNow(fetchImpl = fetch) {
  const config = readConfig();
  if (!config) return publicInfo();
  try {
    const result = await callDuckDns(config.subdomain, config.token, fetchImpl);
    writeConfig({ ...config, lastUpdate: result.at, lastIp: result.ip, lastError: null });
  } catch (err) {
    writeConfig({ ...config, lastError: err.message, lastErrorAt: Date.now() });
  }
  return publicInfo();
}

/** Quita DuckDNS. Si la dirección pública era ese dominio, también se quita. */
function remove() {
  const config = readConfig();
  writeConfig(null);
  if (config && settings.getPublicAddress() === `${config.subdomain}.duckdns.org`) {
    settings.setPublicAddress('');
  }
  return publicInfo();
}

let timer = null;

/** Empieza a actualizar cada 5 minutos (y una vez nada más empezar). */
function startUpdater(fetchImpl = fetch) {
  if (timer) return;
  const tick = () => {
    if (readConfig()) updateNow(fetchImpl);
  };
  tick();
  timer = setInterval(tick, UPDATE_EVERY_MS);
  timer.unref();
}

function stopUpdater() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  normalizeSubdomain,
  normalizeToken,
  callDuckDns,
  configure,
  updateNow,
  remove,
  publicInfo,
  startUpdater,
  stopUpdater,
};
