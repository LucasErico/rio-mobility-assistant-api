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
  shape_coords: { lat: number; lng: number }[];
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

// Tarifas 2026 (bus/brt/vlt: R$5,00 | metro: R$7,90 | train: R$7,60)
const MODAL_FARE: Record<string, number> = {
  bus:   5.00,
  metro: 7.90,
  train: 7.60,
  vlt:   5.00,
  brt:   5.00,
};

const MODAL_SPEED_M_PER_MIN: Record<string, number> = {
  bus:   250,
  brt:   400,
  metro: 500,
  train: 500,
  vlt:   300,
};

const WALK_SPEED_M_PER_MIN = 80;
const WALK_TRANSFER_MAX_M  = 400;
const MAX_TRANSFERS        = 3;

function walkMinutes(meters: number): number {
  return Math.ceil(meters / WALK_SPEED_M_PER_MIN);
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Shape real da trip via ST_LineLocatePoint ────────────────────────────────
// Usa a posição geográfica das paradas para localizar o trecho exato no shape.
// Elimina a estimativa proporcional por stop_sequence que cortava o shape cedo.
async function getShapeForTrip(
  tripId: string,
  fromStopId: string,
  toStopId: string
): Promise<{ lat: number; lng: number }[]> {
  try {
    // 1. Busca shape_id e coordenadas das duas paradas
    const stopsRes = await pool.query(
      `SELECT t.shape_id,
              s.stop_id,
              ST_Y(s.geom::geometry) AS lat,
              ST_X(s.geom::geometry) AS lng
       FROM gtfs_trips t
       JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
       JOIN gtfs_stops s ON s.stop_id = st.stop_id
       WHERE t.trip_id = $1 AND st.stop_id = ANY($2)`,
      [tripId, [fromStopId, toStopId]]
    );

    if (!stopsRes.rows.length || !stopsRes.rows[0].shape_id) return [];

    const shapeId  = stopsRes.rows[0].shape_id;
    const fromRow  = stopsRes.rows.find((r: any) => r.stop_id === fromStopId);
    const toRow    = stopsRes.rows.find((r: any) => r.stop_id === toStopId);

    if (!fromRow || !toRow) return [];

    // 2. Constrói a linha completa do shape e usa ST_LineLocatePoint
    //    para encontrar as frações 0..1 de onde cada parada cai no shape
    const fractionsRes = await pool.query(
      `WITH shape_line AS (
         SELECT ST_MakeLine(
           ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326)
           ORDER BY shape_pt_sequence
         ) AS line
         FROM gtfs_shapes
         WHERE shape_id = $1
       )
       SELECT
         ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($3, $2), 4326)) AS frac_from,
         ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($5, $4), 4326)) AS frac_to
       FROM shape_line`,
      [shapeId, fromRow.lat, fromRow.lng, toRow.lat, toRow.lng]
    );

    if (!fractionsRes.rows.length) return [];

    let { frac_from, frac_to } = fractionsRes.rows[0];

    // Garante ordem correta (em linhas circulares frac_from pode ser > frac_to)
    if (frac_from > frac_to) [frac_from, frac_to] = [frac_to, frac_from];

    // 3. Extrai os pontos do shape dentro do intervalo de frações
    //    Usa a mesma shape_line para filtrar por posição relativa
    const shapeRes = await pool.query(
      `WITH shape_line AS (
         SELECT ST_MakeLine(
           ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326)
           ORDER BY shape_pt_sequence
         ) AS line,
         MIN(shape_pt_sequence) AS min_seq,
         MAX(shape_pt_sequence) AS max_seq
         FROM gtfs_shapes
         WHERE shape_id = $1
       )
       SELECT
         shape_pt_lat AS lat,
         shape_pt_lon AS lng,
         shape_pt_sequence
       FROM gtfs_shapes gs, shape_line sl
       WHERE gs.shape_id = $1
         AND ST_LineLocatePoint(
               sl.line,
               ST_SetSRID(ST_MakePoint(gs.shape_pt_lon, gs.shape_pt_lat), 4326)
             ) BETWEEN $2 AND $3
       ORDER BY gs.shape_pt_sequence
       LIMIT 250`,
      [shapeId, frac_from, frac_to]
    );

    return shapeRes.rows.map((r: any) => ({ lat: Number(r.lat), lng: Number(r.lng) }));
  } catch {
    return [];
  }
}

// ─── Trips que saem de um stop ────────────────────────────────────────────────
async function getTripsFromStop(
  stopId: string,
  candidateDestStopIds: string[],
  cache: Map<string, any[]>
): Promise<{
  trip_id: string;
  route_name: string;
  modal: string;
  dest_stop_id: string;
  stop_count: number;
  from_seq: number;
  to_seq: number;
}[]> {
  if (candidateDestStopIds.length === 0) return [];

  const cacheKey = stopId + '|' + [...candidateDestStopIds].sort().join(',');
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const res = await pool.query(
    `SELECT
       st1.trip_id,
       COALESCE(r.route_short_name, r.route_long_name) AS route_name,
       CASE r.route_type
         WHEN 3 THEN 'bus'
         WHEN 1 THEN 'metro'
         WHEN 2 THEN 'train'
         WHEN 0 THEN 'vlt'
         WHEN 700 THEN 'brt'
         ELSE 'bus'
       END AS modal,
       st2.stop_id AS dest_stop_id,
       (st2.stop_sequence - st1.stop_sequence) AS stop_count,
       st1.stop_sequence AS from_seq,
       st2.stop_sequence AS to_seq
     FROM gtfs_stop_times st1
     JOIN gtfs_stop_times st2
       ON st1.trip_id = st2.trip_id
      AND st2.stop_sequence > st1.stop_sequence
      AND st2.stop_id = ANY($2)
     JOIN gtfs_trips t  ON t.trip_id  = st1.trip_id
     JOIN gtfs_routes r ON r.route_id = t.route_id
     WHERE st1.stop_id = $1
     ORDER BY stop_count
     LIMIT 30`,
    [stopId, candidateDestStopIds]
  );

  cache.set(cacheKey, res.rows);
  return res.rows;
}

// ─── Estimativa de tempo de viagem ────────────────────────────────────────────
async function estimateTravelMinutes(
  tripId: string,
  stopCount: number,
  modal: string,
  fromStopId: string,
  toStopId: string,
  freqCache: Map<string, number>
): Promise<number> {
  let distM = 0;
  try {
    const distRes = await pool.query(
      `SELECT ROUND(ST_Distance(
         s1.geom::geography,
         s2.geom::geography
       ))::int AS dist_m
       FROM gtfs_stops s1, gtfs_stops s2
       WHERE s1.stop_id = $1 AND s2.stop_id = $2`,
      [fromStopId, toStopId]
    );
    distM = distRes.rows[0]?.dist_m ?? 0;
  } catch { /* fallback */ }

  const speed     = MODAL_SPEED_M_PER_MIN[modal] ?? 250;
  const travelMin = distM > 0
    ? Math.ceil(distM / speed)
    : stopCount * (modal === 'brt' ? 1.5 : 2);

  let waitMin = 12;
  if (freqCache.has(tripId)) {
    waitMin = freqCache.get(tripId)!;
  } else {
    const freq = await pool.query(
      `SELECT headway_secs FROM gtfs_frequencies WHERE trip_id = $1 LIMIT 1`,
      [tripId]
    );
    waitMin = freq.rows.length > 0
      ? Math.ceil(freq.rows[0].headway_secs / 60 / 2)
      : 12;
    freqCache.set(tripId, waitMin);
  }

  return waitMin + travelMin;
}

// ─── BFS ──────────────────────────────────────────────────────────────────────
interface BfsNode {
  stopId:    string;
  stop:      NearbyStop;
  legs:      RouteLeg[];
  totalMin:  number;
  totalCost: number;
  transfers: number;
}

async function bfsRoutes(
  originStops: NearbyStop[],
  destStops:   NearbyStop[],
  priority:    Priority
): Promise<RouteOption[]> {
  const destStopMap      = new Map(destStops.map(s => [s.id, s]));
  const foundRoutes:     RouteOption[] = [];
  const seenFingerprints = new Set<string>();
  const tripsCache:      Map<string, any[]>  = new Map();
  const freqCache:       Map<string, number> = new Map();

  let queue: BfsNode[] = originStops.map(s => ({
    stopId:    s.id,
    stop:      s,
    legs:      [],
    totalMin:  walkMinutes(s.distance_m),
    totalCost: 0,
    transfers: 0,
  }));

  const visited = new Map<string, number>();

  while (queue.length > 0) {
    const nextQueue: BfsNode[] = [];

    for (const node of queue) {
      if (node.transfers > MAX_TRANSFERS) continue;

      const nearDestIds = destStops.map(s => s.id);

      // Chegada a pé
      const walkableDestIds = destStops
        .filter(ds => haversineM(node.stop.lat, node.stop.lng, ds.lat, ds.lng) <= WALK_TRANSFER_MAX_M)
        .map(ds => ds.id);

      if (walkableDestIds.length > 0) {
        for (const dId of walkableDestIds) {
          const ds    = destStopMap.get(dId)!;
          const walkM = haversineM(node.stop.lat, node.stop.lng, ds.lat, ds.lng);
          const fp    = node.legs.map(l => l.route_name + l.from_stop).join('|');
          if (!seenFingerprints.has(fp)) {
            seenFingerprints.add(fp);
            foundRoutes.push({
              legs: node.legs,
              summary: {
                total_minutes:      node.totalMin + walkMinutes(walkM),
                transfers:          Math.max(0, node.legs.length - 1),
                estimated_cost_brl: node.totalCost,
              },
            });
          }
        }
      }

      // Trips diretas
      const trips = await getTripsFromStop(node.stopId, nearDestIds, tripsCache);
      for (const trip of trips.slice(0, 5)) {
        const destStop  = destStopMap.get(trip.dest_stop_id)!;
        const travelMin = await estimateTravelMinutes(
          trip.trip_id, trip.stop_count, trip.modal,
          node.stopId, trip.dest_stop_id, freqCache
        );
        const shapeCoords = await getShapeForTrip(trip.trip_id, node.stopId, trip.dest_stop_id);
        const fare        = MODAL_FARE[trip.modal] ?? MODAL_FARE.bus;

        const leg: RouteLeg = {
          modal:             trip.modal,
          route_name:        trip.route_name,
          from_stop:         node.stop.name,
          to_stop:           destStop.name,
          from_coords:       { lat: node.stop.lat,  lng: node.stop.lng  },
          to_coords:         { lat: destStop.lat,   lng: destStop.lng   },
          shape_coords:      shapeCoords,
          estimated_minutes: travelMin,
          walk_to_stop_m:    node.stop.distance_m,
        };

        const newLegs  = [...node.legs, leg];
        const newMin   = node.totalMin + travelMin + walkMinutes(destStop.distance_m);
        const newCost  = node.totalCost + fare;
        const fp       = newLegs.map(l => l.route_name + l.from_stop).join('|');
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          foundRoutes.push({
            legs: newLegs,
            summary: {
              total_minutes:      newMin,
              transfers:          Math.max(0, newLegs.length - 1),
              estimated_cost_brl: newCost,
            },
          });
        }
      }

      // Expansão para próxima camada
      if (node.transfers < MAX_TRANSFERS) {
        const intermediateStops = await getNearbyStopsAlongRoute(
          node.stop.lat, node.stop.lng,
          destStops[0]?.lat ?? node.stop.lat,
          destStops[0]?.lng ?? node.stop.lng
        );

        for (const interStop of intermediateStops.slice(0, 8)) {
          if (interStop.id === node.stopId) continue;
          const prevBest   = visited.get(interStop.id) ?? Infinity;
          const interTrips = await getTripsFromStop(node.stopId, [interStop.id], tripsCache);
          if (interTrips.length === 0) continue;

          const interTrip   = interTrips[0];
          const interMin    = await estimateTravelMinutes(
            interTrip.trip_id, interTrip.stop_count, interTrip.modal,
            node.stopId, interStop.id, freqCache
          );
          const newTotalMin = node.totalMin + interMin;
          if (newTotalMin >= prevBest) continue;
          visited.set(interStop.id, newTotalMin);

          const interShape = await getShapeForTrip(interTrip.trip_id, node.stopId, interStop.id);
          nextQueue.push({
            stopId:    interStop.id,
            stop:      interStop,
            legs:      [...node.legs, {
              modal:             interTrip.modal,
              route_name:        interTrip.route_name,
              from_stop:         node.stop.name,
              to_stop:           interStop.name,
              from_coords:       { lat: node.stop.lat,  lng: node.stop.lng  },
              to_coords:         { lat: interStop.lat,  lng: interStop.lng  },
              shape_coords:      interShape,
              estimated_minutes: interMin,
              walk_to_stop_m:    node.stop.distance_m,
            }],
            totalMin:  newTotalMin,
            totalCost: node.totalCost + (MODAL_FARE[interTrip.modal] ?? MODAL_FARE.bus),
            transfers: node.transfers + 1,
          });
        }
      }
    }

    queue = nextQueue;
    if (foundRoutes.length >= 5) break;
  }

  return foundRoutes;
}

