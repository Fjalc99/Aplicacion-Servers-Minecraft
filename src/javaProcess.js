const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildJvmArgs } = require('./jvmFlags');

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
    const argsFile = path.join(dir, 'user_jvm_args.txt');
    if (fs.existsSync(argsFile)) {
      fs.writeFileSync(argsFile, buildJvmArgs(memory, optimize).join('\n') + '\n');
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
    args: [...buildJvmArgs(memory, optimize), '-jar', server.launch.value, 'nogui'],
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

  const entry = { proc, intentionalStop: false, recentLog: [], players: new Set(), ready: false };
  running.set(server.id, entry);

  const emit = (text) => {
    if (onLog) onLog(text);
    const { playersChanged, becameReady } = pushLogLines(entry, text);
    if (becameReady && onReady) onReady();
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

function stopServer(serverId, { force = false } = {}) {
  const entry = running.get(serverId);
  if (!entry) return;
  entry.intentionalStop = true;
  if (force) {
    entry.proc.kill('SIGKILL');
  } else {
    try {
      entry.proc.stdin.write('stop\n');
    } catch (e) {
      entry.proc.kill();
    }
  }
}

module.exports = { startServer, stopServer, sendCommand, isRunning, getPlayers };
