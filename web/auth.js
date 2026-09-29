/**
 * Usuarios, sesiones y permisos de la versión web.
 *
 * - Los usuarios se guardan en <DATA_DIR>/web-users.json con la contraseña
 *   derivada con scrypt (nunca en claro).
 * - Las sesiones viven en memoria: al reiniciar el servidor web hay que volver
 *   a iniciar sesión.
 * - Las cuentas pueden estar "activa" o "pendiente": quien se registra desde la
 *   web queda pendiente hasta que un administrador la aprueba.
 * - Dos roles:
 *     admin  -> puede hacerlo todo (igual que la app de escritorio)
 *     amigo  -> encender/apagar, ver consola, jugadores y rendimiento, y hacer
 *               backups. Opcionalmente, escribir comandos (canSendCommands).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { userDataDir } = require('../src/paths');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_REGISTRATIONS_PER_IP_PER_HOUR = 3;
const MAX_PENDING_ACCOUNTS = 20;

// Canales que un amigo puede usar: solo lectura + encender/apagar + backups.
const FRIEND_CHANNELS = new Set([
  'servers:list',
  'servers:get',
  'servers:checkJava',
  'servers:isRunning',
  'servers:status',
  'servers:getPlayers',
  'servers:resourceUsage',
  'servers:systemMemory',
  'servers:listBackups',
  'servers:readPlayerList',
  'servers:start',
  'servers:stop',
  'servers:createBackup',
  'servers:leaveQueue',
]);

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

function usersFile() {
  return path.join(userDataDir(), 'web-users.json');
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(usersFile(), 'utf-8'));
  } catch (err) {
    return [];
  }
}

function saveUsers(users) {
  const file = usersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(users, null, 2), 'utf-8');
  fs.renameSync(temporary, file);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const candidate = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function validateNewCredentials(username, password) {
  if (!USERNAME_PATTERN.test(username || '')) {
    throw new Error('El usuario debe tener entre 3 y 32 caracteres: letras, números, "_", "-" o ".".');
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

function findUser(users, username) {
  return users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
}

function addUser({ username, password, role = 'amigo', canSendCommands = false, status = 'activa' }) {
  validateNewCredentials(username, password);
  if (role !== 'admin' && role !== 'amigo') throw new Error('Rol no válido (admin o amigo).');
  const users = loadUsers();
  if (findUser(users, username)) throw new Error(`Ya existe el usuario "${username}".`);
  const { salt, hash } = hashPassword(password);
  users.push({
    username, role, status, canSendCommands: Boolean(canSendCommands), salt, hash, createdAt: new Date().toISOString(),
  });
  saveUsers(users);
}

function isPending(user) {
  return user && user.status === 'pendiente';
}

function removeUser(username) {
  const users = loadUsers();
  const user = findUser(users, username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);
  const remaining = users.filter((u) => u !== user);
  if (user.role === 'admin' && !remaining.some((u) => u.role === 'admin')) {
    throw new Error('No se puede borrar el último administrador.');
  }
  saveUsers(remaining);
  revokeSessionsFor(user.username);
}

function setPassword(username, password) {
  validateNewCredentials(username, password);
  const users = loadUsers();
  const user = findUser(users, username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);
  Object.assign(user, hashPassword(password));
  // Las sesiones iniciadas antes de este momento dejan de valer, también en el
  // servidor web si está corriendo en otro proceso (lo comprueba userForSession).
  user.passwordChangedAt = Date.now();
  saveUsers(users);
  revokeSessionsFor(user.username);
}

function setCanSendCommands(username, enabled) {
  const users = loadUsers();
  const user = findUser(users, username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);
  user.canSendCommands = Boolean(enabled);
  saveUsers(users);
}

function listUsers() {
  return loadUsers().map(({ username, role, canSendCommands, createdAt, status }) => ({
    username, role, canSendCommands: Boolean(canSendCommands), createdAt, status: status || 'activa',
  }));
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> { username, expiresAt }

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

/** Devuelve el usuario (datos actuales, sin hash) de una sesión válida, o null. */
function userForSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = findUser(loadUsers(), session.username);
  // Usuario borrado, o contraseña cambiada después de iniciar esta sesión.
  if (!user || isPending(user) || (user.passwordChangedAt && user.passwordChangedAt > session.createdAt)) {
    sessions.delete(token);
    return null;
  }
  return { username: user.username, role: user.role, canSendCommands: Boolean(user.canSendCommands) };
}

function destroySession(token) {
  sessions.delete(token);
}

function revokeSessionsFor(username) {
  for (const [token, session] of sessions) {
    if (session.username.toLowerCase() === username.toLowerCase()) sessions.delete(token);
  }
}

// ---------------------------------------------------------------------------
// Login con límite de intentos
// ---------------------------------------------------------------------------

const failedLogins = new Map(); // ip -> { count, lockedUntil }

/** Devuelve { ok: true, token, user } o { ok: false, error, status }. */
function login(username, password, ip) {
  const record = failedLogins.get(ip);
  if (record && record.lockedUntil > Date.now()) {
    const minutes = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return { ok: false, status: 429, error: `Demasiados intentos fallidos. Prueba de nuevo en ${minutes} min.` };
  }

  const user = findUser(loadUsers(), username);
  // Se verifica igualmente contra una contraseña falsa si el usuario no existe,
  // para no revelar por el tiempo de respuesta qué usuarios existen.
  const valid = user ? verifyPassword(password || '', user) : (hashPassword(password || ''), false);

  if (!valid) {
    // Si había un bloqueo y ya caducó, se empieza a contar de cero.
    const lockExpired = record && record.lockedUntil && record.lockedUntil <= Date.now();
    const previous = record && !lockExpired ? record.count : 0;
    const count = previous + 1;
    failedLogins.set(ip, { count, lockedUntil: count >= MAX_FAILED_LOGINS ? Date.now() + LOCKOUT_MS : 0 });
    return { ok: false, status: 401, error: 'Usuario o contraseña incorrectos.' };
  }

  failedLogins.delete(ip);
  if (isPending(user)) {
    return { ok: false, status: 403, error: 'Tu cuenta todavía no está aprobada. Avisa al administrador para que la active.' };
  }
  const token = createSession(user.username);
  return { ok: true, token, user: userForSession(token) };
}

