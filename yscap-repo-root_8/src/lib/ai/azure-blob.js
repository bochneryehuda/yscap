'use strict';
/**
 * Azure Blob storage — thin PUT client for the labeling console (R3.3).
 *
 * The Doc Intelligence Custom classifier + neural extractors READ their training
 * examples from a Blob container the owner created 2026-07-22:
 *   Account:   pilotdocailabels (East US)
 *   Container: pilot-doc-ai-labels
 *
 * Auth options (config already added):
 *   1. AZURE_DOCAI_LABEL_SAS_TOKEN — a SAS token scoped to the container
 *      (preferred, least privilege). The whole "?sv=...&sig=..." string.
 *   2. AZURE_DOCAI_LABEL_ACCOUNT_KEY — the storage account key (works too;
 *      broader access). We sign a per-PUT header with it.
 *
 * When neither is set the helper stays DORMANT — the labeling routes will
 * refuse uploads with a clear "add the SAS in Render" message.
 *
 * Zero SDK deps — plain fetch with Node's built-in crypto.
 */

const cfg = require('../../config');
const crypto = require('crypto');

const API_VERSION = '2024-11-04';

function configured() {
  return !!(cfg.azureCustom && cfg.azureCustom.labelStorageAccount && cfg.azureCustom.labelContainer && (cfg.azureCustom.labelStorageSasToken || cfg.azureCustom.labelStorageAccountKey));
}

function baseUrl() {
  return `https://${cfg.azureCustom.labelStorageAccount}.blob.core.windows.net/${cfg.azureCustom.labelContainer}`;
}

function blobUrl(objectKey) {
  return `${baseUrl()}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * PUT a blob. Returns the durable blob URL (no SAS attached).
 * @param {{objectKey:string, buffer:Buffer, contentType?:string}} args
 * @returns {Promise<{ok:boolean, url?:string, reason?:string, sizeBytes?:number}>}
 */
async function put({ objectKey, buffer, contentType }) {
  if (!configured()) return { ok: false, reason: 'Azure Blob storage is not configured (add AZURE_DOCAI_LABEL_SAS_TOKEN or AZURE_DOCAI_LABEL_ACCOUNT_KEY in Render)' };
  if (!objectKey || !buffer) return { ok: false, reason: 'objectKey + buffer required' };

  const url = blobUrl(objectKey);
  const ct = contentType || 'application/octet-stream';
  const nowHttp = new Date().toUTCString();
  const headers = {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-version': API_VERSION,
    'x-ms-date': nowHttp,
    'Content-Type': ct,
    'Content-Length': String(buffer.length),
  };

  let putUrl = url;
  if (cfg.azureCustom.labelStorageSasToken) {
    const sas = cfg.azureCustom.labelStorageSasToken.startsWith('?') ? cfg.azureCustom.labelStorageSasToken : '?' + cfg.azureCustom.labelStorageSasToken;
    putUrl = url + sas;
  } else if (cfg.azureCustom.labelStorageAccountKey) {
    headers.Authorization = sharedKeySignature('PUT', headers, cfg.azureCustom.labelStorageAccount, cfg.azureCustom.labelContainer, objectKey, cfg.azureCustom.labelStorageAccountKey);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  let r;
  try {
    r = await fetch(putUrl, { method: 'PUT', headers, body: buffer, signal: ac.signal });
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'blob upload timed out' : e.message };
  } finally { clearTimeout(timer); }

  if (r.status === 201 || r.status === 200) {
    return { ok: true, url, sizeBytes: buffer.length };
  }
  const body = await r.text().catch(() => '');
  return { ok: false, reason: `blob upload failed (HTTP ${r.status}): ${body.slice(0, 300)}` };
}

// Azure Storage Shared Key signature per
// https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key
// Only what we need: PUT of a single blob with the minimal canonical set.
function sharedKeySignature(verb, headers, account, container, objectKey, keyBase64) {
  const contentLength = headers['Content-Length'] || '';
  const contentType = headers['Content-Type'] || '';
  const canonicalHeaders = Object.keys(headers)
    .filter(k => k.toLowerCase().startsWith('x-ms-'))
    .map(k => k.toLowerCase() + ':' + headers[k])
    .sort()
    .join('\n');
  const canonicalResource = `/${account}/${container}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const stringToSign = [
    verb, '', '', contentLength, '', contentType, '', '', '', '', '', '',
    canonicalHeaders, canonicalResource,
  ].join('\n');
  const key = Buffer.from(keyBase64, 'base64');
  const sig = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
  return `SharedKey ${account}:${sig}`;
}

module.exports = { configured, put, blobUrl };
