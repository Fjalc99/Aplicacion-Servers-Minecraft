// Patrones habituales en el log de un servidor de Minecraft cuando se cae o no
// arranca, traducidos a un mensaje corto y accionable. Se comprueban en orden;
// gana el primero que coincida.
const PATTERNS = [
  {
    test: /OutOfMemoryError/i,
    message: 'Se quedó sin memoria (OutOfMemoryError). Prueba a subir la RAM asignada en la pestaña Configuración.',
  },
  {
    test: /Address already in use|BindException/i,
    message: 'El puerto ya está en uso por otro programa (o por otra copia de este mismo servidor). Cambia el puerto en Configuración o cierra lo que lo esté usando.',
  },
  {
    test: /Mixin apply failed|Incompatible mod( set)?|duplicate mod|mod .*(is incompatible|conflicts with)/i,
    message: 'Parece un conflicto entre mods (fallo al aplicar un Mixin, o mods incompatibles entre sí). Revisa el log completo en la Consola para ver qué mod lo causó; suele aparecer su nombre justo antes del error.',
  },
  {
    test: /You need to agree to the EULA/i,
    message: 'El servidor no arranca porque el EULA no está aceptado. Revisa el fichero eula.txt en la carpeta del servidor.',
  },
  {
    test: /UnsupportedClassVersionError/i,
    message: 'La versión de Java instalada es demasiado antigua para este servidor. Instala una versión de Java más reciente.',
  },
  {
    test: /Exception in thread "main"/i,
    message: 'El servidor falló al arrancar (excepción en el hilo principal de Java). Revisa el log completo en la Consola para más detalle.',
  },
];

/**
 * Devuelve un mensaje corto en español a partir del log reciente del servidor,
 * o un mensaje genérico si no coincide ningún patrón conocido.
 */
function diagnose(logText) {
  for (const p of PATTERNS) {
    if (p.test.test(logText)) return p.message;
  }
  return 'No se ha podido identificar la causa automáticamente; revisa el log completo en la pestaña Consola.';
}

module.exports = { diagnose };
