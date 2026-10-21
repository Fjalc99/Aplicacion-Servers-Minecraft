// "Aikar's flags": conjunto de parámetros de JVM ampliamente documentado y usado
// en la comunidad de Minecraft (Paper, Spigot, Forge, NeoForge...) para ajustar el
// recolector de basura G1GC y reducir los tirones (lag spikes) causados por pausas
// largas de GC. Referencia pública: https://docs.papermc.io/paper/aikars-flags
const AIKAR_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
];

/**
 * Construye la lista de argumentos de memoria (+ flags de optimización si se piden)
 * para lanzar el proceso Java. No incluye -jar ni el nombre del jar.
 * minMb: memoria mínima (-Xms). Si no se indica, 1 GB (o la máxima si es menor).
 */
function buildJvmArgs(memoryMb, optimize, minMb) {
  const min = Number.isInteger(Number(minMb)) && Number(minMb) > 0 ? Math.min(Number(minMb), memoryMb) : Math.min(memoryMb, 1024);
  const args = [`-Xmx${memoryMb}M`, `-Xms${min}M`];
  if (optimize) args.push(...AIKAR_FLAGS);
  return args;
}

/** "4G" -> 4096, "4096m" -> 4096, "1048576k" -> 1024 (en MB). null si no se entiende. */
function toMb(value) {
  const m = String(value).trim().match(/^(\d+)([kKmMgGtT]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'g') return n * 1024;
  if (unit === 't') return n * 1024 * 1024;
  if (unit === 'k') return Math.round(n / 1024);
  if (unit === 'm') return n;
  return Math.round(n / 1024 / 1024); // bytes
}

/** Lee -Xmx y -Xms de un texto (p. ej. user_jvm_args.txt). Devuelve { maxMb, minMb } (null si no están). */
function parseMemoryArgs(text) {
  const tokens = String(text || '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join(' ')
    .split(/\s+/);
  let maxMb = null;
  let minMb = null;
  for (const t of tokens) {
    if (/^-Xmx/i.test(t)) maxMb = toMb(t.slice(4));
    else if (/^-Xms/i.test(t)) minMb = toMb(t.slice(4));
  }
  return { maxMb, minMb };
}

/**
 * Nuevo contenido de user_jvm_args.txt: memoria (+ flags de optimización) de la
 * app, conservando las líneas de comentario y cualquier otra opción que haya
 * puesto el usuario a mano.
 */
function mergeUserJvmArgs(existingText, memoryMb, optimize, minMb) {
  const managed = new Set(AIKAR_FLAGS);
  const comments = [];
  const extras = [];
  for (const line of String(existingText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      comments.push(line);
      continue;
    }
    for (const token of trimmed.split(/\s+/)) {
      if (/^-Xm[xs]/i.test(token) || managed.has(token)) continue;
      if (!extras.includes(token)) extras.push(token);
    }
  }
  return [...comments, ...buildJvmArgs(memoryMb, optimize, minMb), ...extras].join('\n') + '\n';
}

module.exports = { AIKAR_FLAGS, buildJvmArgs, parseMemoryArgs, mergeUserJvmArgs, toMb };
