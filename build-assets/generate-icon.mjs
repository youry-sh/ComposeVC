/**
 * ComposeVC app icon from dist/logo/icooffgf.jpg.
 * macOS-style rounded corners, multi-size PNG-embedded .ico, and PNG for the window.
 * Usage: node build-assets/generate-icon.mjs
 */
import { createRequire } from "module";
import { writeFile, mkdir, access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcJpg = path.join(root, "dist", "logo", "icooffgf.jpg");
const publicLogo = path.join(root, "public", "logo");
const distLogo = path.join(root, "dist", "logo");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

function makeIco(pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);

  const entries = [];
  let offset = 6 + pngBuffers.length * 16;
  const body = [];

  for (const buf of pngBuffers) {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const e = Buffer.alloc(16);
    e[0] = w >= 256 ? 0 : w;
    e[1] = h >= 256 ? 0 : h;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    body.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...body]);
}

function resolveSharp() {
  const require = createRequire(import.meta.url);
  try {
    return require(path.join(root, "node_modules", "sharp"));
  } catch {
    return require("sharp");
  }
}

function macMask(size) {
  const radius = Math.round(size * 0.2237);
  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${radius}" ry="${radius}" fill="#fff"/>
    </svg>`
  );
}

async function main() {
  const sharp = resolveSharp();
  await access(srcJpg);
  await mkdir(publicLogo, { recursive: true });
  await mkdir(distLogo, { recursive: true });

  const makeIconPng = async (size) => {
    const squared = await sharp(srcJpg)
      .resize(size, size, { fit: "cover", position: "centre" })
      .ensureAlpha()
      .png()
      .toBuffer();
    return sharp(squared)
      .composite([{ input: macMask(size), blend: "dest-in" }])
      .png()
      .toBuffer();
  };

  const pngs = {};
  for (const s of sizes) pngs[s] = await makeIconPng(s);

  await writeFile(path.join(publicLogo, "app-icon.png"), pngs[256]);
  await writeFile(path.join(publicLogo, "app-icon-512.png"), pngs[512]);
  await writeFile(path.join(distLogo, "app-icon.png"), pngs[256]);
  await writeFile(path.join(distLogo, "app-icon-512.png"), pngs[512]);

  const ico = makeIco([16, 24, 32, 48, 64, 128, 256].map((s) => pngs[s]));
  await writeFile(path.join(publicLogo, "app-icon.ico"), ico);
  await writeFile(path.join(distLogo, "app-icon.ico"), ico);
  await writeFile(path.join(__dirname, "app-icon.png"), pngs[512]);
  await writeFile(path.join(__dirname, "app-icon.ico"), ico);
  await writeFile(path.join(__dirname, "icon.ico"), ico);

  console.log("Generated mac-rounded app icon from dist/logo/icooffgf.jpg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
