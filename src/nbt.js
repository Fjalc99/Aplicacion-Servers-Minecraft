/**
 * Lector/escritor de NBT (el formato de level.dat, playerdata/*.dat...).
 * Sin dependencias. Conserva los tipos exactos para poder leer, tocar una cosa
 * y volver a escribir el archivo sin alterar nada más.
 *
 * Cada valor es { type, value }:
 *   1 byte, 2 short, 3 int, 5 float, 6 double -> number
 *   4 long -> BigInt
 *   7 byte[] -> Buffer (con signo al leer: Int8Array)
 *   8 string -> string (UTF-8 "modificado" de Java)
 *   9 list -> { elementType, items: [valores sin nombre {type, value}] }
 *  10 compound -> Map(nombre -> {type, value})
 *  11 int[] -> Int32Array, 12 long[] -> BigInt64Array
 */
const zlib = require('zlib');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

// ---------- UTF-8 modificado (Java) ----------
function decodeMutf8(buf) {
  let out = '';
  for (let i = 0; i < buf.length; ) {
    const a = buf[i];
    if (a < 0x80) {
      out += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0) {
      out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i + 1] & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(((a & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f));
      i += 3;
    }
  }
  return out;
}

function encodeMutf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i); // unidades UTF-16, como Java
    if (c >= 0x0001 && c <= 0x007f) bytes.push(c);
    else if (c <= 0x07ff) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(bytes);
}

// ---------- Lectura ----------
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('El archivo NBT está cortado o dañado.');
  }
  u8() { this.need(1); return this.buf.readUInt8(this.pos++); }
  i8() { this.need(1); return this.buf.readInt8(this.pos++); }
  i16() { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str() { const len = this.u16(); this.need(len); const s = decodeMutf8(this.buf.subarray(this.pos, this.pos + len)); this.pos += len; return s; }

  payload(type) {
    switch (type) {
      case T.BYTE: return this.i8();
      case T.SHORT: return this.i16();
      case T.INT: return this.i32();
      case T.LONG: return this.i64();
      case T.FLOAT: return this.f32();
      case T.DOUBLE: return this.f64();
      case T.BYTE_ARRAY: {
        const len = this.i32(); this.need(len);
        const v = Buffer.from(this.buf.subarray(this.pos, this.pos + len)); this.pos += len; return v;
      }
      case T.STRING: return this.str();
      case T.LIST: {
        const elementType = this.u8();
        const len = this.i32();
        const items = [];
        for (let i = 0; i < len; i++) items.push({ type: elementType, value: this.payload(elementType) });
        return { elementType, items };
      }
      case T.COMPOUND: {
        const map = new Map();
        for (;;) {
          const t = this.u8();
          if (t === T.END) break;
          const name = this.str();
          map.set(name, { type: t, value: this.payload(t) });
        }
        return map;
      }
      case T.INT_ARRAY: {
        const len = this.i32(); const arr = new Int32Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i32(); return arr;
      }
      case T.LONG_ARRAY: {
        const len = this.i32(); const arr = new BigInt64Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i64(); return arr;
      }
      default:
        throw new Error(`Tipo de NBT desconocido (${type}).`);
    }
  }
}

/** Lee un NBT sin comprimir. Devuelve { name, root: {type:10, value: Map} }. */
function parse(buf) {
  const r = new Reader(buf);
  const type = r.u8();
  if (type !== T.COMPOUND) throw new Error('El archivo no es un NBT válido.');
  const name = r.str();
  return { name, root: { type, value: r.payload(type) } };
}

// ---------- Escritura ----------
class Writer {
  constructor() { this.parts = []; }
  push(buf) { this.parts.push(buf); }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this.push(b); }
  i8(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.push(b); }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.push(b); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); this.push(b); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.push(b); }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.push(b); }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.push(b); }
  f64(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.push(b); }
  str(s) { const b = encodeMutf8(s); this.u16(b.length); this.push(b); }

  payload(type, value) {
    switch (type) {
      case T.BYTE: return this.i8(value);
      case T.SHORT: return this.i16(value);
      case T.INT: return this.i32(value);
      case T.LONG: return this.i64(value);
      case T.FLOAT: return this.f32(value);
      case T.DOUBLE: return this.f64(value);
      case T.BYTE_ARRAY: this.i32(value.length); return this.push(Buffer.from(value));
      case T.STRING: return this.str(value);
      case T.LIST: {
        const elementType = value.items.length ? value.items[0].type : value.elementType;
        this.u8(elementType);
        this.i32(value.items.length);
        for (const item of value.items) this.payload(elementType, item.value);
        return undefined;
      }
      case T.COMPOUND:
        for (const [name, tag] of value) {
          this.u8(tag.type);
          this.str(name);
          this.payload(tag.type, tag.value);
        }
        return this.u8(T.END);
      case T.INT_ARRAY: this.i32(value.length); for (const v of value) this.i32(v); return undefined;
      case T.LONG_ARRAY: this.i32(value.length); for (const v of value) this.i64(v); return undefined;
      default:
        throw new Error(`Tipo de NBT desconocido (${type}).`);
    }
  }
}

function serialize({ name = '', root }) {
  const w = new Writer();
  w.u8(T.COMPOUND);
  w.str(name);
  w.payload(T.COMPOUND, root.value);
  return Buffer.concat(w.parts);
}

/** Lee un archivo .dat (normalmente gzip; acepta también sin comprimir). */
function readFile(fs, file) {
  const raw = fs.readFileSync(file);
  const data = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  return parse(data);
}

/** Escribe un .dat comprimido con gzip, primero a un temporal para no dejarlo a medias. */
function writeFile(fs, file, doc) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(serialize(doc)));
  fs.renameSync(tmp, file);
}

module.exports = { T, parse, serialize, readFile, writeFile, encodeMutf8, decodeMutf8 };