async function getNearbyStopsAlongRoute(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number
): Promise<NearbyStop[]> {
  const midLat    = (originLat + destLat) / 2;
  const midLng    = (originLng + destLng) / 2;
  const totalDist = haversineM(originLat, originLng, destLat, destLng);
  const radius    = Math.max(totalDist / 2, 1000);

  const res = await pool.query(
    `SELECT
       stop_id AS id,
       stop_name AS name,
       stop_lat AS lat,
       stop_lon AS lng,
       'bus' AS modal,
       ROUND(ST_Distance(
         geom::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
       ))::int AS distance_m
     FROM gtfs_stops
     WHERE ST_DWithin(
       geom::geography,
       ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
       $3
     )
     ORDER BY distance_m
     LIMIT 20`,
    [midLat, midLng, radius]
  );

  return res.rows;
}

function sortByPriority(routes: RouteOption[], priority: Priority): RouteOption[] {
  return [...routes].sort((a, b) => {
    if (priority === 'faster')         return a.summary.total_minutes      - b.summary.total_minutes;
    if (priority === 'cheaper')        return a.summary.estimated_cost_brl - b.summary.estimated_cost_brl;
    if (priority === 'less_transfers') return a.summary.transfers          - b.summary.transfers;
    return 0;
  });
}

export async function calculateRoutes(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number,
  priority:  Priority
): Promise<RouteOption[]> {
  const [originStops, destStops] = await Promise.all([
    getNearbyStops(originLat, originLng, false),  // origem: LIMIT 40
    getNearbyStops(destLat,   destLng,   true),   // destino: LIMIT 60
  ]);

  if (originStops.length === 0 || destStops.length === 0) {
    throw new Error('Nenhum ponto de embarque encontrado próximo à origem ou destino.');
  }

  const routes = await bfsRoutes(originStops, destStops, priority);

  if (routes.length === 0) {
    throw new Error('Nenhuma rota encontrada entre os pontos informados.');
  }

  return sortByPriority(routes, priority).slice(0, 5);
}
