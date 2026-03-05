import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import hooksRouter from './routes/hooks';
import apiRouter from './routes/api';

const app = express();
const PORT = parseInt(process.env.PORT || '3003', 10);

app.use(cors());
app.use(express.json());

app.use('/hooks', hooksRouter);
app.use('/api', apiRouter);
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Hooks server running on http://localhost:${PORT}`);
});
