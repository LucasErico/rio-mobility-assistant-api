import { pool } from '../db';
import { getNearbyStops, NearbyStop } from './stops.service';

export type Priority = 'cheaper' | 'faster' | 'less_transfers';

export interface RouteLeg {
  modal: string;
  route_name: string;
  from_stop: string;
  to_stop: string;
  from_coords: { lat: number; lng: number };
  to_coords: { lat: number; lng: number };
  estimated_minutes: number;
  walk_to_stop_m: number;
}

export interface RouteOption {
  legs: RouteLeg[];
  summary: {
    total_minutes: number;
    transfers: number;
    estimated_cost_brl: number;
  };
}

const MODAL_FARE: Record<string, number> = {
  bus: 4.05,
  metro: 5.70,
  train: 2.20,
  vlt: 0.00  // gratuito atualmente
};

const WALK_SPEED_M_PER_MIN = 80; // ~5km/h

function walkMinutes(meters: number): number {
  return Math.ceil(meters / WALK_SPEED_M_PER_MIN);
}

// Busca trips de ônibus que conectam dois stops
async function getBusTripsConnecting(
  originStopId: string,
  destStopIds: string[]
): Promise<{ trip_id: string; route_name: string; dest_stop_id: string; stop_count: number }[]> {
  if (destStopIds.length === 0) return [];

  const result = await pool.query(`
    SELECT
      st1.trip_id,
      COALESCE(r.route_short_name, r.route_long_name) AS route_name,
      st2.stop_id AS dest_stop_id,
      (st2.stop_sequence - st1.stop_sequence) AS stop_count
    FROM gtfs_stop_times st1
    JOIN gtfs_stop_times st2
      ON st1.trip_id = st2.trip_id
      AND st2.stop_sequence > st1.stop_sequence
      AND st2.stop_id = ANY($2)
    JOIN gtfs_trips t ON t.trip_id = st1.trip_id
    JOIN gtfs_routes r ON r.route_id = t.route_id
    WHERE st1.stop_id = $1
    ORDER BY stop_count
    LIMIT 20
  `, [originStopId, destStopIds]);

  return result.rows;
}

// Estima minutos de viagem baseado em headway e número de paradas
async function estimateBusTravelMinutes(tripId: string, stopCount: number): Promise<number> {
  const freq = await pool.query(`
    SELECT headway_secs FROM gtfs_frequencies
    WHERE trip_id = $1
    LIMIT 1
  `, [tripId]);

  const waitMinutes = freq.rows.length > 0
    ? Math.ceil(freq.rows[0].headway_secs / 60 / 2) // espera média = metade do headway
    : 15; // fallback: 15min de espera

  const travelMinutes = stopCount * 2; // estimativa: 2min por parada
  return waitMinutes + travelMinutes;
}

// Rotas diretas (1 condução)
async function findDirectRoutes(
  originStops: NearbyStop[],
  destStops: NearbyStop[],
  priority: Priority
): Promise<RouteOption[]> {
  const routes: RouteOption[] = [];

  const busOrigins = originStops.filter(s => s.modal === 'bus');
  const busDestIds = destStops.filter(s => s.modal === 'bus').map(s => s.id);
  const destStopMap = new Map(destStops.map(s => [s.id, s]));

  for (const originStop of busOrigins) {
    const trips = await getBusTripsConnecting(originStop.id, busDestIds);
    for (const trip of trips.slice(0, 3)) {
      const destStop = destStopMap.get(trip.dest_stop_id)!;
      const travelMin = await estimateBusTravelMinutes(trip.trip_id, trip.stop_count);
      const walkOrigin = walkMinutes(originStop.distance_m);
      const walkDest = walkMinutes(destStop.distance_m);

      routes.push({
        legs: [{
          modal: 'bus',
          route_name: trip.route_name,
          from_stop: originStop.name,
          to_stop: destStop.name,
          from_coords: { lat: originStop.lat, lng: originStop.lng },
          to_coords: { lat: destStop.lat, lng: destStop.lng },
          estimated_minutes: travelMin,
          walk_to_stop_m: originStop.distance_m
        }],
        summary: {
          total_minutes: walkOrigin + travelMin + walkDest,
          transfers: 0,
          estimated_cost_brl: MODAL_FARE.bus
        }
      });
    }
  }

  return routes;
}

