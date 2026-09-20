const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildJvmArgs } = require('./jvmFlags');

// serverId -> { proc, listeners: Set<fn> }
const running = new Map();

function isRunning(serverId) {
  return running.has(serverId);
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

function startServer(server, onLog, onExit) {
  if (running.has(server.id)) return;

  const { cmd, args, shell } = buildLaunchCommand(server);
  const proc = spawn(cmd, args, { cwd: server.dir, shell });

  const emit = (line) => {
    if (onLog) onLog(line);
  };

  proc.stdout.on('data', (data) => emit(data.toString()));
  proc.stderr.on('data', (data) => emit(data.toString()));
  proc.on('exit', (code) => {
    running.delete(server.id);
    if (onExit) onExit(code);
  });
  proc.on('error', (err) => {
    running.delete(server.id);
    emit(`\n[ERROR] No se pudo iniciar el proceso: ${err.message}\n`);
    if (onExit) onExit(null);
  });

  running.set(server.id, proc);
}

function sendCommand(serverId, command) {
  const proc = running.get(serverId);
  if (!proc) throw new Error('El servidor no está en ejecución');
  proc.stdin.write(command.trim() + '\n');
}

function stopServer(serverId, { force = false } = {}) {
  const proc = running.get(serverId);
  if (!proc) return;
  if (force) {
    proc.kill('SIGKILL');
  } else {
    try {
      proc.stdin.write('stop\n');
    } catch (e) {
      proc.kill();
    }
  }
}

module.exports = { startServer, stopServer, sendCommand, isRunning };
