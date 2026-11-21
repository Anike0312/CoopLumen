import request from 'supertest';
import app from '../../../app';
import { db } from '../../../db';

jest.mock('../../../db', () => ({
  db: {
    query: jest.fn(),
    ping: jest.fn(),
    transaction: jest.fn(),
  },
}));

const query = db.query as jest.Mock;
const payloads = [
  "' OR '1'='1",
  "'; DROP TABLE communities; --",
  "' UNION SELECT current_user, version() --",
  "1); SELECT pg_sleep(10); --",
];

describe('SQL injection boundary', () => {
  beforeEach(() => query.mockReset());

  it.each(payloads)('binds community search payload as a value: %s', async (payload) => {
    query.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);
    await request(app).get('/api/v1/communities').query({ search: payload });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).not.toContain(payload);
    expect(params).toContain(payload);
  });

  it.each(payloads)('binds loan borrower payload as a value: %s', async (payload) => {
    query.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);
    await request(app).get('/api/v1/loans').query({ borrower: payload });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).not.toContain(payload);
    expect(params).toContain(payload);
  });
});
