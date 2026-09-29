const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');

process.env.DATA_DIR = tmpDir('msm-auth-');
const auth = require('../web/auth');

test('las contraseñas se guardan cifradas, nunca en claro', () => {
  auth.addUser({ username: 'jefe', password: 'contraseña-segura', role: 'admin' });
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'web-users.json'), 'utf-8');
  assert.ok(!raw.includes('contraseña-segura'));
  assert.match(raw, /"hash"/);
});

test('valida usuario y contraseña al crear', () => {
  assert.throws(() => auth.addUser({ username: 'ab', password: '12345678' }), /entre 3 y 32/);
  assert.throws(() => auth.addUser({ username: 'pepe', password: 'corta' }), /al menos 8/);
  assert.throws(() => auth.addUser({ username: 'JEFE', password: '12345678' }), /Ya existe/);
});

test('login correcto e incorrecto', () => {
  const bad = auth.login('jefe', 'mala', 'ip-a');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);

  const good = auth.login('jefe', 'contraseña-segura', 'ip-a');
  assert.equal(good.ok, true);
  assert.equal(auth.userForSession(good.token).role, 'admin');

  assert.equal(auth.login('nadie', 'loquesea', 'ip-a').ok, false);
});

test('bloquea una IP tras 5 intentos fallidos, sin afectar a otras', () => {
  for (let i = 0; i < 5; i++) auth.login('jefe', 'mala', 'ip-atacante');
  const blocked = auth.login('jefe', 'contraseña-segura', 'ip-atacante');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);

  assert.equal(auth.login('jefe', 'contraseña-segura', 'ip-otra').ok, true);
});

test('cambiar la contraseña invalida las sesiones anteriores', async () => {
  auth.addUser({ username: 'amigo1', password: 'primera-clave' });
  const { token } = auth.login('amigo1', 'primera-clave', 'ip-b');
  assert.ok(auth.userForSession(token));

  await new Promise((r) => setTimeout(r, 5)); // que el cambio sea posterior a la sesión
  auth.setPassword('amigo1', 'segunda-clave');
  assert.equal(auth.userForSession(token), null);
  assert.equal(auth.login('amigo1', 'segunda-clave', 'ip-b').ok, true);
});

test('borrar un usuario cierra sus sesiones; no se puede borrar el último admin', () => {
  auth.addUser({ username: 'temporal', password: 'clave-temporal' });
  const { token } = auth.login('temporal', 'clave-temporal', 'ip-c');
  auth.removeUser('temporal');
  assert.equal(auth.userForSession(token), null);

  assert.throws(() => auth.removeUser('jefe'), /último administrador/);
});

test('permisos: admin todo, amigo solo lo básico', () => {
  const admin = { role: 'admin' };
  const amigo = { role: 'amigo', canSendCommands: false };
  const amigoConComandos = { role: 'amigo', canSendCommands: true };

  assert.equal(auth.checkPermission(null, 'servers:list'), 'Tienes que iniciar sesión.');
  assert.equal(auth.checkPermission(admin, 'servers:delete', {}), null);

  for (const allowed of ['servers:list', 'servers:start', 'servers:createBackup', 'servers:resourceUsage']) {
    assert.equal(auth.checkPermission(amigo, allowed, 'id'), null, allowed);
  }
  assert.equal(auth.checkPermission(amigo, 'servers:stop', { id: 'x', force: false }), null);

  for (const forbidden of ['servers:delete', 'servers:restoreBackup', 'servers:deleteBackup', 'servers:create', 'mods:apply', 'servers:updateProperties', 'servers:import']) {
    assert.ok(auth.checkPermission(amigo, forbidden, {}), forbidden);
  }
  assert.match(auth.checkPermission(amigo, 'servers:stop', { id: 'x', force: true }), /forzar/);
  assert.match(auth.checkPermission(amigo, 'servers:sendCommand', {}), /comandos/);
  assert.equal(auth.checkPermission(amigoConComandos, 'servers:sendCommand', {}), null);
});

test('registro: la cuenta queda pendiente y no puede entrar hasta aprobarla', () => {
  auth.register({ username: 'nuevo', password: 'clave-nuevo-1' }, 'ip-reg-1');
  assert.equal(auth.listUsers().find((u) => u.username === 'nuevo').status, 'pendiente');

  const blocked = auth.login('nuevo', 'clave-nuevo-1', 'ip-reg-1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);
  assert.match(blocked.error, /aprobada/);

  auth.approveUser('nuevo');
  assert.equal(auth.login('nuevo', 'clave-nuevo-1', 'ip-reg-1').ok, true);
  assert.throws(() => auth.rejectUser('nuevo'), /pendientes/);
});

test('registro: límite por conexión y cuentas rechazadas', () => {
  for (let i = 0; i < 3; i++) auth.register({ username: `spam${i}`, password: 'clave-spam-1' }, 'ip-spam');
  assert.throws(() => auth.register({ username: 'spam9', password: 'clave-spam-1' }, 'ip-spam'), /Demasiados registros/);
  auth.rejectUser('spam0');
  assert.equal(auth.listUsers().some((u) => u.username === 'spam0'), false);
});

test('roles, contraseña temporal y cambio de contraseña propia', () => {
  auth.addUser({ username: 'rolero', password: 'clave-rolero' });
  auth.setRole('rolero', 'admin');
  auth.setRole('rolero', 'amigo');
  assert.throws(() => auth.setRole('jefe', 'amigo'), /último administrador/);

  const temporary = auth.resetPassword('rolero');
  assert.equal(temporary.length, 12);
  assert.equal(auth.login('rolero', temporary, 'ip-r').ok, true);

  assert.throws(() => auth.changeOwnPassword('rolero', 'no-es-esta', 'otra-clave-1'), /actual no es correcta/);
  auth.changeOwnPassword('rolero', temporary, 'otra-clave-1');
  assert.equal(auth.login('rolero', 'otra-clave-1', 'ip-r').ok, true);
});
