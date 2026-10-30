import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const fail = () => new Error('studio_https_transport_unavailable');
const allowedHosts = new Set(['api.heygen.com', 'files.heygen.ai']);

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 &&
    a >= 1 && a < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19)) &&
    !(a === 192 && b === 0 && c === 0) &&
    !(a === 192 && b === 0 && c === 2) &&
    !(a === 198 && b === 51 && c === 100) &&
    !(a === 203 && b === 0 && c === 113);
}

export function createStudioHttpsTransport({
  resolve = hostname => lookup(hostname, {all: true}),
  requestImpl = https.request,
} = {}) {
  return async function request(urlValue, options = {}) {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.port && url.port !== '443' || isIP(url.hostname) ||
        !allowedHosts.has(url.hostname)) throw fail();

    let addresses;
    try {
      addresses = await resolve(url.hostname);
    } catch {
      throw fail();
    }
    if (!Array.isArray(addresses) || !addresses.length ||
        addresses.some(entry => !publicIPv4(entry.address))) throw fail();

    const pinnedAddress = addresses[0].address;
    const method = options.method || 'GET';
    const maxResponseBytes = method === 'POST'
      ? 1024 * 1024
      : 20 * 1024 * 1024;

    if (!['GET', 'POST'].includes(method) ||
        options.redirect !== 'manual') throw fail();

    return new Promise((resolveResponse, rejectResponse) => {
      try {
      const req = requestImpl(url, {
        method,
        headers: options.headers || {},
        lookup: (_hostname, _options, callback) =>
          callback(null, pinnedAddress, 4),
        servername: url.hostname,
        rejectUnauthorized: true,
        agent: false,
        signal: options.signal,
      }, response => {
        const chunks = [];
        let length = 0;

        response.on('data', chunk => {
          length += chunk.length;
          if (length > maxResponseBytes) {
            req.destroy(fail());
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          const status = response.statusCode;
          const body = [204, 205, 304].includes(status)
            ? null
            : Buffer.concat(chunks);

          try {
            resolveResponse(new Response(body, {
              status,
              headers: response.headers,
            }));
          } catch {
            rejectResponse(fail());
          }
        });

        response.on('error', () => rejectResponse(fail()));
      });

      req.on('error', () => rejectResponse(fail()));
      req.end(options.body);
      } catch {
        rejectResponse(fail());
      }
    });
  };
}
