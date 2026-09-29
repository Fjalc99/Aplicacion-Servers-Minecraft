/**
 * Quién ve cada servidor y qué puede hacer con él en la versión web.
 *
 * Tipos de acceso de un usuario a un servidor:
 *   'admin'  -> el usuario es administrador: todo.
 *   'owner'  -> servidor creado por ese amigo: casi todo (ver OWNER_CHANNELS).
 *   'shared' -> servidor sin dueño (creado por un admin, o desde la app de
 *               escritorio): todos los amigos lo ven y pueden encenderlo,
 *               apagarlo y hacer backups (reglas de auth.checkPermission).
 *   null     -> servidor de otro amigo: ni lo ve.
 *
 * Todo lo que lee rutas del disco del equipo (importar servidores o mundos,
 * analizar/copiar mods de una carpeta, abrir carpetas) es solo para admin: si
 * no, un amigo podría leer archivos del PC o meter código (mods) que se ejecuta
 * en él.
 */
const os = require('os');
const auth = require('./auth');

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Límites para los amigos (configurables con variables de entorno, ver README).
function limits() {
  return {
    maxServers: envInt('MSM_AMIGO_MAX_SERVIDORES', 2),
    maxRunning: envInt('MSM_AMIGO_MAX_ENCENDIDOS', 1),
    maxMemoryMb: envInt('MSM_AMIGO_MAX_RAM_MB', 4096),
    portMin: envInt('MSM_AMIGO_PUERTO_MIN', 25566),
    portMax: envInt('MSM_AMIGO_PUERTO_MAX', 25599),
    // Parte de la RAM total del PC que pueden sumar todos los servidores encendidos.
    ramShareOfTotal: 0.85,
  };
}

// Canales que no dependen de un servidor concreto y puede usar un amigo.
const FRIEND_GLOBAL_CHANNELS = new Set([
  'servers:list',
  'servers:checkJava',
  'servers:systemMemory',
  'app:connectionInfo',
  'account:changePassword',
  'catalog:vanillaVersions',
  'catalog:forgeVersions',
  'catalog:forgeRecommended',
  'catalog:neoforgeVersions',
  'servers:create',
]);

// Lo que un amigo puede hacer con SUS servidores.
const OWNER_CHANNELS = new Set([
  'servers:get',
  'servers:isRunning',
  'servers:status',
  'servers:getPlayers',
  'servers:resourceUsage',
  'servers:listBackups',
  'servers:readPlayerList',
  'servers:removeFromPlayerList',
  'servers:start',
  'servers:stop',
  'servers:sendCommand',
  'servers:createBackup',
  'servers:restoreBackup',
  'servers:deleteBackup',
  'servers:delete',
  'servers:updateProperties',
  'servers:updateMemory',
  'servers:updateOptimizeJvm',
  'servers:updateAutoRestart',
  'servers:updateAutoBackup',
  'servers:updateAutoStop',
  'servers:leaveQueue',
  'servers:applyPerformancePreset',
]);

const LEVEL_NAME_PATTERN = /^[a-zA-Z0-9_\- ]{1,48}$/;

function sameUser(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function accessTo(user, server) {
  if (!user || !server) return null;
  if (user.role === 'admin') return 'admin';
  if (!server.owner) return 'shared';
  return sameUser(server.owner, user.username) ? 'owner' : null;
}

/** De qué servidor habla una llamada (el argumento es el id, o un objeto con id/serverId). */
function serverIdFromArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object') return arg.id || arg.serverId || null;
  return null;
}

/** Servidor visto por un usuario: se le añade "access" para que la interfaz sepa qué mostrar. */
function withAccess(user, server) {
  const access = accessTo(user, server);
  return access ? { ...server, access } : null;
}

function portOf(server) {
  return Number((server.properties && server.properties['server-port']) || 25565);
}

function findFreePort(allServers, { portMin, portMax }, exceptId = null) {
  const used = new Set(allServers.filter((s) => s.id !== exceptId).map(portOf));
  for (let port = portMin; port <= portMax; port++) {
    if (!used.has(port)) return port;
  }
  return null;
}

/**
 * Limpia las propiedades que manda un amigo: el nombre del mundo no puede
 * contener rutas (evita "../../" fuera de la carpeta del servidor) y el puerto
 * tiene que estar en su rango y libre.
 */
function sanitizeFriendProperties(properties, { allServers, serverId, currentPort }) {
  const lim = limits();
  const clean = { ...(properties || {}) };

  if ('level-name' in clean && !LEVEL_NAME_PATTERN.test(String(clean['level-name']))) {
    return { error: 'El nombre del mundo solo puede tener letras, números, espacios, "_" y "-".' };
  }

  if ('server-port' in clean) {
    const port = Number(clean['server-port']);
    if (port !== currentPort) {
      const inRange = Number.isInteger(port) && port >= lim.portMin && port <= lim.portMax;
      const taken = allServers.some((s) => s.id !== serverId && portOf(s) === port);
      if (!inRange || taken) {
        return { error: `El puerto tiene que estar libre y entre ${lim.portMin} y ${lim.portMax}.` };
      }
    }
  }

  return { properties: clean };
}

