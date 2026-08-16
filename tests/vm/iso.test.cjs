const assert = require("assert");
const { buildIso, isoName, SECTOR } = require("../../electron/vm/iso.cjs");

function readDescriptor(image, sector) {
  const buf = image.subarray(sector * SECTOR, (sector + 1) * SECTOR);
  return {
    type: buf[0],
    magic: buf.toString("ascii", 1, 6),
    rootRecord: buf.subarray(156, 190),
    escape: buf.toString("hex", 88, 91),
    labelAscii: buf.toString("ascii", 40, 72).trim(),
    labelUcs2: Buffer.from(buf.subarray(40, 72)).swap16().toString("utf16le").replace(/\0/g, "").trim(),
  };
}

/** Walk a directory extent and return {name, lba, size} for every non-special record. */
function readDir(image, lba, { joliet }) {
  const dir = image.subarray(lba * SECTOR, (lba + 1) * SECTOR);
  const entries = [];
  let offset = 0;
  while (offset < dir.length) {
    const length = dir[offset];
    if (!length) break;
    const nameLength = dir[offset + 32];
    const nameBuf = dir.subarray(offset + 33, offset + 33 + nameLength);
    const isSpecial = nameLength === 1 && (nameBuf[0] === 0 || nameBuf[0] === 1);
    if (!isSpecial) {
      entries.push({
        name: joliet ? Buffer.from(nameBuf).swap16().toString("utf16le") : nameBuf.toString("ascii"),
        lba: dir.readUInt32LE(offset + 2),
        size: dir.readUInt32LE(offset + 10),
        flags: dir[offset + 25],
      });
    }
    offset += length;
  }
  return entries;
}

const userData = "#cloud-config\nhostname: probe\n";
const metaData = "instance-id: probe/1\nlocal-hostname: probe\n";
const big = Buffer.alloc(SECTOR * 3 + 7, 0x41); // spans several sectors

const image = buildIso(
  [
    { name: "user-data", data: userData },
    { name: "meta-data", data: metaData },
    { name: "network-config", data: big },
  ],
  { label: "CIDATA", date: new Date("2026-01-02T03:04:05Z") }
);

assert.equal(image.length % SECTOR, 0, "image is sector aligned");
assert.ok(image.subarray(0, 16 * SECTOR).every((byte) => byte === 0), "system area is zeroed");

const pvd = readDescriptor(image, 16);
assert.equal(pvd.type, 1);
assert.equal(pvd.magic, "CD001");
assert.equal(pvd.labelAscii, "CIDATA", "primary volume label is CIDATA");

const svd = readDescriptor(image, 17);
assert.equal(svd.type, 2);
assert.equal(svd.magic, "CD001");
assert.equal(svd.escape, "252f45", "Joliet UCS-2 level 3 escape sequence");
assert.equal(svd.labelUcs2, "CIDATA", "Joliet volume label is CIDATA");

const term = readDescriptor(image, 18);
assert.equal(term.type, 0xff);
assert.equal(term.magic, "CD001");

const pvdRootLba = pvd.rootRecord.readUInt32LE(2);
const svdRootLba = svd.rootRecord.readUInt32LE(2);
assert.notEqual(pvdRootLba, svdRootLba, "primary and Joliet roots are separate extents");

const jolietEntries = readDir(image, svdRootLba, { joliet: true });
assert.deepEqual(
  jolietEntries.map((entry) => entry.name).sort(),
  ["meta-data", "network-config", "user-data"],
  "cloud-init sees the exact lowercase names through Joliet"
);

const isoEntries = readDir(image, pvdRootLba, { joliet: false });
assert.deepEqual(isoEntries.map((entry) => entry.name).sort(), ["META_DATA.;1", "NETWORK_CONFIG.;1", "USER_DATA.;1"]);
assert.equal(isoName("user-data"), "USER_DATA.;1");
assert.equal(isoName("autounattend.xml"), "AUTOUNATTEND.XML;1");

const readFile = (name) => {
  const entry = jolietEntries.find((item) => item.name === name);
  return image.subarray(entry.lba * SECTOR, entry.lba * SECTOR + entry.size);
};
assert.equal(readFile("user-data").toString("utf8"), userData, "user-data round-trips byte for byte");
assert.equal(readFile("meta-data").toString("utf8"), metaData);
assert.ok(readFile("network-config").equals(big), "multi-sector payload round-trips");

// Both directory trees must point at the same file extents.
for (const entry of jolietEntries) {
  const twin = isoEntries.find((item) => item.size === entry.size);
  assert.equal(twin.lba, entry.lba, "Joliet and ISO records share one extent");
}

const declaredSectors = image.readUInt32LE(16 * SECTOR + 80);
assert.equal(declaredSectors, image.length / SECTOR, "volume space size matches the image");

console.log("vm/iso: ok");
