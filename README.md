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
- [Estructura del proyecto](#estructura-del-proyecto)
- [Subir el proyecto a GitHub](#subir-el-proyecto-a-github)

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
  ciertos antivirus), usa "Generar ZIP con los seleccionados": eliges dónde
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
2. Averigua tu **IP pública** (buscando "cuál es mi ip" en Google) y dásela a tus
   amigos junto con el puerto, si no es el 25565: `TU_IP_PUBLICA:PUERTO`.
3. Si tu IP pública cambia a menudo, usa un servicio de **DNS dinámico** (No-IP,
   DuckDNS) para tener un nombre fijo tipo `tuservidor.duckdns.org` en vez de una
   IP que cambia.
4. **Si tu operador usa CGNAT** (habitual en fibra compartida o datos móviles) no
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
- El menú de la bandeja (clic derecho en el icono) tiene "Mostrar ventana" y
  "Salir" (con el mismo aviso de seguridad si hay servidores corriendo).

## Empaquetar como ejecutable

El proyecto trae `electron-builder` configurado en `package.json`:

```bash
npm install
npm run dist:win     # instalador .exe (NSIS) en dist/
npm run dist:linux   # .AppImage en dist/
npm run dist:mac     # .dmg en dist/ (solo compilando desde macOS)
```

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
- No hay gestión de copias de seguridad de mundo todavía.
- Carpetas gestionadas por funciones de seguridad de Windows (Acceso controlado a
  carpetas de Defender, OneDrive con "Copia de seguridad de carpetas") pueden dar
  errores genéricos al copiar ficheros; usa la opción de exportar a ZIP si te pasa esto.

## Estructura del proyecto

```
main.js                 Proceso principal de Electron + handlers IPC
preload.js               Puente seguro entre main y la interfaz
src/
  mojangApi.js             Versiones y URLs de descarga (Vanilla/Forge/NeoForge)
  downloader.js             Descarga de ficheros con progreso
  serverManager.js           Orquesta creación/importación de servidores
  serverProperties.js        Genera server.properties
  javaProcess.js            Arranca/para el proceso Java y gestiona su consola
  jvmFlags.js                Flags de JVM optimizados (Aikar's flags)
  modAnalyzer.js             Hash + consulta a Modrinth + copiado de mods
  zipWriter.js                Generador de ZIP sin dependencias externas
  store.js / paths.js          Persistencia de la lista de servidores
renderer/
  index.html / style.css / renderer.js   Interfaz de usuario
build/
  icon.png / tray-icon.png     Iconos de la app y de la bandeja
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
