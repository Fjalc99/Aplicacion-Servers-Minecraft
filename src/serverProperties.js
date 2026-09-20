const DEFAULTS = {
  difficulty: 'normal', // peaceful | easy | normal | hard
  gamemode: 'survival', // survival | creative | adventure | spectator
  'max-players': 20,
  pvp: true,
  hardcore: false,
  motd: 'Servidor de Minecraft',
  'online-mode': true,
  'white-list': false,
  'spawn-protection': 16,
  'view-distance': 10,
  'simulation-distance': 10,
  'allow-flight': false,
  'enable-command-block': false,
  'level-seed': '',
  'level-name': 'world',
  'server-port': 25565,
};

function buildServerProperties(userConfig) {
  const cfg = { ...DEFAULTS, ...userConfig };
  const lines = [
    '# Generado por Minecraft Server Manager',
    ...Object.entries(cfg).map(([key, value]) => `${key}=${value}`),
  ];
  return lines.join('\n') + '\n';
}

module.exports = { buildServerProperties, DEFAULTS };
