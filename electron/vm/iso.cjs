/**
 * Minimal ISO 9660 + Joliet writer.
 *
 * cloud-init's NoCloud datasource looks for a filesystem labelled CIDATA holding
 * lowercase `user-data` / `meta-data` files. Plain ISO 9660 uppercases names, so the
 * Joliet supplementary volume descriptor is what actually makes the seed readable.
 * Written by hand because shelling out to genisoimage/mkisofs is not an option on Windows.
 *
 * Layout (2048-byte sectors):
 *   0..15  system area (zeros)      19  L path table (primary)    23  root directory (primary)
 *   16     primary volume desc      20  M path table (primary)    24  root directory (Joliet)
 *   17     Joliet volume desc       21  L path table (Joliet)     25+ file data
 *   18     terminator               22  M path table (Joliet)
 */
const SECTOR = 2048;
const FIRST_FILE_LBA = 25;
const LBA = { pvd: 16, svd: 17, term: 18, lPath: 19, mPath: 20, lPathJoliet: 21, mPathJoliet: 22, root: 23, rootJoliet: 24 };

function both16(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(value, 0);
  buf.writeUInt16BE(value, 2);
  return buf;
}

function both32(value) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(value, 0);
  buf.writeUInt32BE(value, 4);
  return buf;
}

/** 17-byte "YYYYMMDDHHMMSSff" + GMT offset used by volume descriptors. */
function longDate(date) {
  const pad = (value, size) => String(value).padStart(size, "0");
  const text =
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2) +
    "00";
  const buf = Buffer.alloc(17);
  buf.write(text, 0, "ascii");
  buf[16] = 0;
  return buf;
}

/** 7-byte directory-record timestamp. */
function shortDate(date) {
  const buf = Buffer.alloc(7);
  buf[0] = date.getUTCFullYear() - 1900;
  buf[1] = date.getUTCMonth() + 1;
  buf[2] = date.getUTCDate();
  buf[3] = date.getUTCHours();
  buf[4] = date.getUTCMinutes();
  buf[5] = date.getUTCSeconds();
  buf[6] = 0;
  return buf;
}

/** ISO 9660 level-2 style name: uppercase, one dot, ";1" version suffix. */
function isoName(name) {
  const clean = String(name).toUpperCase().replace(/[^A-Z0-9_.]/g, "_");
  const lastDot = clean.lastIndexOf(".");
  const stem = (lastDot > 0 ? clean.slice(0, lastDot) : clean).replace(/\./g, "_").slice(0, 30) || "FILE";
  const ext = (lastDot > 0 ? clean.slice(lastDot + 1) : "").replace(/\./g, "_").slice(0, 3);
  return `${stem}.${ext};1`;
}

function jolietBytes(text) {
  return Buffer.from(String(text), "utf16le").swap16();
}

function writeField(buf, offset, length, text, { ucs2 = false } = {}) {
  const value = ucs2 ? jolietBytes(text) : Buffer.from(String(text), "ascii");
  const padByte = ucs2 ? Buffer.from([0x00, 0x20]) : Buffer.from([0x20]);
  const field = Buffer.alloc(length);
  for (let i = 0; i < length; i += padByte.length) padByte.copy(field, i);
  value.copy(field, 0, 0, Math.min(value.length, length));
  field.copy(buf, offset);
}

function dirRecord({ nameBuf, lba, size, isDir, date }) {
  let length = 33 + nameBuf.length;
  if (length % 2) length += 1;
  const buf = Buffer.alloc(length);
  buf[0] = length;
  buf[1] = 0;
  both32(lba).copy(buf, 2);
  both32(size).copy(buf, 10);
  shortDate(date).copy(buf, 18);
  buf[25] = isDir ? 0x02 : 0x00;
  buf[26] = 0;
  buf[27] = 0;
  both16(1).copy(buf, 28);
  buf[32] = nameBuf.length;
  nameBuf.copy(buf, 33);
  return buf;
}

function pathTable(rootLba, bigEndian) {
  const buf = Buffer.alloc(10);
  buf[0] = 1;
  buf[1] = 0;
  if (bigEndian) buf.writeUInt32BE(rootLba, 2);
  else buf.writeUInt32LE(rootLba, 2);
  if (bigEndian) buf.writeUInt16BE(1, 6);
  else buf.writeUInt16LE(1, 6);
  buf[8] = 0;
  buf[9] = 0;
  return buf;
}

