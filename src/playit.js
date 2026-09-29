/**
 * playit.gg: túnel que da a cada servidor una dirección pública (tipo
 * algo.joinmc.link) sin abrir puertos y sin que se vea la IP de tu casa.
 *
 * La app no descarga ni ejecuta el programa de playit por su cuenta: lo instalas
 * desde playit.gg y lo vinculas a tu cuenta. Aquí solo se comprueba si está en
 * marcha y se guarda la dirección que playit asigna a cada servidor.
 */
const { execFile } = require('child_process');

// "algo.joinmc.link", "algo.gl.joinmc.link:12345", "1.2.3.4:25565"...
const ADDRESS_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?(:\d{1,5})?$/;

function normalizeJoinAddress(value) {
  const clean = String(value || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!clean) return null;
  const port = clean.includes(':') ? Number(clean.split(':')[1]) : null;
  if (!ADDRESS_PATTERN.test(clean) || (port !== null && (port < 1 || port > 65535))) {
    throw new Error('Escribe la dirección tal cual te la da playit, por ejemplo: algo.joinmc.link o algo.joinmc.link:12345');
  }
  return clean;
}

/** ¿Está el programa de playit en marcha en este PC? */
function isAgentRunning() {
  return new Promise((resolve) => {
    const done = (err, stdout) => resolve(!err && /playit/i.test(String(stdout || '')));
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, done);
    } else {
      execFile('ps', ['-A', '-o', 'comm='], { timeout: 5000 }, done);
    }
  });
}

module.exports = { normalizeJoinAddress, isAgentRunning };
