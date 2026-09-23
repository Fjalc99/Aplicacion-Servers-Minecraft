const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../src/crashDiagnostics');

test('detecta falta de memoria', () => {
  assert.match(diagnose('java.lang.OutOfMemoryError: Java heap space'), /sin memoria/);
});

test('detecta puerto ocupado', () => {
  assert.match(diagnose('**** FAILED TO BIND TO PORT!\njava.net.BindException: Address already in use'), /puerto/);
});

test('detecta conflictos de mods', () => {
  assert.match(diagnose('Mixin apply failed examplemod.mixins.json'), /conflicto entre mods/);
});

test('detecta EULA no aceptado', () => {
  assert.match(diagnose('You need to agree to the EULA in order to run the server'), /EULA/);
});

test('detecta Java demasiado antiguo', () => {
  assert.match(diagnose('java.lang.UnsupportedClassVersionError: net/minecraft/...'), /Java/);
});

test('respeta el orden: memoria gana a excepción genérica', () => {
  const log = 'Exception in thread "main" java.lang.OutOfMemoryError';
  assert.match(diagnose(log), /sin memoria/);
});

test('mensaje genérico si no reconoce nada', () => {
  assert.match(diagnose('todo normal'), /No se ha podido identificar/);
});
