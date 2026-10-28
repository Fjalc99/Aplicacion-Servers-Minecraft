/**
 * Lector/editor de los .toml de configuración de los mods (el formato que
 * escribe NeoForge/Forge: comentarios con "#", tablas [seccion], y pistas como
 * "# Range: 0 ~ 100", "# Allowed Values: A, B" o "# Default: 5").
 *
 * No es un TOML completo: lo que no entiende lo marca como "raw" (se puede
 * editar como texto TOML) o de solo lectura. A cambio, al guardar solo toca el
 * valor de las opciones cambiadas: comentarios, orden y espacios se conservan.
 */

// ---------------------------------------------------------------------------
// Valores TOML de una línea (o array multilínea)
// ---------------------------------------------------------------------------

class TomlValueError extends Error {}

/** Lee un valor TOML que empieza en text[i]. Devuelve { value, type, end }. */
function readValue(text, i) {
  i = skipSpaces(text, i);
  const c = text[i];
  if (c === undefined) throw new TomlValueError('Falta el valor.');
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const quote = text.slice(i, i + 3);
    const close = text.indexOf(quote, i + 3);
    if (close < 0) throw new TomlValueError('Texto multilínea sin cerrar.');
    let raw = text.slice(i + 3, close);
    if (raw.startsWith('\r\n')) raw = raw.slice(2);
    else if (raw.startsWith('\n')) raw = raw.slice(1);
    return { value: quote === '"""' ? unescapeBasic(raw) : raw, type: 'string', end: close + 3, multiline: true };
  }
  if (c === '"') {
    let j = i + 1;
    let out = '';
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\n') throw new TomlValueError('Texto sin cerrar.');
      if (text[j] === '\\') {
        out += text.slice(j, j + 2);
        j += 2;
        if (text[j - 1] === 'u') { out += text.slice(j, j + 4); j += 4; }
        else if (text[j - 1] === 'U') { out += text.slice(j, j + 8); j += 8; }
        continue;
      }
      out += text[j++];
    }
    if (text[j] !== '"') throw new TomlValueError('Texto sin cerrar.');
    return { value: unescapeBasic(out), type: 'string', end: j + 1 };
  }
  if (c === "'") {
    const close = text.indexOf("'", i + 1);
    const nl = text.indexOf('\n', i + 1);
    if (close < 0 || (nl >= 0 && nl < close)) throw new TomlValueError('Texto sin cerrar.');
    return { value: text.slice(i + 1, close), type: 'string', end: close + 1 };
  }
  if (c === '[') {
    const items = [];
    let j = i + 1;
    for (;;) {
      j = skipBlank(text, j);
      if (text[j] === ']') { j++; break; }
      if (j >= text.length) throw new TomlValueError('Lista sin cerrar.');
      const item = readValue(text, j);
      items.push(item);
      j = skipBlank(text, item.end);
      if (text[j] === ',') { j++; continue; }
      if (text[j] === ']') { j++; break; }
      throw new TomlValueError('Lista mal escrita.');
    }
    const types = new Set(items.map((x) => x.type));
    const itemType = types.size === 1 ? [...types][0] : types.size === 0 ? 'string' : 'mixed';
    return { value: items.map((x) => x.value), type: 'list', itemType, end: j };
  }
  if (c === '{') {
    // Tabla en línea: se guarda tal cual (se edita como texto).
    let depth = 0;
    let j = i;
    let inStr = null;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\' && inStr === '"') { j++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    if (j >= text.length) throw new TomlValueError('Tabla sin cerrar.');
    return { value: text.slice(i, j + 1), type: 'inline', end: j + 1 };
  }
  const m = /^[^\s,\]\}#]+/.exec(text.slice(i));
  if (!m) throw new TomlValueError('Valor no válido.');
  const word = m[0];
  const end = i + word.length;
  if (word === 'true' || word === 'false') return { value: word === 'true', type: 'bool', end };
  const clean = word.replace(/_/g, '');
  if (/^[+-]?\d+$/.test(clean)) return { value: Number(clean), type: 'int', end, rawNumber: clean };
  if (/^0x[0-9a-f]+$/i.test(clean)) return { value: parseInt(clean, 16), type: 'int', end, rawNumber: clean };
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(clean) || /^[+-]?(inf|nan)$/.test(clean)) {
    return { value: Number(clean.replace(/inf$/, 'Infinity')), type: 'float', end, rawNumber: clean };
  }
  // Fechas u otras cosas raras: se guardan como texto sin comillas.
  return { value: word, type: 'other', end };
}

