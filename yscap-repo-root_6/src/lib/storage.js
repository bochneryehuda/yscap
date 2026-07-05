/**
 * Document storage interface. Default 'local' writes to STORAGE_DIR so the
 * portal runs out-of-the-box; swap STORAGE_PROVIDER=s3|sharepoint later
 * without touching callers. save() takes a Buffer, returns {ref, provider}.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

const local = {
  name: 'local',
  async save(buf, { filename }) {
    const dir = path.join(__dirname, '..', '..', cfg.storageDir);
    fs.mkdirSync(dir, { recursive: true });
    const ref = `${crypto.randomBytes(8).toString('hex')}-${(filename || 'file').replace(/[^\w.-]/g, '_')}`;
    fs.writeFileSync(path.join(dir, ref), buf);
    return { ref, provider: 'local' };
  },
  async read(ref) {
    return fs.readFileSync(path.join(__dirname, '..', '..', cfg.storageDir, ref));
  },
};

// Stubs — implement when you wire the provider; interface is identical.
const s3 = {
  name: 's3',
  async save() { throw new Error('S3 storage not configured'); },
  async read() { throw new Error('S3 storage not configured'); },
};
const sharepoint = {
  name: 'sharepoint',
  async save() { throw new Error('SharePoint storage not configured'); },
  async read() { throw new Error('SharePoint storage not configured'); },
};

module.exports = ({ local, s3, sharepoint }[cfg.storageProvider] || local);
