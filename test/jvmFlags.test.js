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