function skipSpaces(text, i) {
  while (text[i] === ' ' || text[i] === '\t') i++;
  return i;
}

/** Salta espacios, saltos de línea y comentarios (dentro de listas multilínea). */
function skipBlank(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '#') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    return i;
  }
}

function unescapeBasic(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      case '\\': return '\\';
      case 'u':
      case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: return all;
    }
  });
}

function quote(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\\\';
      case '"': return '\\"';
      case '\n': return '\\n';
      case '\t': return '\\t';
      case '\r': return '\\r';
      default: return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    }
  }) + '"';
}

function formatNumber(n, type) {
  if (type === 'int') return String(Math.trunc(n));
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Escribe un valor en TOML con el mismo tipo que tenía la opción. */
function formatValue(value, option) {
  switch (option.type) {
    case 'bool': return value ? 'true' : 'false';
    case 'int':
    case 'float': return formatNumber(Number(value), option.type);
    case 'string':
    case 'enum': return quote(value);
    case 'list': {
      const items = value.map((v) => (option.itemType === 'int' || option.itemType === 'float' ? formatNumber(Number(v), option.itemType) : option.itemType === 'bool' ? (v ? 'true' : 'false') : quote(v)));
      return `[${items.join(', ')}]`;
    }
    default: return String(value);
  }
}

// ---------------------------------------------------------------------------
// Pistas de los comentarios
// ---------------------------------------------------------------------------

function parseHints(commentLines) {
  const help = [];
  const hints = {};
  for (const raw of commentLines) {
    const line = raw.trim();
    let m;
    if ((m = /^Range:\s*(.+)$/i.exec(line))) {
      const r = m[1].trim();
      let mm;
      if ((mm = /^(-?[\d.eE+-]+)\s*~\s*(-?[\d.eE+-]+)$/.exec(r))) hints.range = { min: Number(mm[1]), max: Number(mm[2]) };
      else if ((mm = /^>\s*=?\s*(-?[\d.eE+-]+)$/.exec(r))) hints.range = { min: Number(mm[1]) };
      else if ((mm = /^<\s*=?\s*(-?[\d.eE+-]+)$/.exec(r))) hints.range = { max: Number(mm[1]) };
      continue;
    }
    if ((m = /^Allowed Values:\s*(.+)$/i.exec(line))) {
      hints.choices = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if ((m = /^Default:\s*(.*)$/i.exec(line))) {
      hints.defaultRaw = m[1].trim();
      continue;
    }
    help.push(line);
  }
  // Algunos mods meten el "Range" dentro del texto: "... [range: 0 ~ 100, default: 50]"
  const joined = help.join('\n');
  if (!hints.range) {
    const m = /\[range:\s*(-?[\d.]+)\s*~\s*(-?[\d.]+)/i.exec(joined);
    if (m) hints.range = { min: Number(m[1]), max: Number(m[2]) };
  }
  if (hints.defaultRaw === undefined) {
    const m = /default:\s*([^,\]\n]+)/i.exec(joined);
    if (m) hints.defaultRaw = m[1].trim();
  }
  return { help: joined.trim(), ...hints };
}

function parseDefault(raw, option) {
  if (raw === undefined || raw === '') return undefined;
  try {
    const v = readValue(raw, 0);
    if (option.type === 'enum' && v.type === 'string') return v.value;
    if (v.type === option.type || (option.type === 'float' && v.type === 'int')) return v.value;
    if (option.type === 'list' && v.type === 'list') return v.value;
  } catch (err) { /* el default puede estar escrito sin comillas */ }
  if (option.type === 'enum' || option.type === 'string') return raw.replace(/^["']|["']$/g, '');
  if (option.type === 'bool' && (raw === 'true' || raw === 'false')) return raw === 'true';
  return undefined;
}

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

function readKey(line, i) {
  const parts = [];
  for (;;) {
    i = skipSpaces(line, i);
    if (line[i] === '"' || line[i] === "'") {
      const v = readValue(line, i);
      parts.push(v.value);
      i = v.end;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    i = skipSpaces(line, i);
    if (line[i] === '.') { i++; continue; }
    return { parts, end: i };
  }
}

/**
 * Analiza el texto. Devuelve { sections: [{ title, path, options }], options }
 * donde cada opción es { id, path, key, type, value, help, range, choices,
 * default, readOnly } más datos internos (start/end del valor en el texto).
 */
function parse(text, { strict = false } = {}) {
  const options = [];
  const sections = [];
  let current = { title: '', path: [], options: [], readOnly: false, help: '' };
  sections.push(current);
  let comments = [];
  let pos = 0;
  let curStart = 0;
  const fail = (msg) => {
    throw new TomlValueError(`línea ${text.slice(0, curStart).split('\n').length}: ${msg}`);
  };
  while (pos < text.length) {
    curStart = pos;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    const trimmed = line.trim();
    const lineStart = pos;
    pos = nl < 0 ? text.length : nl + 1;

    if (trimmed === '') { comments = []; continue; }
    if (trimmed.startsWith('#')) { comments.push(trimmed.replace(/^#+\s?/, '')); continue; }

    if (trimmed.startsWith('[')) {
      const isArray = trimmed.startsWith('[[');
      const k = readKey(trimmed, isArray ? 2 : 1);
      if (strict && (!k || !trimmed.slice(k.end).startsWith(isArray ? ']]' : ']'))) fail('cabecera de sección mal escrita.');
      const path = k ? k.parts : [trimmed];
      current = {
        title: path.join(' › '),
        path,
        options: [],
        readOnly: isArray,
        help: comments.join('\n').trim(),
      };
      sections.push(current);
      comments = [];
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const k = readKey(line, indent);
    if (!k || line[k.end] !== '=') {
      if (strict) fail('se esperaba "clave = valor".');
      comments = [];
      continue;
    }
    let v;
    try {
      v = readValue(text, lineStart + k.end + 1);
    } catch (err) {
      if (strict) fail(err.message);
      comments = [];
      continue;
    }
    if (strict) {
      const rest = skipSpaces(text, v.end);
      if (text[rest] !== undefined && text[rest] !== '\n' && text[rest] !== '\r' && text[rest] !== '#') fail('sobra texto después del valor.');
    }
    const valueStart = skipSpaces(text, lineStart + k.end + 1);
    // Si el valor ocupa varias líneas, seguir leyendo desde donde acaba.
    const after = text.indexOf('\n', v.end);
    pos = Math.max(pos, after < 0 ? text.length : after + 1);

    const hints = parseHints(comments);
    comments = [];
    let type = v.type;
    if (type === 'string' && hints.choices && hints.choices.length) type = 'enum';
    if (type === 'string' && v.multiline) type = 'raw';
    if (type === 'list' && v.itemType === 'mixed') type = 'raw';
    if (type === 'inline' || type === 'other') type = 'raw';
    if (type === 'list' && v.value.some((x) => typeof x === 'object')) type = 'raw';

    const fullPath = [...current.path, ...k.parts];
    const option = {
      id: fullPath.join('.'),
      path: fullPath,
      key: k.parts.join('.'),
      type,
      itemType: v.itemType,
      value: type === 'raw' ? text.slice(valueStart, v.end) : v.value,
      help: hints.help,
      range: hints.range || null,
      choices: hints.choices || null,
      readOnly: current.readOnly,
      _start: valueStart,
      _end: v.end,
    };
    // En un [[array de tablas]] varias opciones pueden repetir id: se distinguen por posición.
    if (current.readOnly) option.id = `${option.id}@${valueStart}`;
    const def = parseDefault(hints.defaultRaw, option);
    option.default = def === undefined ? null : def;
    options.push(option);
    current.options.push(option);
  }
  return { sections: sections.filter((s) => s.options.length > 0), options };
}

/** Versión sin datos internos, para mandar a la interfaz. */
function publicOption(o) {
  const { _start, _end, ...rest } = o;
  return rest;
}

function describe(text) {
  const doc = parse(text);
  return {
    sections: doc.sections.map((s) => ({ title: s.title, path: s.path, help: s.help, readOnly: s.readOnly, options: s.options.map(publicOption) })),
    count: doc.options.length,
  };
}

/** Comprueba y normaliza el valor nuevo de una opción. Lanza Error si no vale. */
function validate(option, value) {
  const name = option.key;
  switch (option.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new Error(`"${name}" tiene que ser sí o no.`);
      return value;
    case 'int':
    case 'float': {
      const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
      if (String(value).trim() === '' || !Number.isFinite(n)) throw new Error(`"${name}" tiene que ser un número.`);
      if (option.type === 'int' && !Number.isInteger(n)) throw new Error(`"${name}" tiene que ser un número entero.`);
      if (option.range) {
        if (option.range.min !== undefined && n < option.range.min) throw new Error(`"${name}" no puede ser menor que ${option.range.min}.`);
        if (option.range.max !== undefined && n > option.range.max) throw new Error(`"${name}" no puede ser mayor que ${option.range.max}.`);
      }
      return n;
    }
    case 'enum':
      if (!option.choices.includes(value)) throw new Error(`"${name}" tiene que ser una de: ${option.choices.join(', ')}.`);
      return value;
    case 'string':
      if (typeof value !== 'string') throw new Error(`"${name}" tiene que ser un texto.`);
      return value;
    case 'list': {
      if (!Array.isArray(value)) throw new Error(`"${name}" tiene que ser una lista.`);
      if (option.itemType === 'int' || option.itemType === 'float') {
        return value.map((x) => {
          const n = Number(x);
          if (!Number.isFinite(n) || (option.itemType === 'int' && !Number.isInteger(n))) throw new Error(`"${name}": "${x}" no es un número válido.`);
          return n;
        });
      }
      if (option.itemType === 'bool') return value.map((x) => x === true || x === 'true');
      return value.map((x) => String(x));
    }
    case 'raw': {
      const s = String(value).trim();
      let parsed;
      try {
        parsed = readValue(s, 0);
      } catch (err) {
        throw new Error(`"${name}" no es un valor TOML válido: ${err.message}`);
      }
      if (skipBlank(s, parsed.end) !== s.length) throw new Error(`"${name}": sobra texto después del valor.`);
      return s;
    }
    default:
      throw new Error(`"${name}" no se puede editar.`);
  }
}

/**
 * Aplica cambios { id: valorNuevo } al texto y devuelve el texto nuevo.
 * Solo se reemplazan los valores; el resto del archivo queda igual.
 */
function applyChanges(text, changes) {
  const doc = parse(text);
  const byId = new Map(doc.options.map((o) => [o.id, o]));
  const edits = [];
  for (const [id, value] of Object.entries(changes || {})) {
    const option = byId.get(id);
    if (!option) throw new Error(`La opción "${id}" ya no está en el archivo; vuelve a cargarlo.`);
    if (option.readOnly) throw new Error(`"${option.key}" no se puede editar desde aquí.`);
    const clean = validate(option, value);
    const formatted = option.type === 'raw' ? clean : formatValue(clean, option);
    edits.push({ start: option._start, end: option._end, formatted });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.formatted + out.slice(e.end);
  return out;
}

module.exports = { parse, describe, applyChanges, validate, readValue, formatValue, TomlValueError };
