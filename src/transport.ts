import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { MAX_BODY, SafeError } from './protocol.js';
import { httpsUrl, readSecret } from './config.js';

export async function jsonRequest(base: string, path: string, bearer: string, method = 'GET', body?: unknown, caFile?: string, credentials?: { client_cert_file?: string; client_key_file?: string }): Promise<unknown> {
  const url = new URL(httpsUrl.parse(base));
  // Origin-only base prevents URL path/credential confusion; paths are internal constants.
  if (url.pathname !== '/') throw new SafeError('invalid_configuration');
  url.pathname = path;
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (data && Buffer.byteLength(data) > MAX_BODY) throw new SafeError('item_too_large', 413);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method, ...(caFile ? { ca: readFileSync(caFile) } : {}),
      ...(credentials?.client_cert_file && credentials.client_key_file ? { cert: readFileSync(credentials.client_cert_file), key: readSecret(credentials.client_key_file) } : {}),
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      timeout: 15000,
    }, response => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_BODY) { response.destroy(); reject(new SafeError('invalid_response', 502)); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new SafeError('transport_failed', 503)));
      response.on('end', () => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) { reject(new SafeError(status === 401 ? 'unauthorized' : status === 409 ? 'request_conflict' : status === 429 ? 'quota_exceeded' : 'delivery_unavailable', status)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new SafeError('invalid_response', 502)); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new SafeError('transport_failed', 503)));
    if (data) req.write(data);
    req.end();
  });
}
