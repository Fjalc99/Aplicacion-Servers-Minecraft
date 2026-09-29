#!/usr/bin/env node
/**
 * Gestión de usuarios de la versión web.
 *
 *   npm run usuarios -- crear <usuario> [--admin] [--comandos]
 *   npm run usuarios -- listar
 *   npm run usuarios -- borrar <usuario>
 *   npm run usuarios -- password <usuario>
 *   npm run usuarios -- comandos <usuario> si|no
 */
const readline = require('readline');
const auth = require('./auth');
const { userDataDir } = require('../src/paths');

// Una sola interfaz de lectura para todas las preguntas: si se crean varias,
// la primera se queda con todo lo que haya en la entrada (p. ej. al pegar las
// dos contraseñas de golpe) y la segunda espera para siempre.
let rl = null;
let muted = false;
const pendingLines = [];
const waiters = [];

function getReader() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl._writeToOutput = (text) => {
    if (!muted) rl.output.write(text);
  };
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  });
  rl.on('close', () => {
    while (waiters.length) waiters.shift()(null);
  });
  return rl;
}

function askHidden(question) {
  const reader = getReader();
  muted = false;
  reader.output.write(question);
  muted = true;
  return new Promise((resolve) => {
    const finish = (line) => {
      muted = false;
      reader.output.write('\n');
      resolve(line);
    };
    if (pendingLines.length) finish(pendingLines.shift());
    else waiters.push(finish);
  });
}

async function askNewPassword() {
  const first = await askHidden('Contraseña (mínimo 8 caracteres, no se verá al escribir): ');
  const second = await askHidden('Repite la contraseña: ');
  if (first === null || second === null) throw new Error('Entrada cancelada.');
  if (first !== second) throw new Error('Las contraseñas no coinciden.');
  return first;
}

function printUsage() {
  console.log(`Uso:
  npm run usuarios -- crear <usuario> [--admin] [--comandos]
  npm run usuarios -- listar
  npm run usuarios -- borrar <usuario>
  npm run usuarios -- password <usuario>
  npm run usuarios -- comandos <usuario> si|no

Roles:
  --admin     puede hacerlo todo
  (sin nada)  amigo: encender/apagar, ver consola y jugadores, hacer backups
  --comandos  además, un amigo puede escribir comandos en la consola`);
}

async function main() {
  const [command, username, ...rest] = process.argv.slice(2);
  const flags = new Set(rest);

  switch (command) {
    case 'crear': {
      if (!username) return printUsage();
      const role = flags.has('--admin') ? 'admin' : 'amigo';
      const password = await askNewPassword();
      auth.addUser({ username, password, role, canSendCommands: flags.has('--comandos') });
      console.log(`Usuario "${username}" creado como ${role}${flags.has('--comandos') && role === 'amigo' ? ' (con comandos)' : ''}.`);
      break;
    }
    case 'listar': {
      const users = auth.listUsers();
      if (users.length === 0) {
        console.log('No hay usuarios. Crea el primero con: npm run usuarios -- crear <usuario> --admin');
        break;
      }
      for (const u of users) {
        const extra = u.role === 'amigo' ? (u.canSendCommands ? ' · puede escribir comandos' : ' · sin comandos') : '';
        console.log(`  ${u.username}  (${u.role}${extra})`);
      }
      break;
    }
    case 'borrar':
      if (!username) return printUsage();
      auth.removeUser(username);
      console.log(`Usuario "${username}" borrado y sus sesiones cerradas.`);
      break;
    case 'password':
      if (!username) return printUsage();
      auth.setPassword(username, await askNewPassword());
      console.log(`Contraseña de "${username}" cambiada. Sus sesiones abiertas se han cerrado.`);
      break;
    case 'comandos': {
      const value = rest[0];
      if (!username || !['si', 'sí', 'no'].includes(value)) return printUsage();
      auth.setCanSendCommands(username, value !== 'no');
      console.log(`"${username}" ${value === 'no' ? 'ya no puede' : 'ahora puede'} escribir comandos.`);
      break;
    }
    default:
      printUsage();
  }
}

console.log(`(Datos en: ${userDataDir()})`);
main()
  .then(() => {
    if (rl) rl.close();
  })
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
