import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import hooksRouter from './routes/hooks';
import apiRouter from './routes/api';
import rulesRouter from './routes/rules';
import flagsRouter from './routes/flags';

const app = express();
const PORT = parseInt(process.env.PORT || '3003', 10);
// Tool output (e.g. browser/simulator screenshots) routinely exceeds express's
// 100kb default, which rejected those hook events before they were logged.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '50mb';

app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Optional bearer-token auth for the hook transport. When HOOK_AUTH_TOKEN is
// set, every /hooks/* request must carry `Authorization: Bearer <token>`.
// Unset = no auth (backwards compatible with existing deployments).
const HOOK_AUTH_TOKEN = process.env.HOOK_AUTH_TOKEN;
if (HOOK_AUTH_TOKEN) {
  app.use('/hooks', (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${HOOK_AUTH_TOKEN}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  console.log('Hook auth: ENABLED (Bearer token required on /hooks)');
}

app.use('/hooks', hooksRouter);
app.use('/api', apiRouter);
app.use('/api', rulesRouter);
app.use('/api', flagsRouter);
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Hooks server running on http://localhost:${PORT}`);
});
