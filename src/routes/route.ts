import { Router, Request, Response } from 'express';
import { calculateRoutes, Priority } from '../services/routing.service';
import { geocodeAddress } from '../utils/geocode';

const router = Router();

/**
 * POST /api/route
 * Body:
 *   { origin: { lat, lng } | { address: string },
 *     destination: { lat, lng } | { address: string },
 *     priority: 'cheaper' | 'faster' | 'less_transfers' }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { origin, destination, priority } = req.body || {};

    if (!origin || !destination) {
      return res.status(400).json({ error: 'origin e destination são obrigatórios.' });
    }

    const validPriorities: Priority[] = ['cheaper', 'faster', 'less_transfers'];
    const selectedPriority: Priority = validPriorities.includes(priority) ? priority : 'faster';

    // Resolve coordenadas (aceita {lat,lng} direto ou {address} para geocodificar)
    let originCoords: { lat: number; lng: number };
    let destCoords: { lat: number; lng: number };

    if (origin.lat && origin.lng) {
      originCoords = { lat: Number(origin.lat), lng: Number(origin.lng) };
    } else if (origin.address) {
      originCoords = await geocodeAddress(origin.address);
    } else {
      return res.status(400).json({ error: 'origin deve ter {lat,lng} ou {address}.' });
    }

    if (destination.lat && destination.lng) {
      destCoords = { lat: Number(destination.lat), lng: Number(destination.lng) };
    } else if (destination.address) {
      destCoords = await geocodeAddress(destination.address);
    } else {
      return res.status(400).json({ error: 'destination deve ter {lat,lng} ou {address}.' });
    }

    const routes = await calculateRoutes(
      originCoords.lat, originCoords.lng,
      destCoords.lat, destCoords.lng,
      selectedPriority
    );

    return res.json({
      priority: selectedPriority,
      origin: originCoords,
      destination: destCoords,
      routes
    });

  } catch (err: any) {
    console.error('[POST /api/route]', err.message);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

export default router;