// ---------------------------------------------------------------------------
// Registro desde la web y gestión de cuentas (sin consola)
// ---------------------------------------------------------------------------

const registrationsByIp = new Map(); // ip -> [timestamps]

/**
 * Registro de una cuenta nueva desde la web. Queda pendiente hasta que un
 * administrador la apruebe, para que nadie que encuentre la página pueda
 * crear servidores en tu PC sin permiso.
 */
function register({ username, password }, ip) {
  const now = Date.now();
  const recent = (registrationsByIp.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= MAX_REGISTRATIONS_PER_IP_PER_HOUR) {
    throw Object.assign(new Error('Demasiados registros desde esta conexión. Prueba más tarde.'), { status: 429 });
  }
  const pending = loadUsers().filter(isPending).length;
  if (pending >= MAX_PENDING_ACCOUNTS) {
    throw Object.assign(new Error('Hay demasiadas cuentas esperando aprobación. Avisa al administrador.'), { status: 429 });
  }
  addUser({ username, password, role: 'amigo', status: 'pendiente' });
  recent.push(now);
  registrationsByIp.set(ip, recent);
}

function approveUser(username) {
  const users = loadUsers();
  const user = findUser(users, username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);
  user.status = 'activa';
  saveUsers(users);
}

/** Rechaza (borra) una cuenta pendiente. */
function rejectUser(username) {
  const users = loadUsers();
  const user = findUser(users, username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);
  if (!isPending(user)) throw new Error('Solo se pueden rechazar cuentas pendientes. Para una activa, bórrala.');
  saveUsers(users.filter((u) => u !== user));
}

function setRole(username, role) {
  if (role !== 'admin' && role !== 'amigo') throw new Error('Rol no válido (admin o amigo).');
  const users = loadUsers();
  const user = findUser(users, username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);
  const activeAdmins = users.filter((u) => u.role === 'admin' && !isPending(u));
  if (user.role === 'admin' && role !== 'admin' && activeAdmins.length <= 1) {
    throw new Error('No puedes quitar el último administrador.');
  }
  user.role = role;
  saveUsers(users);
}

/** Genera una contraseña temporal para quien la haya olvidado. Se muestra una sola vez. */
function resetPassword(username) {
  const temporary = crypto.randomBytes(9).toString('base64url'); // 12 caracteres
  setPassword(username, temporary);
  return temporary;
}

function changeOwnPassword(username, currentPassword, newPassword) {
  const user = findUser(loadUsers(), username);
  if (!user || !verifyPassword(currentPassword || '', user)) {
    throw new Error('La contraseña actual no es correcta.');
  }
  setPassword(username, newPassword);
}

// ---------------------------------------------------------------------------
// Primer administrador desde la web
// ---------------------------------------------------------------------------

function hasAdmin() {
  return loadUsers().some((u) => u.role === 'admin' && !isPending(u));
}

// Código de un solo uso que el servidor web imprime en su terminal cuando aún
// no hay administrador. Hace falta para crear el primero desde la web, así que
// solo puede hacerlo quien tiene acceso a este PC, aunque la página ya fuera
// accesible desde internet.
let setupCode = null;

function getSetupCode() {
  if (hasAdmin()) return null;
  if (!setupCode) setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  return setupCode;
}

function createFirstAdmin({ username, password, code }) {
  if (hasAdmin()) throw Object.assign(new Error('Ya existe un administrador.'), { status: 409 });
  const expected = getSetupCode();
  const given = String(code || '').trim().toUpperCase();
  if (!given || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw Object.assign(new Error('El código de configuración no es correcto. Lo tienes en la ventana donde ejecutaste "npm run web".'), { status: 403 });
  }
  addUser({ username, password, role: 'admin' });
  setupCode = null;
}

// ---------------------------------------------------------------------------
// Permisos
// ---------------------------------------------------------------------------

/** Devuelve null si está permitido, o un mensaje explicando por qué no. */
function checkPermission(user, channel, arg) {
  if (!user) return 'Tienes que iniciar sesión.';
  if (user.role === 'admin') return null;

  if (channel === 'servers:sendCommand') {
    return user.canSendCommands ? null : 'Tu usuario no tiene permiso para escribir comandos.';
  }

  if (!FRIEND_CHANNELS.has(channel)) return 'Solo un administrador puede hacer esto.';

  // Forzar la parada puede dejar el mundo a medio guardar: solo admin.
  if (channel === 'servers:stop' && arg && arg.force) return 'Solo un administrador puede forzar la parada.';

  return null;
}

module.exports = {
  register,
  approveUser,
  rejectUser,
  setRole,
  resetPassword,
  changeOwnPassword,
  hasAdmin,
  getSetupCode,
  createFirstAdmin,
  addUser,
  removeUser,
  setPassword,
  setCanSendCommands,
  listUsers,
  login,
  userForSession,
  destroySession,
  checkPermission,
  loadUsers,
  FRIEND_CHANNELS,
};
