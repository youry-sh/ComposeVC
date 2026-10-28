const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { ensureDir } = require("./paths.cjs");

/**
 * Small, cancellable downloader for official installers.
 *
 * electron/vm/images.cjs.pull() is intentionally not reused: it always writes
 * into <userData>/vm/images and reports progress through its own job map, while
 * Setup must keep its installers under <userData>/setup/downloads and stream a
 * percentage to the renderer. vm/** is also not to be edited, so the minimal
 * download logic lives here.
 *
 * Never pipes a remote script into a shell: the file is fully written, then the
 * caller decides how to execute it.
 */

const MAX_REDIRECTS = 6;

function downloadFile(url, destDir, fileName, { onProgress, signal, timeoutMs = 30 * 60_000, sha512, size } = {}) {
  ensureDir(destDir);
  const dest = path.join(destDir, fileName);
  const part = `${dest}.part`;
  try {
    fs.rmSync(part, { force: true });
  } catch {
    /* stale partial file */
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest = null;
    let abortListener = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (abortListener && signal) {
        try {
          signal.removeEventListener("abort", abortListener);
        } catch {
          /* ignore */
        }
      }
      fn(value);
    };

    const fail = (error) => {
      try {
        activeRequest?.destroy();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(part, { force: true });
      } catch {
        /* ignore */
      }
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    };

    const request = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        fail(new Error(`Некорректный адрес загрузки: ${target}`));
        return;
      }
      const client = parsed.protocol === "http:" ? http : https;
      const req = client.get(
        parsed,
        {
          headers: {
            "user-agent": "ComposeVC-Setup/1.0",
            accept: "*/*",
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              fail(new Error("Слишком много перенаправлений при загрузке"));
              return;
            }
            const next = new URL(res.headers.location, parsed).toString();
            request(next, redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            fail(new Error(`HTTP ${status} для ${target}`));
            return;
          }

          const total = Number(res.headers["content-length"]) || 0;
          const hash = sha512 ? crypto.createHash("sha512") : null;
          const out = fs.createWriteStream(part);
          let received = 0;

          res.on("data", (chunk) => {
            received += chunk.length;
            if (hash) hash.update(chunk);
            if (onProgress) {
              const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
              try {
                onProgress({ received, total, percent });
              } catch {
                /* renderer/log callback must never break the download */
              }
            }
          });

          out.on("error", fail);
          res.on("error", fail);
          res.on("aborted", () => fail(new Error("Загрузка прервана")));

          res.pipe(out);
          out.on("finish", () => {
            out.close(() => {
              try {
                if (size && received !== size) {
                  throw new Error(`Размер файла не совпал: ${received} вместо ${size}`);
                }
                if (sha512 && hash) {
                  const actual = hash.digest("hex").toLowerCase();
                  if (actual !== String(sha512).toLowerCase()) {
                    throw new Error("sha512 не совпал — файл повреждён");
                  }
                }
                fs.renameSync(part, dest);
                finish(resolve, { path: dest, size: received, verified: Boolean(sha512) });
              } catch (error) {
                fail(error);
              }
            });
          });
        }
      );
      activeRequest = req;
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("Таймаут загрузки"));
      });
      req.on("error", fail);
    };

    if (signal) {
      if (signal.aborted) {
        reject(new Error("Загрузка отменена"));
        return;
      }
      abortListener = () => fail(new Error("Загрузка отменена"));
      signal.addEventListener("abort", abortListener, { once: true });
    }

    request(url, MAX_REDIRECTS);
  });
}

module.exports = { downloadFile };