// Rotas com 1 baldeação (2 conduções)
async function findOneTransferRoutes(
  originStops: NearbyStop[],
  destStops: NearbyStop[],
  priority: Priority
): Promise<RouteOption[]> {
  const routes: RouteOption[] = [];

  // Busca stops de metrô/trem/VLT como pontos de baldeação candidatos
  const transferCandidates = [...originStops, ...destStops].filter(
    s => s.modal === 'metro' || s.modal === 'train' || s.modal === 'vlt'
  );

  // Ônibus origem → metrô/trem/vlt → destino
  for (const transfer of transferCandidates) {
    // Leg 1: ônibus da origem até o ponto de transferência
    const nearTransfer = await getNearbyStops(transfer.lat, transfer.lng);
    const busToTransfer = nearTransfer.filter(s => s.modal === 'bus').slice(0, 3);
    const busOrigins = originStops.filter(s => s.modal === 'bus');

    for (const originStop of busOrigins.slice(0, 3)) {
      for (const transferBusStop of busToTransfer) {
        const leg1Trips = await getBusTripsConnecting(originStop.id, [transferBusStop.id]);
        if (leg1Trips.length === 0) continue;
        const leg1Trip = leg1Trips[0];
        const leg1Min = await estimateBusTravelMinutes(leg1Trip.trip_id, leg1Trip.stop_count);

        // Leg 2: modal do ponto de transferência até destino
        const destStopsSameModal = destStops.filter(s => s.modal === transfer.modal);
        if (destStopsSameModal.length === 0) continue;

        const destStop = destStopsSameModal[0];
        const leg2Min = 15; // estimativa conservadora para metrô/trem/vlt

        const walkOrigin = walkMinutes(originStop.distance_m);
        const walkDest = walkMinutes(destStop.distance_m);

        routes.push({
          legs: [
            {
              modal: 'bus',
              route_name: leg1Trip.route_name,
              from_stop: originStop.name,
              to_stop: transferBusStop.name,
              from_coords: { lat: originStop.lat, lng: originStop.lng },
              to_coords: { lat: transferBusStop.lat, lng: transferBusStop.lng },
              estimated_minutes: leg1Min,
              walk_to_stop_m: originStop.distance_m
            },
            {
              modal: transfer.modal,
              route_name: transfer.name,
              from_stop: transfer.name,
              to_stop: destStop.name,
              from_coords: { lat: transfer.lat, lng: transfer.lng },
              to_coords: { lat: destStop.lat, lng: destStop.lng },
              estimated_minutes: leg2Min,
              walk_to_stop_m: transferBusStop.distance_m
            }
          ],
          summary: {
            total_minutes: walkOrigin + leg1Min + leg2Min + walkDest,
            transfers: 1,
            estimated_cost_brl: MODAL_FARE.bus + MODAL_FARE[transfer.modal]
          }
        });
      }
    }
  }

  return routes;
}

function sortByPriority(routes: RouteOption[], priority: Priority): RouteOption[] {
  return routes.sort((a, b) => {
    if (priority === 'faster')         return a.summary.total_minutes - b.summary.total_minutes;
    if (priority === 'cheaper')        return a.summary.estimated_cost_brl - b.summary.estimated_cost_brl;
    if (priority === 'less_transfers') return a.summary.transfers - b.summary.transfers;
    return 0;
  });
}

export async function calculateRoutes(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  priority: Priority
): Promise<RouteOption[]> {
  const [originStops, destStops] = await Promise.all([
    getNearbyStops(originLat, originLng),
    getNearbyStops(destLat, destLng)
  ]);

  if (originStops.length === 0 || destStops.length === 0) {
    throw new Error('Nenhum ponto de embarque encontrado próximo à origem ou destino.');
  }

  const [directRoutes, oneTransferRoutes] = await Promise.all([
    findDirectRoutes(originStops, destStops, priority),
    findOneTransferRoutes(originStops, destStops, priority)
  ]);

  const allRoutes = [...directRoutes, ...oneTransferRoutes];

  if (allRoutes.length === 0) {
    throw new Error('Nenhuma rota encontrada entre os pontos informados.');
  }

  const sorted = sortByPriority(allRoutes, priority);
  return sorted.slice(0, 5); // retorna top 5 opções
}