function volumeDescriptor({ type, label, totalSectors, lPathLba, mPathLba, rootRecord, date, joliet }) {
  const buf = Buffer.alloc(SECTOR);
  buf[0] = type;
  buf.write("CD001", 1, "ascii");
  buf[6] = 1;
  buf[7] = 0;
  writeField(buf, 8, 32, "", { ucs2: joliet });
  writeField(buf, 40, 32, label, { ucs2: joliet });
  both32(totalSectors).copy(buf, 80);
  if (joliet) {
    // UCS-2 level 3 escape sequence "%/E"
    Buffer.from([0x25, 0x2f, 0x45]).copy(buf, 88);
  }
  both16(1).copy(buf, 120);
  both16(1).copy(buf, 124);
  both16(SECTOR).copy(buf, 128);
  both32(10).copy(buf, 132);
  buf.writeUInt32LE(lPathLba, 140);
  buf.writeUInt32LE(0, 144);
  buf.writeUInt32BE(mPathLba, 148);
  buf.writeUInt32BE(0, 152);
  rootRecord.copy(buf, 156);
  for (const [offset, length] of [[190, 128], [318, 128], [446, 128], [574, 128]]) {
    writeField(buf, offset, length, "", { ucs2: joliet });
  }
  for (const [offset, length] of [[702, 37], [739, 37], [776, 37]]) {
    writeField(buf, offset, length, "", { ucs2: joliet });
  }
  const stamp = longDate(date);
  stamp.copy(buf, 813);
  stamp.copy(buf, 830);
  // Expiration and effective dates are "unspecified": sixteen '0' digits + zero offset.
  const unspecified = Buffer.alloc(17, 0x30);
  unspecified[16] = 0;
  unspecified.copy(buf, 847);
  unspecified.copy(buf, 864);
  buf[881] = 1;
  return buf;
}

function sectorsFor(size) {
  return Math.max(1, Math.ceil(size / SECTOR));
}

/**
 * @param {Array<{name: string, data: Buffer|string}>} inputs
 * @returns {Buffer} raw ISO image
 */
function buildIso(inputs, { label = "CIDATA", date = new Date() } = {}) {
  const files = (inputs || []).map((file) => ({
    name: String(file.name),
    data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ""), "utf8"),
  }));
  if (!files.length) throw new Error("buildIso requires at least one file");

  let lba = FIRST_FILE_LBA;
  for (const file of files) {
    file.lba = lba;
    lba += sectorsFor(file.data.length);
  }
  const totalSectors = lba;

  const buildRootDir = (joliet) => {
    const records = [
      dirRecord({ nameBuf: Buffer.from([0]), lba: joliet ? LBA.rootJoliet : LBA.root, size: SECTOR, isDir: true, date }),
      dirRecord({ nameBuf: Buffer.from([1]), lba: joliet ? LBA.rootJoliet : LBA.root, size: SECTOR, isDir: true, date }),
    ];
    for (const file of files) {
      const nameBuf = joliet ? jolietBytes(file.name) : Buffer.from(isoName(file.name), "ascii");
      records.push(dirRecord({ nameBuf, lba: file.lba, size: file.data.length, isDir: false, date }));
    }
    const total = records.reduce((sum, record) => sum + record.length, 0);
    if (total > SECTOR) throw new Error("buildIso: too many/too long file names for a single-sector directory");
    return Buffer.concat([...records, Buffer.alloc(SECTOR - total)]);
  };

  const rootRecordFor = (joliet) =>
    dirRecord({
      nameBuf: Buffer.from([0]),
      lba: joliet ? LBA.rootJoliet : LBA.root,
      size: SECTOR,
      isDir: true,
      date,
    });

  const image = Buffer.alloc(totalSectors * SECTOR);
  const put = (sector, buf) => buf.copy(image, sector * SECTOR);

  put(
    LBA.pvd,
    volumeDescriptor({
      type: 1,
      label,
      totalSectors,
      lPathLba: LBA.lPath,
      mPathLba: LBA.mPath,
      rootRecord: rootRecordFor(false),
      date,
      joliet: false,
    })
  );
  put(
    LBA.svd,
    volumeDescriptor({
      type: 2,
      label,
      totalSectors,
      lPathLba: LBA.lPathJoliet,
      mPathLba: LBA.mPathJoliet,
      rootRecord: rootRecordFor(true),
      date,
      joliet: true,
    })
  );
  const terminator = Buffer.alloc(SECTOR);
  terminator[0] = 0xff;
  terminator.write("CD001", 1, "ascii");
  terminator[6] = 1;
  put(LBA.term, terminator);

  put(LBA.lPath, pathTable(LBA.root, false));
  put(LBA.mPath, pathTable(LBA.root, true));
  put(LBA.lPathJoliet, pathTable(LBA.rootJoliet, false));
  put(LBA.mPathJoliet, pathTable(LBA.rootJoliet, true));
  put(LBA.root, buildRootDir(false));
  put(LBA.rootJoliet, buildRootDir(true));
  for (const file of files) put(file.lba, file.data);

  return image;
}

module.exports = { buildIso, isoName, SECTOR, LBA };
