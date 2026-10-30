import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceStudioDbQa,
  prepareVoiceStudioDbQa,
} from '../../lib/voice-studio-db-qa.js';

const env = {
  RENDER_SERVICE_NAME: 'mss-voice-assets-qa',
  DATABASE_URL: 'postgresql://synthetic_user:synthetic_password@pg-db-test/ingle_qa_db',
};

test('QA database factory rejects unsafe configurations', () => {
  class FakePool {
    constructor(options) {
      this.options = options;
    }
  }

  for (const override of [
    {RENDER_SERVICE_NAME: 'mss-voice-assets'},
    {DATABASE_URL: 'postgresql://user:password@pg-db-test/production'},
    {DATABASE_URL: `${env.DATABASE_URL}?sslmode=disable`},
    {DATABASE_URL: `${env.DATABASE_URL}?sslrootcert=invalid`},
    {DATABASE_URL: ''},
  ]) {
    assert.throws(
      () => createVoiceStudioDbQa({
        env: {...env, ...override},
        PoolImpl: FakePool,
      }),
      {message: 'studio_qa_database_unavailable'}
    );
  }

  const pool = createVoiceStudioDbQa({env, PoolImpl: FakePool});
  assert.deepEqual(pool.options.ssl, {rejectUnauthorized: false});
  assert.equal(pool.options.max, 2);
});

test('QA database preparation accepts verified identity', async () => {
  let closed = false;

  class FakePool {
    async query(sql) {
      assert.equal(sql, 'SELECT current_database() AS name');
      return {rows: [{name: 'ingle_qa_db'}]};
    }
    async end() {
      closed = true;
    }
  }

  const pool = await prepareVoiceStudioDbQa({env, PoolImpl: FakePool});
  assert.ok(pool instanceof FakePool);
  assert.equal(closed, false);
});

test('QA database preparation rejects incorrect identity and closes pool', async () => {
  let closed = false;

  class FakePool {
    async query() {
      return {rows: [{name: 'production_db'}]};
    }
    async end() {
      closed = true;
    }
  }

  await assert.rejects(
    prepareVoiceStudioDbQa({env, PoolImpl: FakePool}),
    {message: 'studio_qa_database_unavailable'}
  );

  assert.equal(closed, true);
});

test('QA database preparation handles connection failure safely', async () => {
  let closed = false;

  class FakePool {
    async query() {
      throw Error('synthetic_connection_failure');
    }
    async end() {
      closed = true;
    }
  }

  await assert.rejects(
    prepareVoiceStudioDbQa({env, PoolImpl: FakePool}),
    {message: 'studio_qa_database_unavailable'}
  );

  assert.equal(closed, true);
});
