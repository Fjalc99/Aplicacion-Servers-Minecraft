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
 */
function buildJvmArgs(memoryMb, optimize) {
  const minMemory = Math.min(memoryMb, 1024);
  const args = [`-Xmx${memoryMb}M`, `-Xms${minMemory}M`];
  if (optimize) args.push(...AIKAR_FLAGS);
  return args;
}

module.exports = { AIKAR_FLAGS, buildJvmArgs };
