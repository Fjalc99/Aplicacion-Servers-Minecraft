const test = require('node:test');
const assert = require('node:assert/strict');
const { buildJvmArgs, AIKAR_FLAGS } = require('../src/jvmFlags');

test('buildJvmArgs sin optimizar solo pone memoria', () => {
  assert.deepEqual(buildJvmArgs(4096, false), ['-Xmx4096M', '-Xms1024M']);
});

test('buildJvmArgs limita -Xms a la memoria máxima si es menor de 1 GB', () => {
  assert.deepEqual(buildJvmArgs(768, false), ['-Xmx768M', '-Xms768M']);
});

test('buildJvmArgs con optimización añade los Aikar flags tras la memoria', () => {
  const args = buildJvmArgs(2048, true);
  assert.deepEqual(args.slice(0, 2), ['-Xmx2048M', '-Xms1024M']);
  assert.deepEqual(args.slice(2), AIKAR_FLAGS);
  assert.ok(args.includes('-XX:+UseG1GC'));
});

const { parseMemoryArgs, mergeUserJvmArgs, toMb } = require('../src/jvmFlags');

test('buildJvmArgs respeta la memoria mínima elegida (y nunca por encima de la máxima)', () => {
  assert.deepEqual(buildJvmArgs(9000, false, 4096), ['-Xmx9000M', '-Xms4096M']);
  assert.deepEqual(buildJvmArgs(2048, false, 4096), ['-Xmx2048M', '-Xms2048M']);
  assert.deepEqual(buildJvmArgs(9000, false, null), ['-Xmx9000M', '-Xms1024M']);
});

test('lee -Xmx/-Xms de user_jvm_args.txt en cualquier unidad', () => {
  assert.equal(toMb('8G'), 8192);
  assert.equal(toMb('6144m'), 6144);
  assert.deepEqual(parseMemoryArgs('# Xmx comentado -Xmx1G\n-Xmx8G\n-Xms2048M\n'), { maxMb: 8192, minMb: 2048 });
  assert.deepEqual(parseMemoryArgs('-Xmx10G -Xms10G'), { maxMb: 10240, minMb: 10240 });
  assert.deepEqual(parseMemoryArgs(''), { maxMb: null, minMb: null });
});

test('al reescribir user_jvm_args.txt se conservan comentarios y opciones propias', () => {
  const before = '# Edita esto\n-Xmx4G\n-Xms4G\n-XX:+UseG1GC\n-Dfml.readTimeout=180 -Dmi.opcion=1\n';
  const after = mergeUserJvmArgs(before, 9000, true, 2048);
  const lines = after.trim().split('\n');
  assert.equal(lines[0], '# Edita esto');
  assert.deepEqual(lines.slice(1, 3), ['-Xmx9000M', '-Xms2048M']);
  assert.ok(lines.includes('-Dfml.readTimeout=180') && lines.includes('-Dmi.opcion=1'));
  assert.equal(lines.filter((l) => l === '-XX:+UseG1GC').length, 1, 'sin flags duplicados');
  assert.ok(!after.includes('-Xmx4G'));
  // Sin optimización se quitan los flags de la app pero no los propios
  const plain = mergeUserJvmArgs(after, 9000, false, 2048);
  assert.ok(!plain.includes('-XX:+UseG1GC'));
  assert.ok(plain.includes('-Dmi.opcion=1'));
});
