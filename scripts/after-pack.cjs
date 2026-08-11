/**
 * electron-builder afterPack — flip Electron fuses for harder reverse-engineering.
 * Disables: ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect, plain app folder load.
 */
const path = require("path");
const fs = require("fs");

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

  const platform = context.electronPlatformName || context.packager?.platform?.name;
  const productName =
    context.packager?.appInfo?.productFilename ||
    context.packager?.appInfo?.productName ||
    "ComposeVC";

  let electronBinary;
  if (platform === "win32" || platform === "windows") {
    electronBinary = path.join(context.appOutDir, `${productName}.exe`);
  } else if (platform === "darwin" || platform === "mac") {
    electronBinary = path.join(
      context.appOutDir,
      `${productName}.app`,
      "Contents",
      "MacOS",
      productName
    );
  } else {
    electronBinary = path.join(context.appOutDir, productName);
  }

  if (!fs.existsSync(electronBinary)) {
    // Fallback: first .exe in appOutDir
    const candidates = fs
      .readdirSync(context.appOutDir)
      .filter((n) => n.toLowerCase().endsWith(".exe"))
      .map((n) => path.join(context.appOutDir, n));
    if (candidates.length) electronBinary = candidates[0];
  }

  if (!fs.existsSync(electronBinary)) {
    console.warn(`[after-pack] electron binary not found under ${context.appOutDir} — skip fuses`);
    return;
  }

  console.log(`[after-pack] flipping fuses on ${electronBinary}`);

  try {
    await flipFuses(electronBinary, {
      version: FuseVersion.V1,
      // MUST stay enabled: the proxy gateway runs as a managed child spawned
      // with ELECTRON_RUN_AS_NODE=1 (electron/proxy/processManager.cjs). With
      // this fuse OFF the packaged exe cannot start its own proxy, so every API
      // request to 127.0.0.1:8787 fails. Reliability of the bundled proxy wins
      // over the marginal anti-tamper value of blocking RunAsNode.
      [FuseV1Options.RunAsNode]: true,
      // Encrypt cookies at rest (extra OS-level friction)
      [FuseV1Options.EnableCookieEncryption]: true,
      // Block NODE_OPTIONS injection
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Block --inspect / --inspect-brk on the binary
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Refuse to load unpacked app/ folder next to asar (must use app.asar)
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // Validate asar hash embedded in binary (tamper → refuse to start)
      // If this breaks a specific Electron/builder combo, package-dist can set
      // LOPSTER_SKIP_ASAR_INTEGRITY=1 (handled below).
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
        process.env.LOPSTER_SKIP_ASAR_INTEGRITY === "1" ? false : true,
    });
    console.log("[after-pack] fuses OK");
  } catch (err) {
    console.warn(
      "[after-pack] fuse flip failed (continuing without fatal):",
      err?.message || err
    );
  }
};
