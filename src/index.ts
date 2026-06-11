import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import express, { Request, Response } from 'express';
import cors from 'cors';
import { pool } from './db';
import routeRouter from './routes/route';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Rio Mobility Assistant API up and running' });
});

// Journeys (histórico)
app.post('/journeys', async (req: Request, res: Response) => {
  const { origin, destination, preferred_modes } = req.body || {};
  if (!origin || !destination) {
    res.status(400).json({ error: 'origin and destination are required' });
    return;
  }
  try {
    const result = await pool.query(
      `insert into journeys (origin_lat, origin_lon, destination_lat, destination_lon, preferred_modes)
       values ($1, $2, $3, $4, $5) returning *`,
      [origin.lat, origin.lon, destination.lat, destination.lon, preferred_modes || []]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error inserting journey', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/journeys', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`select * from journeys order by created_at desc`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching journeys', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Roteamento principal
app.use('/api/route', routeRouter);

app.listen(PORT, () => { console.log(`Server listening on port ${PORT}`); });
