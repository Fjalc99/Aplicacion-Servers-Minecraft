const { execFile } = require('child_process');
const os = require('os');

// Cuando un servidor Forge/NeoForge se lanza vía run.bat/run.sh, el PID que
// devuelve spawn() es el del intérprete (cmd.exe / bash), no el de Java. Para
// medir CPU/RAM de verdad hay que bajar por el árbol de procesos hasta el java.

/**
 * Parsea la salida de `ps -A -o pid=,ppid=,comm=` (Linux/macOS).
 * Devuelve [{ pid, ppid, name }].
 */
function parsePsOutput(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim() });
  }
  return out;
}

/**
 * Parsea la salida CSV de PowerShell (ConvertTo-Csv) con columnas
 * ProcessId, ParentProcessId, Name. Devuelve [{ pid, ppid, name }].
 */
function parseWindowsCsv(text) {
  const out = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue; // cabecera
    out.push({ pid, ppid, name: cols.slice(2).join(',') });
  }
  return out;
}

/**
 * Busca, entre los descendientes de rootPid, el primer proceso cuyo nombre sea
 * java / java.exe / javaw.exe. Si el propio rootPid ya es java, lo devuelve.
 * Recorrido en anchura para quedarse con el java más cercano a la raíz.
 */
function findJavaDescendant(processes, rootPid) {
  const isJava = (name) => /^javaw?(\.exe)?$/i.test(String(name).split(/[\\/]/).pop());
  const root = processes.find((p) => p.pid === rootPid);
  if (root && isJava(root.name)) return rootPid;

  const childrenOf = new Map();
  for (const p of processes) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p);
  }

  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    for (const child of childrenOf.get(current) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (isJava(child.name)) return child.pid;
      queue.push(child.pid);
    }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

async function listProcesses() {
  if (os.platform() === 'win32') {
    // wmic ya no viene en Windows 11 recientes; CIM vía PowerShell sí.
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation';
    const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return parseWindowsCsv(text);
  }
  const text = await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  return parsePsOutput(text);
}

async function findJavaPid(rootPid) {
  const processes = await listProcesses();
  return findJavaDescendant(processes, rootPid);
}

module.exports = { parsePsOutput, parseWindowsCsv, findJavaDescendant, listProcesses, findJavaPid };
