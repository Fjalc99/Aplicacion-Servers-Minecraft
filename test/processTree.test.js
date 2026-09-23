const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePsOutput, parseWindowsCsv, findJavaDescendant } = require('../src/processTree');

test('parsePsOutput interpreta la salida de ps', () => {
  const out = parsePsOutput('    1     0 systemd\n  500     1 bash\n  501   500 java\n');
  assert.deepEqual(out, [
    { pid: 1, ppid: 0, name: 'systemd' },
    { pid: 500, ppid: 1, name: 'bash' },
    { pid: 501, ppid: 500, name: 'java' },
  ]);
});

test('parseWindowsCsv ignora la cabecera y parsea filas', () => {
  const csv = '"ProcessId","ParentProcessId","Name"\r\n"4","0","System"\r\n"900","800","cmd.exe"\r\n"901","900","java.exe"\r\n';
  assert.deepEqual(parseWindowsCsv(csv), [
    { pid: 4, ppid: 0, name: 'System' },
    { pid: 900, ppid: 800, name: 'cmd.exe' },
    { pid: 901, ppid: 900, name: 'java.exe' },
  ]);
});

test('findJavaDescendant: run.bat (cmd.exe -> java.exe)', () => {
  const procs = [
    { pid: 900, ppid: 1, name: 'cmd.exe' },
    { pid: 950, ppid: 900, name: 'conhost.exe' },
    { pid: 901, ppid: 900, name: 'java.exe' },
  ];
  assert.equal(findJavaDescendant(procs, 900), 901);
});

test('findJavaDescendant: el propio PID ya es java', () => {
  assert.equal(findJavaDescendant([{ pid: 10, ppid: 1, name: 'java' }], 10), 10);
});

test('findJavaDescendant: java nieto y rutas completas', () => {
  const procs = [
    { pid: 500, ppid: 1, name: 'bash' },
    { pid: 510, ppid: 500, name: 'sh' },
    { pid: 520, ppid: 510, name: '/usr/lib/jvm/bin/java' },
  ];
  assert.equal(findJavaDescendant(procs, 500), 520);
});

test('findJavaDescendant: no confunde procesos ajenos ni nombres parecidos', () => {
  const procs = [
    { pid: 500, ppid: 1, name: 'bash' },
    { pid: 501, ppid: 500, name: 'javascript-helper' },
    { pid: 600, ppid: 1, name: 'java' }, // java de otro programa, no descendiente
  ];
  assert.equal(findJavaDescendant(procs, 500), null);
});
