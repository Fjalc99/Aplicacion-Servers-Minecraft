const fs = require('fs');
const path = require('path');

/**
 * Descarga un fichero a disco, reportando progreso vía onProgress({ received, total }).
 */
async function downloadFile(url, destPath, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar ${url}: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fileStream = fs.createWriteStream(destPath);
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (onProgress) onProgress({ received, total });
      if (!fileStream.write(Buffer.from(value))) {
        await new Promise((resolve, reject) => {
          fileStream.once('drain', resolve);
          fileStream.once('error', reject);
        });
      }
    }
    await new Promise((resolve, reject) => {
      fileStream.once('error', reject);
      fileStream.end(resolve);
    });
  } catch (error) {
    fileStream.destroy();
    fs.rmSync(destPath, { force: true });
    throw error;
  }

  return destPath;
}

module.exports = { downloadFile };
