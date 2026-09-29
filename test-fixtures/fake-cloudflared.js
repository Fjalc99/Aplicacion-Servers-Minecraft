// cloudflared simulado para los tests: imprime por stderr el enlace como el real.
// Modos (variable FAKE_CF_MODE): "ok" (por defecto), "crash" (se cierra al rato),
// "silent" (nunca da enlace).
const args = process.argv.slice(2);
const mode = process.env.FAKE_CF_MODE || 'ok';
const urlArg = args[args.indexOf('--url') + 1];
if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    process.stderr.write(`INF Requesting new quick Tunnel on trycloudflare.com...\n`);
    process.stderr.write(`INF |  https://prueba-feliz-${process.pid}.trycloudflare.com  |\n`);
    process.stderr.write(`INF origin ${urlArg}\n`);
    if (mode === 'crash') setTimeout(() => process.exit(1), 300);
  }, 150);
  setInterval(() => {}, 1000);
}
