import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createStudioHttpsTransport} from '../../lib/voice-studio-https-transport.js';

test('HTTPS transport pins the validated address and preserves TLS verification', async () => {
  let captured;
  const transport = createStudioHttpsTransport({
    resolve: async () => [{address: '8.8.8.8', family: 4}],
    requestImpl: (_url, options, callback) => {
      captured = options;
      const req = new EventEmitter();
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {'content-type': 'audio/mpeg'};
        callback(response);
        response.emit('data', Buffer.from('ID3 test'));
        response.emit('end');
      };
      return req;
    },
  });

  const response = await transport('https://files.heygen.ai/audio/test.mp3', {
    method: 'GET',
    redirect: 'manual',
  });

  assert.equal(response.status, 200);
  assert.equal(captured.servername, 'files.heygen.ai');
  assert.equal(captured.rejectUnauthorized, true);
  assert.equal(captured.agent, false);

  await new Promise((resolve, reject) => {
    captured.lookup('files.heygen.ai', {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
      resolve();
    });
  });
});

test('HTTPS transport rejects unsafe DNS addresses before connecting', async () => {
  const unsafe = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
  ];

  let connections = 0;

  for (const address of unsafe) {
    const transport = createStudioHttpsTransport({
      resolve: async () => [{address}],
      requestImpl: () => {
        connections++;
        throw new Error('Connection must not be attempted');
      },
    });

    await assert.rejects(
      transport('https://files.heygen.ai/audio/test.mp3', {
        method: 'GET',
        redirect: 'manual',
      }),
      {message: 'studio_https_transport_unavailable'},
      `Expected rejection of ${address}`,
    );
  }

  assert.equal(connections, 0);
});

test('HTTPS transport rejects mixed public and private DNS results', async () => {
  let connections = 0;

  const transport = createStudioHttpsTransport({
    resolve: async () => [
      {address: '8.8.8.8', family: 4},
      {address: '127.0.0.1', family: 4},
    ],
    requestImpl: () => {
      connections++;
      throw new Error('Connection must not be attempted');
    },
  });

  await assert.rejects(
    transport('https://files.heygen.ai/audio/test.mp3', {
      method: 'GET',
      redirect: 'manual',
    }),
    {message: 'studio_https_transport_unavailable'},
  );

  assert.equal(connections, 0);
});

test('HTTPS transport rejects oversized responses without returning partial data', async () => {
  let destroyed = false;

  const transport = createStudioHttpsTransport({
    resolve: async () => [{address: '8.8.8.8', family: 4}],
    requestImpl: (_url, _options, callback) => {
      const req = new EventEmitter();

      req.destroy = error => {
        destroyed = true;
        req.emit('error', error);
      };

      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {'content-type': 'audio/mpeg'};
        callback(response);
        response.emit('data', Buffer.alloc(20 * 1024 * 1024 + 1));
      };

      return req;
    },
  });

  await assert.rejects(
    transport('https://files.heygen.ai/audio/test.mp3', {
      method: 'GET',
      redirect: 'manual',
    }),
    {message: 'studio_https_transport_unavailable'},
  );

  assert.equal(destroyed, true);
});

test('HTTPS transport rejects an aborted request', async () => {
  const controller = new AbortController();
  let capturedSignal;

  const transport = createStudioHttpsTransport({
    resolve: async () => [{address: '8.8.8.8', family: 4}],
    requestImpl: (_url, options) => {
      capturedSignal = options.signal;
      const req = new EventEmitter();

      req.end = () => {
        controller.signal.addEventListener('abort', () => {
          req.emit('error', new Error('Request aborted'));
        }, {once: true});
      };

      return req;
    },
  });

  const pending = transport('https://files.heygen.ai/audio/test.mp3', {
    method: 'GET',
    redirect: 'manual',
    signal: controller.signal,
  });

  await new Promise(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, {message: 'studio_https_transport_unavailable'});
  assert.equal(capturedSignal, controller.signal);
});

test('HTTPS transport redacts underlying network errors', async () => {
  const signedUrl = 'https://files.heygen.ai/audio/test.mp3?signature=synthetic-secret';

  const transport = createStudioHttpsTransport({
    resolve: async () => [{address: '8.8.8.8', family: 4}],
    requestImpl: () => {
      const req = new EventEmitter();

      req.end = () => {
        req.emit('error', new Error(`Connection failed: ${signedUrl}`));
      };

      return req;
    },
  });

  await assert.rejects(
    transport(signedUrl, {
      method: 'GET',
      redirect: 'manual',
    }),
    {message: 'studio_https_transport_unavailable'},
  );
});

test('HTTPS transport handles HTTP 204 without constructing a response body', async () => {
  const transport = createStudioHttpsTransport({
    resolve: async () => [{address: '8.8.8.8', family: 4}],
    requestImpl: (_url, _options, callback) => {
      const req = new EventEmitter();

      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 204;
        response.headers = {};
        callback(response);
        response.emit('end');
      };

      return req;
    },
  });

  const response = await transport('https://files.heygen.ai/audio/test.mp3', {
    method: 'GET',
    redirect: 'manual',
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('HTTPS transport rejects unapproved hosts before DNS or connection', async () => {
  let dnsLookups = 0;
  let connections = 0;

  const transport = createStudioHttpsTransport({
    resolve: async () => {
      dnsLookups++;
      return [{address: '8.8.8.8', family: 4}];
    },
    requestImpl: () => {
      connections++;
      throw new Error('Connection must not be attempted');
    },
  });

  for (const url of [
    'https://example.com/audio.mp3',
    'https://api.heygen.com.evil.example/audio.mp3',
    'http://files.heygen.ai/audio.mp3',
    'https://127.0.0.1/audio.mp3',
  ]) {
    await assert.rejects(
      transport(url, {method: 'GET', redirect: 'manual'}),
      {message: 'studio_https_transport_unavailable'},
    );
  }

  assert.equal(dnsLookups, 0);
  assert.equal(connections, 0);
});

test('HTTPS transport redacts DNS resolver errors', async () => {
  const transport = createStudioHttpsTransport({
    resolve: async () => {
      throw new Error('DNS failure containing synthetic-private-details');
    },
    requestImpl: () => {
      throw new Error('Connection must not be attempted');
    },
  });

  await assert.rejects(
    transport('https://files.heygen.ai/audio/test.mp3', {
      method: 'GET',
      redirect: 'manual',
    }),
    {message: 'studio_https_transport_unavailable'},
  );
});

test('HTTPS transport redacts synchronous request construction errors', async () => {
  const transport = createStudioHttpsTransport({
    resolve: async () => [{address: '8.8.8.8', family: 4}],
    requestImpl: () => {
      throw new Error('Request construction exposed synthetic-private-details');
    },
  });

  await assert.rejects(
    transport('https://files.heygen.ai/audio/test.mp3', {
      method: 'GET',
      redirect: 'manual',
    }),
    {message: 'studio_https_transport_unavailable'},
  );
});
