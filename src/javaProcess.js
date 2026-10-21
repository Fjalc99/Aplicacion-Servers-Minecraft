const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildJvmArgs, mergeUserJvmArgs } = require('./jvmFlags');
const processTree = require('./processTree');

// serverId -> { proc, intentionalStop, recentLog: string[], players: Set<string> }
const running = new Map();

const MAX_LOG_LINES = 400;
const READY_PATTERN = /\]: Done \(/;
const JOIN_PATTERN = /(?:\[[^\]]*\]:?\s*)?(\w+) joined the game/;
const LEAVE_PATTERN = /(?:\[[^\]]*\]:?\s*)?(\w+) left the game/;

function isRunning(serverId) {
  return running.has(serverId);
}

function getPlayers(serverId) {
  const entry = running.get(serverId);
  return entry ? [...entry.players] : [];
}

function buildLaunchCommand(server) {
  const memory = server.memory || 2048; // MB
  const optimize = server.optimizeJvm !== false; // por defecto activado
  const dir = server.dir;

  if (server.launch.type === 'script') {
    const scriptName = server.launch.value || (os.platform() === 'win32' ? 'run.bat' : 'run.sh');
    const scriptPath = path.join(dir, scriptName);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`No se encuentra el script de arranque ${scriptName}. Revisa que la instalación terminó bien.`);
    }
    if (os.platform() !== 'win32') fs.chmodSync(scriptPath, 0o755);
    // Los scripts generados por Forge/NeoForge ya incluyen los argumentos de memoria
    // en user_jvm_args.txt; lo sobreescribimos para respetar lo elegido en la UI
    // (memoria + flags de optimización de GC si están activados).
    // Se conservan los comentarios y cualquier otra opción que hayas puesto a mano.
    const argsFile = path.join(dir, 'user_jvm_args.txt');
    if (fs.existsSync(argsFile)) {
      const before = fs.readFileSync(argsFile, 'utf-8');
      fs.writeFileSync(argsFile, mergeUserJvmArgs(before, memory, optimize, server.memoryMin));
    }
    if (os.platform() === 'win32' && !/\.bat$/i.test(scriptName)) {
      throw new Error('Este servidor solo tiene un script de Linux (run.sh). Ábrelo desde Linux o instala/genera run.bat.');
    }
    return os.platform() === 'win32'
      ? { cmd: `"${scriptPath}"`, args: [], shell: true }
      : { cmd: 'bash', args: [scriptPath], shell: false };
  }

  // Vanilla: jar directo
  return {
    cmd: 'java',
    args: [...buildJvmArgs(memory, optimize, server.memoryMin), '-jar', server.launch.value, 'nogui'],
    shell: false,
  };
}

function pushLogLines(entry, text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  let playersChanged = false;
  let becameReady = false;

  for (const line of lines) {
    entry.recentLog.push(line);
    if (entry.recentLog.length > MAX_LOG_LINES) entry.recentLog.shift();

    if (!entry.ready && READY_PATTERN.test(line)) {
      entry.ready = true;
      becameReady = true;
    }

    const joined = line.match(JOIN_PATTERN);
    if (joined) {
      entry.players.add(joined[1]);
      playersChanged = true;
    }
    const left = line.match(LEAVE_PATTERN);
    if (left) {
      entry.players.delete(left[1]);
      playersChanged = true;
    }
  }

  return { playersChanged, becameReady };
}

/**
 * callbacks: { onLog(line), onExit({ code, crashed, recentLogText }), onReady(), onPlayersChange(players) }
 */
function startServer(server, callbacks = {}) {
  const { onLog, onExit, onReady, onPlayersChange } = callbacks;
  if (running.has(server.id)) return;

  const { cmd, args, shell } = buildLaunchCommand(server);
  const proc = spawn(cmd, args, { cwd: server.dir, shell });

  const entry = {
    proc,
    intentionalStop: false,
    recentLog: [],
    players: new Set(),
    ready: false,
    startedAt: Date.now(),
    readyAt: null,
    // Con 'jar' el PID de spawn() ya es el de Java; con 'script' es el de
    // cmd.exe/bash y hay que buscar el java hijo (ver getResourceUsage).
    viaScript: server.launch.type === 'script',
    javaPid: server.launch.type === 'script' ? null : proc.pid,
    memoryLimitMb: server.memory || 2048,
  };
  running.set(server.id, entry);

  const emit = (text) => {
    if (onLog) onLog(text);
    const { playersChanged, becameReady } = pushLogLines(entry, text);
    if (becameReady) {
      entry.readyAt = Date.now();
      if (onReady) onReady();
    }
    if (playersChanged && onPlayersChange) onPlayersChange([...entry.players]);
  };

  proc.stdout.on('data', (data) => emit(data.toString()));
  proc.stderr.on('data', (data) => emit(data.toString()));
  proc.on('exit', (code) => {
    const wasIntentional = entry.intentionalStop;
    const recentLogText = entry.recentLog.join('\n');
    running.delete(server.id);
    if (onExit) onExit({ code, crashed: !wasIntentional, recentLogText });
  });
  proc.on('error', (err) => {
    const recentLogText = entry.recentLog.join('\n');
    running.delete(server.id);
    emit(`\n[ERROR] No se pudo iniciar el proceso: ${err.message}\n`);
    if (onExit) onExit({ code: null, crashed: true, recentLogText });
  });
}

