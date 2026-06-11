import { request } from 'node:https';
import type { URL } from 'node:url';

const REQUEST_TIMEOUT_MS = 30_000;

// Azure DevOps PAT auth is HTTP Basic with an empty username and the PAT as the password.
function encodeBasic(pat: string): string {
  return Buffer.from(`:${pat}`).toString('base64');
}

export function doAdoGet(url: URL, pat: string): Promise<string> {
  return doAdoRequest(url, pat, 'GET');
}

export function doAdoPost(url: URL, pat: string, payload: string): Promise<string> {
  return doAdoRequest(url, pat, 'POST', payload, { 'Content-Type': 'application/json' });
}

function doAdoRequest(
  url: URL,
  pat: string,
  method: 'GET' | 'POST',
  payload?: string,
  extraHeaders?: Record<string, string>
): Promise<string> {
  const auth = encodeBasic(pat);

  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname + url.search,
        protocol: url.protocol,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        let data = '';
        res.on('error', reject);
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const snippet = data?.slice(0, 200) || '';
            reject(
              new Error(`Azure DevOps API error ${res.statusCode}${snippet ? `: ${snippet}` : ''}`)
            );
            return;
          }

          resolve(data);
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Azure DevOps request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });
    req.on('error', reject);
    if (payload && method === 'POST') {
      req.write(payload);
    }
    req.end();
  });
}
