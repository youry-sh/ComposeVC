const { desktopCapturer, screen, clipboard, nativeImage } = require("electron");
const sharp = require("sharp");

/**
 * Capture the ENTIRE virtual desktop (all displays side-by-side) and put it on
 * the clipboard as a single PNG, with a "ComposeVC" watermark at the bottom.
 *
 * desktopCapturer returns one native thumbnail per monitor, so we composite
 * them onto one canvas with sharp using each display's DIP coordinates and the
 * primary display's scale factor. Each thumbnail is cropped to its workArea so
 * the OS taskbar (bottom/any side) is excluded from the final image. The
 * watermark is rendered from an inline SVG (text glyph) and composited last so
 * it always sits above the screens.
 */

const WATERMARK_TEXT = "ComposeVC";
const WATERMARK_HEIGHT = 56;
const WATERMARK_FONT_SIZE = 22;
const WATERMARK_PADDING_RIGHT = 24;
const WATERMARK_PADDING_BOTTOM = 16;

async function renderWatermark(canvasW, canvasH) {
  const top = Math.max(0, canvasH - WATERMARK_HEIGHT);
  const svg =
    `<svg width="${canvasW}" height="${WATERMARK_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${canvasW - WATERMARK_PADDING_RIGHT}" y="${WATERMARK_HEIGHT - WATERMARK_PADDING_BOTTOM}" text-anchor="end" ` +
    `font-family="sans-serif" font-size="${WATERMARK_FONT_SIZE}" font-weight="600" fill="rgba(0,0,0,0.45)">${WATERMARK_TEXT}</text>` +
    `<text x="${canvasW - WATERMARK_PADDING_RIGHT - 1}" y="${WATERMARK_HEIGHT - WATERMARK_PADDING_BOTTOM - 1}" text-anchor="end" ` +
    `font-family="sans-serif" font-size="${WATERMARK_FONT_SIZE}" font-weight="600" fill="rgba(255,255,255,0.62)">${WATERMARK_TEXT}</text>` +
    `</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { input: buffer, left: 0, top };
}

async function captureFullDesktop() {
  const displays = screen.getAllDisplays();
  if (!displays || displays.length === 0) {
    return { ok: false, error: "no-displays" };
  }

  const primary = screen.getPrimaryDisplay();
  const scale = Math.max(1, Number(primary.scaleFactor) || 1);

  // Capture at full monitor resolution (thumbnailSize uses the full bounds),
  // then crop each thumbnail to its workArea so the OS taskbar (bottom/any
  // side) is excluded from the final image.
  const boundsMinX = Math.min(...displays.map((d) => d.bounds.x));
  const boundsMinY = Math.min(...displays.map((d) => d.bounds.y));
  const boundsMaxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const boundsMaxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const boundsW = Math.max(1, Math.round((boundsMaxX - boundsMinX) * scale));
  const boundsH = Math.max(1, Math.round((boundsMaxY - boundsMinY) * scale));

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: boundsW, height: boundsH },
  });

  const waMinX = Math.min(...displays.map((d) => d.workArea.x));
  const waMinY = Math.min(...displays.map((d) => d.workArea.y));
  const waMaxX = Math.max(...displays.map((d) => d.workArea.x + d.workArea.width));
  const waMaxY = Math.max(...displays.map((d) => d.workArea.y + d.workArea.height));
  const totalW = Math.max(1, Math.round((waMaxX - waMinX) * scale));
  const totalH = Math.max(1, Math.round((waMaxY - waMinY) * scale));

  const parts = [];
  let captured = 0;
  for (const d of displays) {
    const source = sources.find((s) => String(s.display_id) === String(d.id));
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) continue;
    const tw = source.thumbnail.getSize().width;
    const th = source.thumbnail.getSize().height;
    const cropLeft = Math.max(0, Math.round((d.workArea.x - d.bounds.x) * scale));
    const cropTop = Math.max(0, Math.round((d.workArea.y - d.bounds.y) * scale));
    const cropW = Math.max(1, Math.min(tw - cropLeft, Math.round(d.workArea.width * scale)));
    const cropH = Math.max(1, Math.min(th - cropTop, Math.round(d.workArea.height * scale)));
    const cropped = await sharp(source.thumbnail.toPNG())
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .png()
      .toBuffer();
    const left = Math.round((d.workArea.x - waMinX) * scale);
    const top = Math.round((d.workArea.y - waMinY) * scale);
    parts.push({ input: cropped, left, top });
    captured += 1;
  }

  if (captured === 0) {
    return { ok: false, error: "no-screen-sources" };
  }

  // Watermark is best-effort: the screenshot must still work if font rendering
  // is unavailable on some platform.
  let watermark = false;
  try {
    parts.push(await renderWatermark(totalW, totalH));
    watermark = true;
  } catch (err) {
    console.warn("[screenshot] watermark render failed:", err && err.message);
  }

  const out = await sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(parts)
    .png()
    .toBuffer();

  const image = nativeImage.createFromBuffer(out);
  if (!image || image.isEmpty()) {
    return { ok: false, error: "empty-capture" };
  }
  clipboard.writeImage(image);

  return {
    ok: true,
    width: totalW,
    height: totalH,
    displays: captured,
    watermark,
  };
}

module.exports = { captureFullDesktop };
