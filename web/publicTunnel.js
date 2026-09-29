/**
 * Enlace público de la web con un "quick tunnel" de Cloudflare.
 *
 * Se ejecuta el programa oficial `cloudflared` así:
 *   cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<puerto>
 * y Cloudflare asigna una dirección https://<palabras>.trycloudflare.com que
 * lleva a esta web. Tus amigos entran por ahí, con HTTPS, y no ven tu IP.
 *
 * Limitaciones (documentadas por Cloudflare): la dirección es aleatoria y
 * cambia cada vez que se reinicia el túnel, no es un servicio "de producción" y
 * admite como mucho 200 peticiones a la vez (de sobra para un grupo de amigos).
 *
 * No se descarga nada: hay que instalar cloudflared (ver README). Se busca en
 * MSM_CLOUDFLARED, en las rutas de instalación habituales de Windows y en el PATH.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const settings = require('../src/settings');

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 30000;

let child = null;
let localPort = 3000;
let state = { phase: 'stopped', url: null, error: null, startedAt: null };
let onUrlChange = () => {};

function setLocalPort(port) {
  localPort = port;
}

/** Se llama cuando cambia el enlace (para avisar al administrador). */
function setUrlListener(listener) {
  onUrlChange = listener || (() => {});
}

function candidates() {
  const list = [];
  if (process.env.MSM_CLOUDFLARED) list.push(process.env.MSM_CLOUDFLARED);
  if (process.platform === 'win32') {
    list.push('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
    list.push('C:\\Program Files\\cloudflared\\cloudflared.exe');
  }
  list.push('cloudflared');
  return list;
}

/** Ruta de cloudflared si está instalado, o null. */
function findCloudflared() {
  for (const candidate of candidates()) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ['--version'], { windowsHide: true, timeout: 8000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function status() {
  return { ...state, autoStart: Boolean((settings.readSettings().webTunnel || {}).autoStart) };
}

function setAutoStart(enabled) {
  const all = settings.readSettings();
  all.webTunnel = { ...(all.webTunnel || {}), autoStart: Boolean(enabled) };
  settings.writeSettings(all);
  return status();
}

/** Host del enlace activo (p. ej. "algo.trycloudflare.com"), o null. */
function activeHost() {
  if (state.phase !== 'running' || !state.url) return null;
  return new URL(state.url).host;
}

/**
 * Arranca el túnel y espera a que Cloudflare asigne el enlace.
 * launcher y timeoutMs son solo para tests (un cloudflared simulado).
 */
function start({ launcher, timeoutMs = START_TIMEOUT_MS } = {}) {
  if (child) return Promise.resolve(status());

  let command;
  let prefixArgs = [];
  if (launcher) {
    ({ command, prefixArgs = [] } = launcher);
  } else {
    command = findCloudflared();
    if (!command) {
      state = {
        phase: 'error',
        url: null,
        error: 'No se encuentra cloudflared en este PC. Instálalo (en Windows: winget install --id Cloudflare.cloudflared) y vuelve a intentarlo.',
        startedAt: null,
      };
      return Promise.resolve(status());
    }
  }

  state = { phase: 'starting', url: null, error: null, startedAt: Date.now() };
  const args = [...prefixArgs, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
  const proc = spawn(command, args, { windowsHide: true });
  child = proc;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(status());
      }
    };

    const timer = setTimeout(() => {
      if (state.phase === 'starting') {
        state = { phase: 'error', url: null, error: 'Cloudflare no ha dado un enlace a tiempo. Comprueba la conexión a internet y vuelve a intentarlo.', startedAt: null };
        proc.kill();
      }
      finish();
    }, timeoutMs);

    // cloudflared escribe su registro (y el enlace) por stderr.
    const scan = (data) => {
      const match = String(data).match(URL_PATTERN);
      if (match && state.url !== match[0]) {
        state = { phase: 'running', url: match[0], error: null, startedAt: state.startedAt || Date.now() };
        clearTimeout(timer);
        onUrlChange(state.url);
        finish();
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);

    proc.on('error', (err) => {
      clearTimeout(timer);
      child = null;
      state = { phase: 'error', url: null, error: `No se pudo ejecutar cloudflared: ${err.message}`, startedAt: null };
      finish();
    });

    proc.on('exit', () => {
      clearTimeout(timer);
      if (child === proc) child = null;
      if (!proc.stoppedOnPurpose && state.phase === 'starting') {
        state = { phase: 'error', url: null, error: 'cloudflared se ha cerrado sin dar un enlace. Comprueba la conexión a internet y vuelve a intentarlo.', startedAt: null };
      } else if (!proc.stoppedOnPurpose && state.phase === 'running') {
        state = { phase: 'error', url: null, error: 'El túnel de Cloudflare se ha cerrado. Vuelve a activarlo (el enlace será otro).', startedAt: null };
        onUrlChange(null);
      }
      finish();
    });
  });
}

function stop() {
  if (child) {
    child.stoppedOnPurpose = true;
    child.kill();
    child = null;
  }
  state = { phase: 'stopped', url: null, error: null, startedAt: null };
  return status();
}

module.exports = { start, stop, status, setAutoStart, setLocalPort, setUrlListener, activeHost, findCloudflared };