function sendCommand(serverId, command) {
  const entry = running.get(serverId);
  if (!entry) throw new Error('El servidor no está en ejecución');
  entry.proc.stdin.write(command.trim() + '\n');
}

/**
 * Mata el servidor de verdad. Con run.bat/run.sh, matar solo el PID de spawn()
 * (cmd.exe / bash) dejaría el proceso java huérfano, con el puerto y el mundo
 * bloqueados; por eso se mata también el java hijo.
 */
function forceKill(entry) {
  const rootPid = entry.proc.pid;
  if (!rootPid) return;

  if (os.platform() === 'win32') {
    // /T mata todo el árbol (cmd.exe -> java.exe)
    execFile('taskkill', ['/pid', String(rootPid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) entry.proc.kill();
    });
    return;
  }

  const killJava = (pid) => {
    if (pid && pid !== rootPid) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ya no existe */ }
    }
  };
  if (!entry.viaScript) {
    entry.proc.kill('SIGKILL');
  } else if (entry.javaPid) {
    killJava(entry.javaPid);
    entry.proc.kill('SIGKILL');
  } else {
    processTree
      .findJavaPid(rootPid)
      .then(killJava)
      .catch(() => {})
      .finally(() => entry.proc.kill('SIGKILL'));
  }
}

function stopServer(serverId, { force = false } = {}) {
  const entry = running.get(serverId);
  if (!entry) return;
  entry.intentionalStop = true;
  if (force) {
    forceKill(entry);
  } else {
    try {
      entry.proc.stdin.write('stop\n');
    } catch (e) {
      entry.proc.kill();
    }
  }
}

/**
 * Uso de CPU y RAM del proceso Java real del servidor.
 * Devuelve null si el servidor no está en marcha o si aún no se ha podido
 * localizar el proceso java (p. ej. justo tras arrancar vía run.bat).
 *
 * cpuPercent está normalizado al total de la máquina (0-100), no a un núcleo.
 */
async function getResourceUsage(serverId) {
  const entry = running.get(serverId);
  if (!entry || !entry.proc.pid) return null;

  if (!entry.javaPid) {
    // Evita lanzar PowerShell/ps en cada sondeo si ya se está buscando
    if (entry.resolvingPid) return null;
    entry.resolvingPid = true;
    try {
      entry.javaPid = await processTree.findJavaPid(entry.proc.pid);
    } catch (e) {
      entry.javaPid = null;
    } finally {
      entry.resolvingPid = false;
    }
    if (!entry.javaPid || !running.has(serverId)) return null;
  }

  // Carga perezosa: así los tests y el resto de módulos no dependen de pidusage
  const pidusage = require('pidusage');
  let stats;
  try {
    stats = await pidusage(entry.javaPid);
  } catch (e) {
    // El java puede haber muerto/reiniciado (Forge relanza a veces): reintentar la búsqueda
    if (entry.viaScript) entry.javaPid = null;
    return null;
  }

  const cores = os.cpus().length || 1;
  return {
    pid: entry.javaPid,
    cpuPercent: Math.min(100, stats.cpu / cores),
    memoryMb: stats.memory / 1024 / 1024,
    memoryLimitMb: entry.memoryLimitMb,
    timestamp: Date.now(),
  };
}

/**
 * Estado del servidor tal y como lo verá un jugador:
 *   offline  -> apagado
 *   starting -> el proceso ya corre pero todavía no ha escrito "Done (...)"
 *   online   -> listo para entrar
 *   stopping -> se le ha pedido parar y está guardando el mundo
 */
function getStatus(serverId) {
  const entry = running.get(serverId);
  if (!entry) return { state: 'offline', players: [], startedAt: null, readyAt: null };
  let state = entry.ready ? 'online' : 'starting';
  if (entry.intentionalStop) state = 'stopping';
  return { state, players: [...entry.players], startedAt: entry.startedAt, readyAt: entry.readyAt };
}

module.exports = { startServer, stopServer, sendCommand, isRunning, getPlayers, getResourceUsage, getStatus };
