const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(prefix = 'msm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

module.exports = { tmpDir, writeFile };
