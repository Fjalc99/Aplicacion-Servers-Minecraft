# Minecraft Server Manager

App de escritorio (Electron) para crear y administrar servidores locales de Minecraft
**Vanilla**, **Forge** y **NeoForge** sin tocar la consola: acepta el EULA, genera
`server.properties` desde la interfaz, analiza tu carpeta de mods de cliente para
copiar al servidor solo los que hacen falta, y aplica ajustes de rendimiento con un
par de clics.

## Índice

- [Requisitos](#requisitos)
- [Instalación y arranque](#instalación-y-arranque)
- [Cómo funciona](#cómo-funciona)
  - [Crear un servidor](#crear-un-servidor)
  - [Importar un servidor ya existente](#importar-un-servidor-ya-existente)
  - [Analizar y copiar mods](#analizar-y-copiar-mods-forgeneoforge)
  - [Importar un mundo existente](#importar-un-mundo-existente)
  - [Consola](#consola)
  - [Rendimiento](#rendimiento)
- [Red y puertos: jugar con amigos](#red-y-puertos-jugar-con-amigos)
- [Bandeja del sistema](#bandeja-del-sistema)
- [Empaquetar como ejecutable](#empaquetar-como-ejecutable)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Fiabilidad: backups, reinicio automático y diagnóstico de caídas](#fiabilidad-backups-reinicio-automático-y-diagnóstico-de-caídas)
- [Clonar un servidor como plantilla](#clonar-un-servidor-como-plantilla)
- [Actualizaciones automáticas](#actualizaciones-automáticas)
- [Tests e integración continua](#tests-e-integración-continua)
- [playit.gg: jugar desde fuera sin abrir puertos](#playitgg-jugar-desde-fuera-sin-abrir-puertos-recomendado)
- [DuckDNS integrado (alternativa)](#duckdns-integrado-alternativa)
- [Página de inicio (estilo Aternos)](#página-de-inicio-estilo-aternos)
- [Apagado automático y cola de espera](#apagado-automático-y-cola-de-espera)
- [Versión web con acceso para amigos](#versión-web-con-acceso-para-amigos)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Subir el proyecto a GitHub](#subir-el-proyecto-a-github)
- [Pendiente](#pendiente)

## Requisitos

- **Node.js** 18 o superior (para ejecutar la app en desarrollo).
- **Java** instalado y accesible en el `PATH`:
  - Java 17+ recomendado para Minecraft 1.18+.
  - Java 8 si vas a montar servidores de versiones muy antiguas (no cubierto por esta guía).
- Conexión a internet: la app descarga los servidores/instaladores oficiales
  (Mojang, Forge, NeoForge) y consulta la API pública de Modrinth para el análisis de mods.

## Instalación y arranque

```bash
npm install
npm start
```

Esto abre la aplicación. Los servidores que crees se guardan en la carpeta de datos
de la app (por ejemplo, en Windows: `%APPDATA%\minecraft-server-manager\servers\<id>\`),
no dentro de este repositorio — salvo que **importes** un servidor que ya tengas en
otra carpeta, en cuyo caso se gestiona ahí mismo, sin moverlo.

## Cómo funciona

### Crear un servidor

El asistente ("Nuevo servidor" → "Crear servidor nuevo") te guía por: nombre → tipo
(Vanilla/Forge/NeoForge) → versión de Minecraft → versión del loader (si aplica) →
configuración (dificultad, modo de juego, jugadores máximos, PvP, whitelist, puerto,
MOTD, memoria, flags de JVM optimizados) → mundo existente opcional → revisión. Al
confirmar, la app:

1. Descarga el `server.jar` oficial (Vanilla) o el instalador (Forge/NeoForge).
2. Si es Forge/NeoForge, ejecuta `java -jar installer.jar --installServer` en la
   carpeta del servidor.
3. Escribe `eula.txt` con `eula=true` automáticamente.
4. Genera `server.properties` con los valores elegidos.

### Importar un servidor ya existente

"Nuevo servidor" → "Importar servidor existente" → eliges la carpeta donde ya tienes
el servidor instalado (a mano, con otro launcher, etc.). La app detecta
automáticamente:

- Forma de arranque: `run.sh`/`run.bat` (Forge/NeoForge modernos) o el `.jar` directo.
- Loader probable, mirando las librerías instaladas.
- Si el EULA ya está aceptado.
- El `server.properties` existente, si lo hay.

La **versión de Minecraft no siempre se puede detectar con seguridad** (no hay forma
fiable de leerla sin decompilar el jar), así que el asistente te la muestra como
sugerencia editable y te pide que la confirmes. El servidor importado queda en el
listado igual que uno creado desde la app.

### Analizar y copiar mods (Forge/NeoForge)

En la pestaña **Mods**, pulsa "Elegir carpeta de mods del cliente" y selecciona la
carpeta `mods` de tu instalación de cliente. La app:

1. Calcula el hash SHA-1 de cada `.jar`.
2. Consulta la API de Modrinth (`/v2/version_files`) para identificar cada mod por hash.
3. Comprueba el campo `server_side` del proyecto en Modrinth:
   - `required` u `optional` → se marca como **necesario en servidor** (se copia).
   - `unsupported` → se marca como **solo cliente** (no se copia).
   - Si el mod no está en Modrinth (por ejemplo, solo está en CurseForge) se marca
     como **no identificado**: decides tú manualmente si lo incluyes o no.
4. Puedes desmarcar/marcar cada mod antes de copiarlo.

Tienes dos formas de llevar los mods al servidor:

- **Copiar directamente** — el botón "Copiar seleccionados" los deja ya en la
  carpeta `mods/` del servidor. Te dice cuántos son nuevos y cuántos ya existían.
- **Generar un ZIP** — si Windows bloquea la escritura directa en esa carpeta
  (típico si está en Escritorio con "Acceso controlado a carpetas" activado, o con
  ciertos antivirus), usa "Generar ZIP con los seleccionados" (con barra de
  progreso y tiempo restante estimado, igual que los backups): eliges dónde
  guardarlo y luego lo descomprimes tú mismo dentro de `mods/`.

### Importar un mundo existente

Dos formas de meter un mundo que ya tengas:

- **Al crear un servidor nuevo**: en el paso de configuración hay un botón opcional
  "Elegir carpeta de mundo". Si lo usas, tras crear el servidor la app copia esa
  carpeta dentro de él con el nombre que tenga configurado en `level-name`.
- **En un servidor ya existente**: pestaña Resumen → tarjeta "Mundo" → "Importar
  mundo desde carpeta". Sustituye el mundo actual; pide confirmación y no se puede
  hacer con el servidor en marcha.

En ambos casos, la carpeta que elijas debe contener `level.dat` directamente.

### Consola

Pestaña **Consola**: inicia/detiene el proceso Java, ves el log en vivo (con un
tope de ~250 KB en pantalla para que sesiones muy largas no consuman memoria de
más) y puedes enviar comandos (`/op`, `/whitelist add`, etc.) al servidor mientras
está en marcha.

### Rendimiento

Pestaña **Configuración** → tarjeta "Rendimiento":

- **Flags de JVM optimizados ("Aikar's flags")** — activados por defecto en
  servidores nuevos. Es una configuración del recolector de basura de Java (G1GC)
  muy documentada en la comunidad de Minecraft (la recomienda, entre otros, el
  propio proyecto PaperMC) para reducir los tirones por pausas largas de GC. No
  cambia nada del gameplay. Se aplica la próxima vez que inicies el servidor.
- **Aplicar ajustes de rendimiento recomendados** — botón que ajusta de golpe
  `view-distance`, `simulation-distance`, `sync-chunk-writes`,
  `entity-broadcast-range-percentage` y `max-tick-time` a valores más ligeros,
  útil sobre todo en modpacks grandes. No toca dificultad ni modo de juego.
- **Aviso de RAM** — muestra la RAM total de tu PC y sugiere no pasarte de cierto
  límite si vas a jugar en la misma máquina que hostea el servidor.

Pestaña **Resumen** → tarjeta "Rendimiento en vivo": dos gráficas (CPU y RAM)
que se actualizan cada 2 segundos mientras el servidor está en marcha y muestran
los últimos 3 minutos.

- Mide el **proceso Java real**. En servidores Forge/NeoForge que arrancan con
  `run.bat`/`run.sh`, el proceso que lanza la app es el intérprete del script
  (`cmd.exe`/`bash`), así que la app baja por el árbol de procesos hasta encontrar
  el `java` hijo. Por eso, justo al iniciar, puede aparecer unos segundos
  "Localizando el proceso de Java…".
- La CPU se muestra como porcentaje **del total del equipo** (100 % = todos los
  núcleos al máximo).
- La línea discontinua de la gráfica de RAM es la memoria asignada (`-Xmx`). Es
  normal que el consumo real la supere un poco: la JVM usa memoria propia además
  del heap.

## Red y puertos: jugar con amigos

Esto es networking del propio Minecraft, no algo que la app resuelva por ti — pero
como es la parte que más dudas suele dar, aquí va explicado.

### Solo en tu red local (mismo WiFi/router)

No hace falta tocar nada de red. Tus amigos, conectados al mismo WiFi, se conectan
con `IP_LOCAL_DE_TU_PC:PUERTO` (por defecto el puerto es **25565**, configurable en
la pestaña Configuración). Para ver tu IP local en Windows: `ipconfig` en una
terminal, busca "Dirección IPv4".

La primera vez que arranques el servidor, **Windows Defender Firewall** te
preguntará si permites el acceso a `java.exe` en redes privadas/públicas — acepta
al menos "Redes privadas", o nadie podrá conectarse ni siquiera en la misma red.

### Desde fuera de tu casa (por internet)

Aquí sí hay que abrir el puerto hacia el exterior:

1. **Reenvío de puertos (port forwarding) en tu router**: entra al panel de tu
   router (normalmente `192.168.1.1` o `192.168.0.1` en el navegador) y busca
   "Port Forwarding" / "Reenvío de puertos". Reenvía el puerto **25565 TCP** (o el
   que hayas puesto en `server-port`) hacia la IP local de tu PC.
2. Para no tener que dar tu IP a nadie, configura **DuckDNS** desde la propia app
   (ver [DuckDNS integrado](#duckdns-integrado-alternativa)): tus amigos usarán un nombre tipo
   `tuservidor.duckdns.org`, que además se actualiza solo si tu IP cambia.
3. **Si tu operador usa CGNAT** (habitual en fibra compartida o datos móviles) no
   podrás abrir puertos de esta forma, porque tu router ni siquiera tiene una IP
   pública propia. En ese caso, la alternativa es un servicio de túnel como
   **playit.gg** o **ngrok**, que te da una dirección pública sin tocar el router.

Tu PC tiene que estar encendido, con la app abierta (o al menos minimizada a la
bandeja, ver más abajo) y el servidor arrancado, durante todo el tiempo que quieras
que esté disponible.

### Alternativa sin depender de tu PC

Si prefieres no depender de tu conexión ni de tener el PC encendido, la otra opción
es alquilar un VPS (Hetzner, Contabo...) o un hosting específico de Minecraft y
mover ahí el servidor — fuera del alcance de esta app, pero los mismos ficheros
(mods incluidos, generables como ZIP desde aquí) te sirven igual en la máquina remota.

## Bandeja del sistema

- **Minimizar** (el guion "_") oculta la ventana; la app sigue funcionando en
  segundo plano, accesible desde el icono de la bandeja del sistema.
- **Cerrar (la X)** cierra la aplicación del todo. Si tienes servidores en marcha,
  te avisa antes: cerrar corta la tubería de consola del proceso Java, lo que puede
  hacer que el servidor se caiga. Si solo quieres liberar recursos, minimiza en vez
  de cerrar.
- El menú de la bandeja (clic derecho en el icono) tiene "Mostrar ventana",
  "Buscar actualizaciones" y "Salir" (con el mismo aviso de seguridad si hay
  servidores corriendo).

## Empaquetar como ejecutable

El proyecto trae `electron-builder` configurado en `package.json`:

```bash
npm install
npm run dist:win     # instalador .exe (NSIS) en dist/
npm run dist:linux   # .AppImage en dist/
npm run dist:mac     # .dmg en dist/ (solo compilando desde macOS)
```

> Lo normal ya no es compilar a mano: al empujar un tag `vX.Y.Z`, GitHub Actions
> compila los tres instaladores y los publica como Release (ver
> [Actualizaciones automáticas](#actualizaciones-automáticas)).

Notas:
- Usa el icono incluido en `build/`. Si quieres tu propio icono, sustituye
  `build/icon.png` (y opcionalmente genera un `.ico`/`.icns` y referencia esas
  rutas en el bloque `"build"` de `package.json`).
- La primera vez que ejecutes `npm run dist:win` necesitas conexión a internet:
  `electron-builder` descarga los binarios de Electron para la plataforma de destino.
- Puedes compilar el instalador de Windows desde Windows o desde Linux/Mac. Para
  `.dmg` sí necesitas compilar en macOS.

## Limitaciones conocidas

- **Detección de mods vía Modrinth únicamente.** Mods publicados solo en CurseForge
  no se identifican por hash (su API de hashes exige clave de pago). Se listan como
  "no identificado" para decidir manualmente.
- **Forge muy antiguo (pre-1.17)** no genera `run.sh`/`run.bat`; la app detecta ese
  caso y lanza el jar directamente, pero no está probado a fondo en versiones muy
  antiguas.
- **NeoForge** solo existe para Minecraft 1.20.1 en adelante.
- La detección de versión de Minecraft al importar un servidor existente es una
  aproximación; si no la encuentra, te pide que la escribas tú.
- **Auto-actualización en macOS**: electron-updater solo puede actualizar apps
  de Mac firmadas con un certificado de Apple Developer. Sin firma, en Mac hay
  que descargar la nueva versión a mano desde Releases. En Windows y Linux
  (AppImage) funciona sin firma.
- Carpetas gestionadas por funciones de seguridad de Windows (Acceso controlado a
  carpetas de Defender, OneDrive con "Copia de seguridad de carpetas") pueden dar
  errores genéricos al copiar ficheros; usa la opción de exportar a ZIP si te pasa esto.

## Estructura del proyecto

```
main.js                 Proceso principal de Electron (ventana, bandeja, diálogos, actualizador)
preload.js               Puente seguro entre main y la interfaz
src/
  mojangApi.js             Versiones y URLs de descarga (Vanilla/Forge/NeoForge)
  downloader.js             Descarga de ficheros con progreso
  serverManager.js           Orquesta creación/importación de servidores
  serverProperties.js        Genera server.properties
  javaProcess.js            Arranca/para el proceso Java, gestiona su consola y mide CPU/RAM
  processTree.js             Encuentra el PID real de java bajo run.bat/run.sh
  jvmFlags.js                Flags de JVM optimizados (Aikar's flags)
  modAnalyzer.js             Hash + consulta a Modrinth + copiado + diff de mods
  zipWriter.js                Generador/extractor de ZIP sin dependencias externas
  backupManager.js            Crear, listar, restaurar y borrar backups del mundo
  crashDiagnostics.js          Traduce el log de una caída a un mensaje en español
  playerFiles.js               Lectura/edición de whitelist.json, ops.json, banned-players.json
  appCore.js                   Lógica compartida por escritorio y web (lanzar, backups, handlers)
  settings.js                  Ajustes generales (dirección pública) en settings.json
  playit.js                    Dirección de playit por servidor y detección del programa de playit
  duckdns.js                   Actualización automática de DuckDNS (el token nunca sale de aquí)
  store.js / paths.js          Persistencia de la lista de servidores
renderer/
  index.html / style.css / renderer.js   Interfaz de usuario
build/
  icon.png / tray-icon.png     Iconos de la app y de la bandeja
  icon-512.png                 Icono para macOS (exige 512×512 como mínimo)
web/
  server.js                    Servidor web (HTTP + WebSocket) que reutiliza src/ y renderer/
  auth.js                      Usuarios, contraseñas, sesiones y permisos por rol
  access.js                    Dueños de servidores, visibilidad, permisos por servidor y límites
  usuarios.js                  Herramienta de terminal (opcional): npm run usuarios
  public/setup.*               Página para crear el primer administrador con el código de la terminal
  publicTunnel.js              Enlace público de la web con un quick tunnel de Cloudflare
test-fixtures/
  fake-cloudflared.js          cloudflared simulado para los tests (fuera de test/ a propósito)
  public/electron-shim.js      Electron simulado para ejecutar preload.js en el navegador
  public/login.*, roles.css    Página de login y ocultación de controles para amigos
test/                          Tests con node:test (npm test)
.github/workflows/
  test.yml                     Tests en cada push / pull request
  release.yml                  Compila y publica los instaladores al empujar un tag vX.Y.Z
```

## Subir el proyecto a GitHub

El repo ya trae `.gitignore` (excluye `node_modules/`, `dist/` y tu `servers.json`
local, que contiene rutas absolutas de tu PC) y una licencia MIT a juego con el
`package.json`.

```bash
cd minecraft-server-manager
git init
git add .
git commit -m "Primer commit: Minecraft Server Manager"
```

Luego en GitHub.com: **New repository** → nombre → público o privado → **no**
marques "Add a README" ni ".gitignore" (ya los tienes) → **Create repository**. La
propia página te da estas tres líneas con tu URL real:

```bash
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git branch -M main
git push -u origin main
```

Si `git push` pide contraseña y falla, es porque GitHub ya no acepta la contraseña
normal por HTTPS: necesitas un **token de acceso personal** (Settings → Developer
settings → Personal access tokens → Generate new token, con permiso `repo`), que
se usa en su lugar.

Para seguir desarrollando de forma ordenada a partir de aquí:
- Trabaja en una rama por función (`git checkout -b nombre-de-la-mejora`) con
  commits pequeños y descriptivos, en vez de acumularlo todo en uno solo.
- Cuando algo funcione, `git push` esa rama y ábrete un Pull Request hacia `main`
  en GitHub — aunque trabajes solo, deja un historial mucho más legible.
- Si quieres compilar instaladores automáticamente en cada versión, GitHub Actions
  puede ejecutar `npm run dist:win`/`dist:linux` en cada tag y publicar el
  resultado como "Release".

## Fiabilidad: backups, reinicio automático y diagnóstico de caídas

> Rama sugerida para probar esto antes de fusionarlo a `main`: `git checkout -b fiabilidad-backups-reinicio`.

### Copias de seguridad del mundo

Pestaña **Resumen** → tarjeta "Copias de seguridad":

- **Backup ahora** — comprime la carpeta del mundo tal cual está en ese momento en
  `backups/backup-<mundo>-<fecha>.zip`, dentro de la carpeta del servidor. Se
  conservan automáticamente las 10 copias más recientes; las más antiguas se
  eliminan solas. Muestra una barra de progreso real (por bytes procesados, no
  solo un giro indefinido) con una estimación del tiempo restante.
- **Restaurar** — sustituye el mundo actual por el contenido del backup elegido.
  El mundo que hubiera antes de restaurar **no se borra**: se renombra con un
  sufijo `.antes-de-restaurar-<fecha>` por si hace falta recuperarlo. No se puede
  restaurar con el servidor en marcha.
- **Eliminar** — borra un backup concreto que ya no necesites.

Desde pestaña **Configuración** → tarjeta "Fiabilidad" puedes activar backups
automáticos:
- Al detener el servidor (se hace justo después de que el proceso termine de
  guardar el mundo por sí mismo, para no pillarlo a medio guardar).
- Cada X horas mientras el servidor está en marcha (0 = desactivado).

### Reinicio automático si el servidor se cae solo

También en la tarjeta "Fiabilidad": si activas "Reiniciar automáticamente si el
servidor se cae solo", cuando el proceso termine sin que hayas pulsado
"Detener" tú (un crash), la app espera 5 segundos y lo vuelve a arrancar sola.
Si detienes el servidor tú mismo desde el botón o con `/stop`, no cuenta como
caída y no se reinicia solo.

### Diagnóstico de caídas en lenguaje normal

Cuando el proceso termina inesperadamente, la app revisa el log reciente en
busca de patrones habituales (falta de memoria, puerto ocupado, conflicto entre
mods, EULA no aceptado, versión de Java demasiado antigua) y te muestra un
mensaje corto en la Consola y como notificación de escritorio, en vez de un
stacktrace de Java sin traducir. Si no reconoce el patrón, te dice que revises
el log completo.

### Jugadores conectados

Pestaña **Consola**: panel lateral con los jugadores conectados ahora mismo
(detectado leyendo el propio log de "joined/left the game"), con botones
directos de **OP**, **Kick** y **Ban** — equivalen a escribir `/op`, `/kick` y
`/ban` a mano, pero sin tener que teclear el comando.

### Notificaciones de escritorio

La app lanza una notificación del sistema cuando el servidor termina de
arrancar (detecta el "Done (" típico del log) y cuando se cae inesperadamente
(con el diagnóstico incluido en la propia notificación).

### Whitelist, operadores y baneados en tabla

En el mismo panel lateral de la pestaña **Consola**, debajo de los jugadores
conectados, hay tres pestañas — Whitelist / Operadores / Baneados — que leen
directamente `whitelist.json`, `ops.json` y `banned-players.json` y los
muestran como una lista con un botón "Quitar" en cada fila, en vez de tener que
abrir esos ficheros a mano.

- Si el servidor está **parado**, "Quitar" edita el fichero JSON directamente.
- Si está **en marcha**, "Quitar" envía el comando equivalente (`whitelist
  remove`, `deop`, `pardon`) para que el cambio se aplique al momento.
- Para **añadir** alguien, usa los botones OP / Kick / Ban de la lista de
  jugadores conectados (arriba del todo) mientras esa persona esté en el
  servidor — es la forma fiable de que Minecraft resuelva su UUID correctamente.

### Mods: solo lo que cambió desde la última vez

Al analizar una carpeta de mods de cliente para un servidor que ya tenía mods
copiados, cada resultado se compara por hash contra lo que YA hay en la
carpeta `mods/` del servidor y se marca como:
- **Nuevo** — no existía en el servidor.
- **Actualización** — existe con ese nombre pero el contenido es distinto (versión nueva).
- **Ya está igual** — el archivo es idéntico; no hace falta volver a copiarlo
  (viene desmarcado por defecto para que no lo recopies sin querer).

Así, en re-análisis sucesivos de un modpack grande, solo tienes que fijarte en
lo que cambió en vez de repasar los cientos de mods cada vez.

## Clonar un servidor como plantilla

Pestaña **Resumen** → tarjeta "Usar como plantilla" → **Clonar como plantilla**.

Abre el asistente normal de creación con todo ya rellenado a partir del servidor
actual: tipo (Vanilla/Forge/NeoForge), versión de Minecraft y del loader,
memoria, flags de JVM y **todo** su `server.properties`. Puedes cambiar cualquier
cosa antes de crearlo. Después, el servidor se crea exactamente igual que uno
nuevo (descarga, instalador, EULA…).

- **No** se copian el mundo ni los mods: es una plantilla de configuración. Si
  quieres los mismos mods, usa la pestaña Mods sobre el servidor nuevo.
- El nombre propuesto es "<nombre> (copia)" y el **puerto se sube en 1**, para
  que puedas tener los dos servidores encendidos a la vez sin que choquen.
- Si el original era un servidor importado con versión "desconocida", el
  asistente te pedirá elegir la versión de Minecraft.

## Actualizaciones automáticas

La app instalada usa **electron-updater** contra las Releases de GitHub del repo
(`Fjalc99/Aplicacion-Servers-Minecraft`):

- Al arrancar busca una versión nueva; si la hay, la descarga en segundo plano y
  avisa con una notificación.
- Cuando termina, pregunta si quieres reiniciar ya o dejarlo para más tarde (se
  instala sola al cerrar la app). Si hay servidores en marcha, antes de reiniciar
  sale el aviso de siempre.
- Desde el menú de la bandeja: **Buscar actualizaciones** para comprobarlo a mano.
- En desarrollo (`npm start`) no hace nada.

Para publicar una versión nueva:

```bash
npm version patch          # o minor / major: sube package.json y crea el tag vX.Y.Z
git push --follow-tags
```

El workflow `release.yml` compila en Windows, Linux y macOS, pasa los tests,
comprueba que el tag coincide con `package.json` y publica la Release con los
instaladores y los ficheros `latest*.yml` que necesita el actualizador. Usa el
`GITHUB_TOKEN` automático del repo: no hay que configurar ningún secreto.

## Tests e integración continua

```bash
npm test
```

Tests con el runner nativo de Node (`node:test`, sin dependencias extra) sobre
la lógica que no depende de Electron: ZIP (crear/extraer), análisis y copia de
mods, flags de JVM, diagnóstico de caídas, whitelist/ops/baneados, backups
(crear, restaurar, podar) y el árbol de procesos.

El workflow `test.yml` los ejecuta en Ubuntu y Windows en cada push y pull request,
además de comprobar la sintaxis de todos los ficheros JavaScript.

## playit.gg: jugar desde fuera sin abrir puertos (recomendado)

Con playit.gg tus amigos se conectan a una dirección de playit (tipo
`algo.joinmc.link`) y playit reenvía la conexión a tu PC: **no hay que tocar el
router, funciona aunque tu compañía use CGNAT, y tu IP no se ve**.

1. Descarga e instala el programa desde playit.gg/download y ábrelo.
2. La primera vez te da un enlace de *claim*: ábrelo, crea tu cuenta (gratis) y
   vincula tu PC.
3. En el panel de playit: *Add tunnel* → tipo **Minecraft Java** → destino
   `127.0.0.1:<puerto del servidor>`. En **Ajustes** de la app tienes una tabla con
   el destino exacto de cada servidor.
4. Copia la dirección que te da playit y pégala en su fila de esa tabla. Es la que
   verán tus amigos en la página de **Inicio** de ese servidor.

En Ajustes la app también te dice si el programa de playit está en marcha en tu PC.
Tiene que seguir abierto mientras se juega: si se cierra, el túnel se corta.

**Límites del plan gratis** (tabla de precios de playit.gg a finales de septiembre
de 2026): 4 puertos y 2 agentes. Con los túneles de tipo Minecraft Java eso son
**como mucho 4 servidores con dirección de playit** (por ejemplo, el tuyo y tres de
tus amigos). La dirección gratuita es aleatoria pero no cambia. El plan Premium
cuesta unos 3 $ al mes y amplía a 16 puertos.

### ¿Y la web? Enlace público con Cloudflare (gratis, IP oculta)

playit.gg gratis solo sirve para los **servidores de Minecraft**. Para que tus amigos
entren a la **web** (registrarse, encender mundos) sin que se vea tu IP, la app usa
un *quick tunnel* de **Cloudflare**: gratis, sin cuenta, con HTTPS y sin abrir puertos.

1. Instala el programa de Cloudflare. En Windows, en una terminal:
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
   Luego cierra y vuelve a abrir `npm run web`, para que lo encuentre. Si lo tienes
   en otra carpeta, indícala con la variable `MSM_CLOUDFLARED`.
2. En **Ajustes → Enlace de la web para tus amigos**, pulsa **Activar enlace
   público**. En unos segundos aparece una dirección
   `https://palabras-al-azar.trycloudflare.com` con un botón para copiarla.
3. Pásasela a tus amigos. Entran, se crean la cuenta y, cuando la apruebes, ya
   pueden encender los mundos. Para jugar usan la dirección de playit que ven en
   Inicio.

Marca "Activarlo solo cada vez que arranque la web" para no tener que pulsarlo cada
vez. Si el túnel se cae o cambia, te llega un aviso.

Lo que hay que saber:
- **El enlace cambia cada vez que se reinicia el túnel** (al reiniciar la web o el
  PC): hay que volver a pasarlo. Para un enlace fijo haría falta un dominio propio
  con un túnel con nombre de Cloudflare, o playit Premium.
- Cloudflare presenta los quick tunnels como algo para pruebas, no para
  producción, con un máximo de 200 peticiones simultáneas. Para un grupo de amigos
  sobra, pero no hay garantía de disponibilidad.
- El enlace es público. Cualquiera que lo tenga ve la pantalla de entrar, pero nadie
  puede usar la web sin una cuenta aprobada por ti. Tampoco pueden crearse el
  primer administrador sin el código de tu terminal.
- La web sigue escuchando solo en `127.0.0.1`: el túnel sale desde tu PC, así que
  no hay que abrir nada en el router.

Si prefieres otra opción: **playit Premium** (unos 3 $ al mes, túnel HTTPS con
dirección fija) o **Caddy + DuckDNS abriendo el 443** (gratis, pero con ese método tu
IP sí se puede averiguar; ver más abajo).

## DuckDNS integrado (alternativa)

Si prefieres abrir puertos en el router en vez de usar playit, en **Ajustes →
Alternativa** puedes configurar DuckDNS para que tus amigos se conecten con un
nombre en vez de tu IP:

1. Entra en [duckdns.org](https://www.duckdns.org) e inicia sesión.
2. Crea un subdominio (por ejemplo `miserver`) con *add domain*.
3. Copia el *token* que aparece arriba de la página.
4. En la app: Ajustes → escribe el subdominio y el token → **Guardar y comprobar**.

La app hace una actualización real para comprobar que los datos son correctos y
solo entonces los guarda. A partir de ahí:
- Actualiza la IP cada 5 minutos mientras la app (escritorio o `npm run web`)
  esté abierta, así que no hace falta el Programador de tareas ni tocar el router.
- Pone `miserver.duckdns.org` como dirección pública, y es la que aparece en la
  página de Inicio de cada servidor para tus amigos.
- El token se guarda en `settings.json` dentro de la carpeta de datos y **nunca se
  envía a la interfaz**: ni tus amigos ni nadie que abra la web puede verlo.

Si tu router tiene DuckDNS en su apartado "DDNS", también puedes configurarlo ahí;
no pasa nada por tener los dos.

**DuckDNS no oculta tu IP.** Le pone un nombre, pero cualquiera puede consultar a
qué IP apunta (`nslookup miserver.duckdns.org`). Si no quieres que se vea, hace falta
un túnel como playit.gg, que reenvía el tráfico por sus servidores. DuckDNS tampoco
abre puertos: sigue siendo necesario reenviarlos en el router.

## Página de inicio (estilo Aternos)

Al elegir un servidor se abre la pestaña **Inicio**, pensada para jugar y no para
administrar:

- El **estado** en grande: Apagado, Iniciando…, En línea o Deteniendo… "En línea"
  solo aparece cuando el servidor ha terminado de cargar de verdad (cuando escribe
  `Done` en la consola), así tus amigos saben cuándo pueden entrar.
- Un **botón grande** para iniciar o detener.
- La **dirección para conectarse**, con botón de copiar y el puerto si no es el 25565.
- Jugadores conectados sobre el máximo, software y versión.
- Las últimas líneas de la consola, con un enlace a la consola completa.

Funciona igual en la app de escritorio y en la web.

### La dirección que ven tus amigos

Se elige en este orden:
1. La **dirección pública**: la pone sola DuckDNS, o puedes escribirla tú en
   Ajustes (por ejemplo si tienes un dominio propio). Se guarda en `settings.json`
   dentro de la carpeta de datos, o se puede dar con la variable
   `MSM_DIRECCION_PUBLICA`.
2. En la web, si se ha entrado por un dominio (por ejemplo a través de Caddy), ese
   mismo dominio.
3. Si no, la IP de tu red local, avisando de que solo sirve para quien esté en tu
   misma WiFi.

## Apagado automático y cola de espera

**Apagado automático sin jugadores.** Viene activado en todos los servidores: si un
servidor está *En línea* y no hay nadie conectado durante **10 minutos**, se apaga
solo, guardando el mundo y haciendo el backup de "al detener" si lo tienes activado.
- La cuenta atrás solo empieza cuando el servidor ha terminado de cargar, así que
  un modpack que tarda en arrancar no se apaga a medias.
- En cuanto entra alguien se cancela, y si luego se van todos vuelve a empezar.
- En **Inicio** aparece un **reloj con la cuenta atrás** (minutos y segundos, en
  naranja el último minuto). Se calcula con la hora de tu PC, así que marca bien
  aunque el móvil u ordenador de un amigo tenga la hora mal puesta.
- Se cambia en **Configuración → Fiabilidad**: se puede desactivar o poner entre 1
  y 240 minutos. En tus servidores lo decides tú; en los suyos, cada amigo.

**Cola de espera (versión web).** Si un amigo pulsa *Iniciar* pero el PC no tiene
memoria libre (los encendidos ya ocupan el 85 % de la RAM), su servidor no da error:
entra en una **cola**. En Inicio verá "En cola, posición 1" con un botón para salir
de ella, y cuando se apague otro servidor (a mano o por el apagado automático), el
primero de la cola se enciende solo y le llega un aviso. Las dos cosas juntas hacen
que tu PC aguante a más amigos: los servidores olvidados se apagan y dejan sitio.

## Versión web con acceso para amigos

Además de la app de escritorio, el proyecto se puede usar desde el navegador, con
usuarios y permisos, para que tus amigos puedan encender el servidor sin ti.

### Primer arranque

```bash
npm install
npm run web
```

La primera vez, la terminal muestra un **código de configuración** de 8 caracteres.
Abre `http://127.0.0.1:3000`: te llevará a "Crea el administrador", donde pones ese
código, tu usuario y tu contraseña. El código solo aparece en la terminal de tu PC,
así que nadie más puede quedarse con la cuenta de administrador aunque la web ya
estuviera accesible desde fuera.

### Cuentas: registro desde la web

- Cualquiera puede pulsar **"Crear una"** en la pantalla de inicio de sesión. La
  cuenta queda **pendiente** y no puede entrar hasta que la apruebes.
- Te llega un aviso, y en **Ajustes → Usuarios** tienes las pendientes con
  *Aprobar* / *Rechazar*.
- En esa misma tarjeta puedes cambiar el rol (amigo o administrador), dar permiso de
  comandos en tus servidores, generar una **contraseña temporal** a quien la olvide
  (se muestra una sola vez) y borrar cuentas.
- Cada usuario puede cambiar su contraseña desde "Cambiar contraseña", abajo a la
  derecha.
- Contra el spam: como mucho 3 registros por hora desde la misma conexión y 20
  cuentas pendientes a la vez.

La herramienta de terminal sigue existiendo por si la necesitas
(`npm run usuarios -- listar`, `crear`, `borrar`, `password`, `comandos`), pero ya
no hace falta para nada.

Hay dos tipos de servidor:

- **Compartidos**: los que crea o importa un administrador, y los que ya existían
  desde la app de escritorio. Todos los amigos los ven y pueden encenderlos sin que
  tú tengas que hacer nada.
- **Propios de un amigo**: los que crea él. Solo los ven él y los administradores
  (en la lista aparecen como "tuyo" o "de pepe").

| Puede… | Admin | Amigo en uno compartido | Amigo en uno suyo |
|---|:-:|:-:|:-:|
| Ver, consola, jugadores y gráficas | ✓ | ✓ | ✓ |
| Encender y apagar | ✓ | ✓ | ✓ |
| Hacer backups | ✓ | ✓ | ✓ |
| Escribir comandos, OP/Kick/Ban | ✓ | solo con `--comandos` | ✓ |
| Forzar la parada | ✓ | ✗ | ✓ |
| Restaurar o borrar backups | ✓ | ✗ | ✓ |
| Configuración y RAM | ✓ | ✗ | ✓ (con límites) |
| Borrar el servidor | ✓ | ✗ | ✓ |
| Crear servidores (Vanilla/Forge/NeoForge) | ✓ | ✓ (serán suyos) | — |
| Importar servidores o mundos, mods desde carpeta, abrir carpetas | ✓ | ✗ | ✗ |
| Ver servidores de otros amigos | ✓ | ✗ | ✗ |

Lo último es siempre solo para administradores porque trabaja con rutas del disco
del PC: un amigo podría leer tus archivos o meter mods, que son código que se
ejecuta en tu equipo.

### Límites para los servidores de amigos

Para que entre todos no dejen el PC sin memoria:

| Límite | Por defecto | Variable para cambiarlo |
|---|---|---|
| Servidores por amigo | 2 | `MSM_AMIGO_MAX_SERVIDORES` |
| Encendidos a la vez por amigo | 1 | `MSM_AMIGO_MAX_ENCENDIDOS` |
| RAM máxima por servidor | 4096 MB | `MSM_AMIGO_MAX_RAM_MB` |
| Puertos para sus servidores | 25566–25599 | `MSM_AMIGO_PUERTO_MIN` / `MSM_AMIGO_PUERTO_MAX` |

Además, si al encender un servidor (suyo o compartido) la RAM asignada a todos los
encendidos pasaría del 85 % de la del PC, no se enciende en ese momento: entra en la
cola de espera (ver [Apagado automático y cola de espera](#apagado-automático-y-cola-de-espera)).

A cada servidor nuevo de un amigo se le asigna automáticamente un puerto libre de
ese rango. Para que se pueda jugar en él desde fuera:
- **Con playit.gg:** crea un túnel Minecraft Java hacia ese puerto y pega su
  dirección en la tabla de Ajustes (recuerda: 4 túneles en el plan gratis).
- **Abriendo puertos:** reenvía en el router el rango 25566–25599 TCP a tu PC.
  Tus amigos juegan en `tuservidor.duckdns.org:<puerto>`.

Ejemplo en PowerShell para permitir 3 servidores por amigo:

```powershell
$env:MSM_AMIGO_MAX_SERVIDORES="3"; npm run web
```

Los permisos se comprueban **en el servidor** (`web/access.js` y `web/auth.js`). A los amigos también
se les ocultan los botones que no pueden usar, pero eso es solo para que la
interfaz sea clara.

Detalles de seguridad incluidos:
- Las contraseñas se guardan cifradas con scrypt en `<DATA_DIR>/web-users.json`,
  nunca en claro.
- Las sesiones duran 7 días en una cookie `HttpOnly` y `SameSite=Lax`. Al
  reiniciar `npm run web` hay que volver a entrar.
- Tras 5 intentos de login fallidos desde la misma IP, se bloquea 15 minutos.
- Se rechazan peticiones y conexiones WebSocket que vengan de otra web (CSRF).
- Cambiar la contraseña de alguien o borrarlo le cierra la sesión al momento.

### Cómo está hecha

- `src/appCore.js` contiene la lógica que comparten escritorio y web (lanzar
  servidores, backups automáticos, reinicio automático, mods, jugadores...).
- `web/server.js` sirve la carpeta `renderer/` tal cual, recibe las llamadas en
  `POST /api/invoke` y envía los eventos en vivo por WebSocket en `/ws`.
- En el navegador se ejecuta **el propio `preload.js`** sobre un Electron
  simulado (`web/public/electron-shim.js`). Si añades una función nueva a
  `preload.js` y a `src/appCore.js`, aparece a la vez en escritorio y en la web.
  Si debe estar disponible para amigos, añade también su canal a
  `FRIEND_CHANNELS` en `web/auth.js` (servidores compartidos) y/o a
  `OWNER_CHANNELS` en `web/access.js` (sus propios servidores).

### Diferencias con la app de escritorio

| Escritorio | Web |
|---|---|
| Elegir carpeta con el explorador | Se escribe la ruta (del equipo donde corre `npm run web`) |
| "Guardar ZIP de mods" con diálogo | El ZIP se descarga en el navegador |
| Notificaciones del sistema | Notificaciones del navegador (se piden al primer clic) |
| Bandeja del sistema, actualizaciones automáticas | No aplican |

- Usa la misma carpeta de datos que la app de escritorio, así que ve los mismos
  servidores. Con `DATA_DIR` puedes elegir otra; `PORT` cambia el puerto (3000 por
  defecto).
- **No uses a la vez la app de escritorio y la web con un servidor en marcha.** Cada
  una solo sabe qué servidores ha arrancado ella, y podrías lanzar el mismo dos veces.
- Al cerrar con Ctrl+C, si hay servidores en marcha se les manda `stop` y se espera
  a que guarden el mundo antes de salir.

### Acceso desde internet con HTTPS (Caddy + DuckDNS)

Nunca expongas `npm run web` directamente: sin HTTPS las contraseñas viajarían
sin cifrar. Déjalo escuchando en `127.0.0.1` (lo que hace por defecto) y pon
delante **Caddy**, que consigue y renueva el certificado HTTPS él solo.

1. Ten DuckDNS configurado en Ajustes (ver [DuckDNS integrado](#duckdns-integrado-alternativa)).
2. En el router, reenvía a tu PC los puertos **80 y 443 TCP** (Caddy necesita el 80
   para obtener el certificado). No abras el 3000.
3. Descarga Caddy de caddyserver.com y crea un archivo `Caddyfile`:

   ```
   tuservidor.duckdns.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```

4. Con `npm run web` en marcha, ejecuta `caddy run` en la carpeta del `Caddyfile`.
5. Tus amigos entran en `https://tuservidor.duckdns.org` y juegan en
   `tuservidor.duckdns.org:25565`, como antes.

Si tu operador usa CGNAT no podrás abrir puertos. En ese caso hace falta un túnel
(por ejemplo Cloudflare Tunnel) en vez de reenviar puertos.

### Que funcione aunque tú no estés

Tus amigos no necesitan que hagas nada para encender servidores, pero **tu PC tiene
que estar encendido** y con `npm run web` (y Caddy) funcionando. Para no depender de
tener una terminal abierta ni la sesión iniciada, instálalos como servicios de
Windows con [NSSM](https://nssm.cc), así arrancan solos con el PC:

```powershell
nssm install MinecraftWeb "C:\Program Files\nodejs\node.exe" "C:\ruta\al\proyecto\web\server.js"
nssm set MinecraftWeb AppDirectory "C:\ruta\al\proyecto"
nssm set MinecraftWeb AppEnvironmentExtra DATA_DIR=C:\Users\Usuario\AppData\Roaming\minecraft-server-manager
nssm start MinecraftWeb
```

(Con `DATA_DIR` apuntando a la misma carpeta que usa la app, porque el servicio
no corre con tu usuario y si no buscaría los datos en otro sitio.) Haz lo mismo
con `caddy.exe run` para Caddy. Y en las opciones de energía de Windows, evita que
el PC se suspenda.

Si quieres que funcione **con tu PC apagado**, la única forma es mover todo a una
máquina que esté siempre encendida (un VPS o un miniPC en casa).

## Pendiente

Queda fuera de esta tanda, tal y como se habló: una segunda fuente de
identificación de mods vía la API de CurseForge, para los casos que Modrinth no
reconoce. Necesita una clave de API propia (de pago), así que se deja para
cuando/si se decide dar ese paso.
