const { parentPort, workerData } = require("worker_threads");
const booksStore = require("./booksStore.cjs");

(async () => {
  try {
    const book = await booksStore.importBook(workerData.userDataPath, workerData.filePath);
    parentPort.postMessage({ ok: true, book });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error?.message || error) });
  }
})();