/**
 * Evita que los amigos enciendan más servidores de los que caben en la RAM del
 * PC (sumando la memoria asignada a los que ya están encendidos).
 */
function checkRamBudget(server, ctx) {
  const lim = limits();
  const usedMb = ctx.allServers
    .filter((s) => s.id !== server.id && ctx.isRunning(s.id))
    .reduce((sum, s) => sum + (Number(s.memory) || 0), 0);
  const budgetMb = Math.floor((ctx.totalMemMb || os.totalmem() / 1024 / 1024) * lim.ramShareOfTotal);
  if (usedMb + (Number(server.memory) || 0) > budgetMb) {
    return 'El PC no tiene memoria libre suficiente para encender otro servidor ahora mismo. Prueba cuando se apague alguno.';
  }
  return null;
}

/**
 * Decide si "user" puede llamar a "channel" con "arg".
 *
 * ctx: { allServers: Server[], isRunning(id), totalMemMb? (para tests) }
 * Devuelve { ok: true, arg } (arg puede venir saneado) o { ok: false, status, error }.
 * Si el único problema es que no queda memoria libre, además code: 'ram' (la web
 * lo usa para poner el arranque en cola en vez de rechazarlo).
 */
function authorize(user, channel, arg, ctx) {
  const deny = (error, status = 403) => ({ ok: false, status, error });

  if (!user) return deny('Tienes que iniciar sesión.', 401);
  if (user.role === 'admin') return { ok: true, arg };

  const lim = limits();
  const mine = ctx.allServers.filter((s) => sameUser(s.owner, user.username));

  // ---------- Canales globales ----------
  if (FRIEND_GLOBAL_CHANNELS.has(channel)) {
    if (channel !== 'servers:create') return { ok: true, arg };

    if (mine.length >= lim.maxServers) {
      return deny(`Ya tienes ${mine.length} servidor(es), el máximo permitido. Borra alguno para crear otro.`);
    }
    const options = { ...(arg || {}) };
    const memory = Number(options.memory) || 2048;
    if (memory > lim.maxMemoryMb) {
      return deny(`Como mucho puedes asignar ${lim.maxMemoryMb} MB de RAM a un servidor.`);
    }
    const port = findFreePort(ctx.allServers, lim);
    if (!port) return deny('No quedan puertos libres para servidores nuevos. Avisa al administrador.');

    const properties = { ...(options.properties || {}) };
    if ('level-name' in properties && !LEVEL_NAME_PATTERN.test(String(properties['level-name']))) {
      return deny('El nombre del mundo solo puede tener letras, números, espacios, "_" y "-".');
    }
    properties['server-port'] = port; // se asigna siempre uno libre, ignorando el que se pidiera
    return { ok: true, arg: { ...options, memory, properties } };
  }

  // ---------- Canales de un servidor concreto ----------
  const serverId = serverIdFromArg(arg);
  const server = serverId ? ctx.allServers.find((s) => s.id === serverId) : null;
  const access = accessTo(user, server);

  if (!server || !access) {
    // Mismo mensaje exista o no, para no revelar los servidores de otros.
    if (OWNER_CHANNELS.has(channel) || auth.FRIEND_CHANNELS.has(channel)) {
      return deny('Servidor no encontrado.', 404);
    }
    return deny('Solo un administrador puede hacer esto.');
  }

  if (access === 'shared') {
    const reason = auth.checkPermission(user, channel, arg);
    if (reason) return deny(reason);
    if (channel === 'servers:start') {
      const ramError = checkRamBudget(server, ctx);
      if (ramError) return { ...deny(ramError), code: 'ram' };
    }
    return { ok: true, arg };
  }

  // access === 'owner'
  if (!OWNER_CHANNELS.has(channel)) return deny('Solo un administrador puede hacer esto.');

  if (channel === 'servers:updateMemory' && Number(arg.memory) > lim.maxMemoryMb) {
    return deny(`Como mucho puedes asignar ${lim.maxMemoryMb} MB de RAM a un servidor.`);
  }

  if (channel === 'servers:updateProperties') {
    const result = sanitizeFriendProperties(arg.properties, {
      allServers: ctx.allServers,
      serverId,
      currentPort: portOf(server),
    });
    if (result.error) return deny(result.error);
    return { ok: true, arg: { ...arg, properties: result.properties } };
  }

  if (channel === 'servers:start') {
    const running = ctx.allServers.filter((s) => ctx.isRunning(s.id));
    const myRunning = running.filter((s) => sameUser(s.owner, user.username) && s.id !== serverId);
    if (myRunning.length >= lim.maxRunning) {
      return deny(`Solo puedes tener ${lim.maxRunning} servidor(es) tuyo(s) encendido(s) a la vez. Apaga "${myRunning[0].name}" primero.`);
    }
    const ramError = checkRamBudget(server, ctx);
    if (ramError) return { ...deny(ramError), code: 'ram' };
  }

  return { ok: true, arg };
}

module.exports = {
  authorize,
  accessTo,
  withAccess,
  serverIdFromArg,
  findFreePort,
  limits,
  OWNER_CHANNELS,
};
