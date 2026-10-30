// Dedicated Voice Studio QA database connection.
// Construction creates a pool but does not open a connection.
// Render internal TLS; certificate verification is unavailable.
import {Pool} from 'pg';

export function createVoiceStudioDbQa({env=process.env, PoolImpl=Pool}={}) {
  if (env.RENDER_SERVICE_NAME !== 'mss-voice-assets-qa' ||
      typeof env.DATABASE_URL !== 'string') {
    throw Error('studio_qa_database_unavailable');
  }

  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw Error('studio_qa_database_unavailable');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname !== '/ingle_qa_db' ||
      !url.hostname || !url.username || !url.password ||
      [...url.searchParams.keys()].some(k =>
        /^(ssl|sslmode|sslcert|sslkey|sslrootcert)$/i.test(k))) {
    throw Error('studio_qa_database_unavailable');
  }

  return new PoolImpl({
    connectionString: env.DATABASE_URL,
    // Render internal PostgreSQL: encrypted TLS with a self-signed certificate.
    // Certificate verification is unavailable on this connection type.
    // Restrict use to the QA service and verify current_database() before access.
    ssl: {rejectUnauthorized: false},
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
}


// Explicit preparation step. The pool is not exposed until the live
// connection confirms the required QA database identity.
// The journal independently rechecks identity before each operation.
export async function prepareVoiceStudioDbQa(options = {}) {
  const pool = createVoiceStudioDbQa(options);

  try {
    const result = await pool.query(
      'SELECT current_database() AS name'
    );

    if (result.rows?.[0]?.name !== 'ingle_qa_db') {
      throw Error('database_identity_mismatch');
    }

    return pool;
  } catch {
    await pool.end().catch(() => {});
    throw Error('studio_qa_database_unavailable');
  }
}
