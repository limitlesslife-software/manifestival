// Pieni ZIP-lukija APK:n tarkastusta varten (ja kirjoittaja testeille).
//
// MIKSI OMA TOTEUTUS
//
// APK on ZIP. Tarkastus tarvitsee vain assettien tavut: assets/public/**,
// capacitor.config.json ja capacitor.plugins.json. Ulkoinen `unzip`
// löytyy Git Bashista mutta ei välttämättä muualta, ja jokainen
// ulkoinen prosessi on lisää alustariippuvuutta. Node osaa purkaa
// deflate-datan itse (zlib.inflateRawSync), joten lukija on
// muutama kymmenen riviä ja toimii samoin kaikkialla.
//
// Keskushakemisto luetaan EOCD-tietueesta. APK:n allekirjoituslohko
// (v2/v3) on viimeisen tiedoston ja keskushakemiston välissä; siihen ei
// kosketa, koska tiedostojen sijainnit tulevat keskushakemistosta.
// ZIP64:ää ja salausta ei tueta — APK ei käytä kumpaakaan.

import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

let crcTable = null;
function crc32Fallback(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 (zlib.crc32 kun saatavilla, muuten taulukkototeutus). */
export function crc32(buffer) {
  return typeof zlib.crc32 === 'function' ? zlib.crc32(buffer) >>> 0 : crc32Fallback(buffer);
}

function findEocd(buffer) {
  const minimum = 22;
  const stop = Math.max(0, buffer.length - minimum - 0xffff);
  for (let i = buffer.length - minimum; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('ZIP: End of Central Directory -tietuetta ei löytynyt (ei ZIP/APK?)');
}

/**
 * ZIP-arkiston tiedostot.
 *
 * @param {Buffer} buffer koko arkisto
 * @returns {Map<string, { method: number, size: number, compressedSize: number,
 *   crc: number, read: () => Buffer }>} nimi -> tietue; `read()` purkaa ja
 *   tarkistaa CRC:n
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readZip: Buffer puuttuu');
  const eocd = findEocd(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 ei ole tuettu');
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP: keskushakemiston tietue ${i} on rikki (offset ${p})`);
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`ZIP: salattu tiedosto ei ole tuettu: ${name}`);
    if (entries.has(name)) throw new Error(`ZIP: sama nimi kahdesti: ${name}`);

    const read = () => {
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new Error(`ZIP: paikallinen otsake rikki: ${name}`);
      }
      const localName = buffer.readUInt16LE(localOffset + 26);
      const localExtra = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const raw = buffer.subarray(start, start + compressedSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`ZIP: pakkausmenetelmä ${method} ei ole tuettu: ${name}`);
      if (data.length !== size) throw new Error(`ZIP: koko ei täsmää: ${name}`);
      if (crc32(data) !== crc) throw new Error(`ZIP: CRC ei täsmää: ${name}`);
      return data;
    };
    entries.set(name, Object.freeze({ method, size, compressedSize, crc, read }));
  }
  return entries;
}

/**
 * Pieni ZIP-kirjoittaja TESTEJÄ varten: [{ name, data, method? }] -> Buffer.
 * method 0 = stored, 8 = deflate (oletus).
 */
export function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const method = file.method === 0 ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
