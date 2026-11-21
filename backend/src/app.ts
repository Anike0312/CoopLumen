import express, { NextFunction, Request, Response, Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { apiRouter } from './api/routes';
import { errorHandler } from './api/middleware/errorHandler';
import { notFound } from './api/middleware/notFound';
import { requestLogger } from './api/middleware/requestLogger';
import { communityWriteLimiter } from './api/middleware/rateLimit';
import { csrfProtection } from './api/middleware/csrf';
import { db } from './db';
import { StellarService } from './contracts/stellar';
import { auditStateChange } from './api/middleware/auditLog';

const app: Application = express();

// Behind a load balancer every request otherwise appears to come from the proxy,
// so per-IP rate limits would throttle all clients as one. Opt in with the
// number of trusted proxy hops, e.g. TRUST_PROXY=1.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    return;
  }
  next();
});
app.use(
  helmet({
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [
          "'self'",
          process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
        ],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  })
);
app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }));
// Captures the exact bytes received so webhook signature verification can
// HMAC over the same payload the client signed, before JSON parsing/
// re-serialization has a chance to change its byte representation.
const captureRawBody = (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer): void => {
  req.rawBody = Buffer.from(buf);
};

// Bodies over the limit are rejected with 413 before they are fully buffered,
// so an oversized payload cannot exhaust memory in the parser.
const defaultJsonParser = express.json({ limit: '10kb', verify: captureRawBody });

// POST /tokens/transfer carries a client-signed XDR envelope of up to 100,000
// characters (see transferSchema in routes/tokens.ts), which exceeds 10kb.
const transferJsonParser = express.json({ limit: '100kb', verify: captureRawBody });
const transferPath = /^\/api\/v1\/tokens\/transfer\/?$/i;

app.use((req, res, next) => {
  const parser =
    req.method === 'POST' && transferPath.test(req.path) ? transferJsonParser : defaultJsonParser;
  parser(req, res, next);
});
app.use(requestLogger);
app.use(auditStateChange);

const healthHandler = (_req: Request, res: Response, next: NextFunction): void => {
  Promise.allSettled([db.ping(), StellarService.ping()])
    .then(([dbResult, stellarResult]) => {
      const dbOk = dbResult.status === 'fulfilled' && dbResult.value;
      const stellarOk = stellarResult.status === 'fulfilled' && stellarResult.value;
      res.status(dbOk ? 200 : 503).json({
        status: dbOk ? 'ok' : 'degraded',
        db: dbOk ? 'ok' : 'error',
        stellar: stellarOk ? 'ok' : 'error',
        uptime: Math.floor(process.uptime()),
        version: '0.1.0',
      });
    })
    .catch(next);
};

// Health checks stay unversioned so infra probes have a stable path.
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Apply the community write limit to every nested community resource endpoint.
// The limiter itself skips GET, HEAD, and OPTIONS requests.
app.use('/api/v1/communities', communityWriteLimiter);

// All resource routes live under the /api/v1 version prefix.
app.use('/api/v1', csrfProtection, apiRouter);

app.use(notFound);
app.use(errorHandler);

export default app;
