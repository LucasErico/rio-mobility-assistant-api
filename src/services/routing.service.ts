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

// Tarifas 2026 corrigidas
// bus/brt/vlt: R$ 5,00 | metro: R$ 7,90 (tarifa cheia Jaé) | train: R$ 7,60 (tarifa cheia Riocard)
const MODAL_FARE: Record<string, number> = {
  bus:   5.00,
  metro: 7.90,
  train: 7.60,
  vlt:   5.00,
  brt:   5.00,
};

// Velocidade média em metros por minuto por modal
const MODAL_SPEED_M_PER_MIN: Record<string, number> = {
  bus:   250,  // ~15 km/h considerando paradas
  brt:   400,  // ~24 km/h corredor exclusivo
  metro: 500,  // ~30 km/h
  train: 500,
  vlt:   300,
};

const WALK_SPEED_M_PER_MIN = 80;   // ~5 km/h
const WALK_TRANSFER_MAX_M  = 400;  // caminhada máxima para baldeação a pé
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

// ─── Shape real da trip ───────────────────────────────────────────────────────
async function getShapeForTrip(
  tripId: string,
  fromStopId: string,
  toStopId: string
): Promise<{ lat: number; lng: number }[]> {
  try {
    // Pega shape_id e sequências das paradas
    const tripRes = await pool.query(
      `SELECT t.shape_id, st.stop_sequence, st.stop_id
       FROM gtfs_trips t
       JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
       WHERE t.trip_id = $1 AND st.stop_id = ANY($2)
       ORDER BY st.stop_sequence`,
      [tripId, [fromStopId, toStopId]]
    );

    if (!tripRes.rows.length || !tripRes.rows[0].shape_id) return [];

    const shapeId = tripRes.rows[0].shape_id;
    const seqFrom = tripRes.rows.find((r: any) => r.stop_id === fromStopId)?.stop_sequence ?? 0;
    const seqTo   = tripRes.rows.find((r: any) => r.stop_id === toStopId)?.stop_sequence ?? 999999;

    // Estima faixa de shape_pt_sequence proporcional
    const totalSeqRes = await pool.query(
      `SELECT MIN(shape_pt_sequence) AS mn, MAX(shape_pt_sequence) AS mx,
              COUNT(*)::int AS total
       FROM gtfs_shapes WHERE shape_id = $1`,
      [shapeId]
    );
    const { mn, mx } = totalSeqRes.rows[0];

    // Busca sequência total de paradas da trip
    const totalStopsRes = await pool.query(
      `SELECT MAX(stop_sequence) AS max_seq FROM gtfs_stop_times WHERE trip_id = $1`,
      [tripId]
    );
    const maxStopSeq = totalStopsRes.rows[0]?.max_seq ?? 100;

    const shapePtFrom = Math.floor(mn + (seqFrom / maxStopSeq) * (mx - mn));
    const shapePtTo   = Math.ceil (mn + (seqTo   / maxStopSeq) * (mx - mn));

    const shapeRes = await pool.query(
      `SELECT shape_pt_lat AS lat, shape_pt_lon AS lng
       FROM gtfs_shapes
       WHERE shape_id = $1
         AND shape_pt_sequence BETWEEN $2 AND $3
       ORDER BY shape_pt_sequence
       LIMIT 200`,
      [shapeId, shapePtFrom, shapePtTo]
    );

    return shapeRes.rows.map((r: any) => ({ lat: Number(r.lat), lng: Number(r.lng) }));
  } catch {
    return [];
  }
}

// ─── Trips que saem de um stop e chegam em qualquer stop de um conjunto ───────
// Cache por request: evita queries repetidas para o mesmo stopId dentro do mesmo BFS
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

  // Chave de cache: stopId + destinos ordenados
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

// Tempo de espera + viagem para uma trip
// Cache por request: evita queries repetidas para o mesmo tripId
async function estimateTravelMinutes(
  tripId: string,
  stopCount: number,
  modal: string,
  fromStopId: string,
  toStopId: string,
  freqCache: Map<string, number>
): Promise<number> {
  // Distância real entre as paradas via coordenadas
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
  } catch { /* usa fallback */ }

  const speed     = MODAL_SPEED_M_PER_MIN[modal] ?? 250;
  const travelMin = distM > 0
    ? Math.ceil(distM / speed)
    : stopCount * (modal === 'brt' ? 1.5 : 2);

  // Tempo de espera via headway — cache para evitar query repetida por tripId
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

// ─── Estrutura de nó do BFS ───────────────────────────────────────────────────
interface BfsNode {
  stopId:   string;
  stop:     NearbyStop;
  legs:     RouteLeg[];
  totalMin: number;
  totalCost: number;
  transfers: number;
}

// ─── BFS principal ────────────────────────────────────────────────────────────
async function bfsRoutes(
  originStops: NearbyStop[],
  destStops:   NearbyStop[],
  priority:    Priority
): Promise<RouteOption[]> {
  const destStopIds  = new Set(destStops.map(s => s.id));
  const destStopMap  = new Map(destStops.map(s => [s.id, s]));
  const foundRoutes: RouteOption[] = [];
  const seenFingerprints = new Set<string>();

  // Caches por request — eliminam queries repetidas durante o BFS
  const tripsCache: Map<string, any[]> = new Map();
  const freqCache:  Map<string, number> = new Map();

  // Fila BFS: começa com todos os stops de origem
  let queue: BfsNode[] = originStops.map(s => ({
    stopId:    s.id,
    stop:      s,
    legs:      [],
    totalMin:  walkMinutes(s.distance_m),
    totalCost: 0,
    transfers: 0,
  }));

  const visited = new Map<string, number>(); // stopId → melhor totalMin

  while (queue.length > 0) {
    const nextQueue: BfsNode[] = [];

    for (const node of queue) {
      if (node.transfers > MAX_TRANSFERS) continue;

      const nearDestIds = destStops.map(s => s.id);

      // Chegada a pé ao destino a partir deste nó
      const walkableDestIds = destStops
        .filter(ds => haversineM(node.stop.lat, node.stop.lng, ds.lat, ds.lng) <= WALK_TRANSFER_MAX_M)
        .map(ds => ds.id);

      if (walkableDestIds.length > 0) {
        for (const dId of walkableDestIds) {
          const ds = destStopMap.get(dId)!;
          const walkM = haversineM(node.stop.lat, node.stop.lng, ds.lat, ds.lng);
          const route: RouteOption = {
            legs: node.legs,
            summary: {
              total_minutes:      node.totalMin + walkMinutes(walkM),
              transfers:          Math.max(0, node.legs.length - 1), // corrigido: transfers = legs - 1
              estimated_cost_brl: node.totalCost,
            },
          };
          const fp = node.legs.map(l => l.route_name + l.from_stop).join('|');
          if (!seenFingerprints.has(fp)) {
            seenFingerprints.add(fp);
            foundRoutes.push(route);
          }
        }
      }

      // Trips diretas para stops de destino
      const trips = await getTripsFromStop(node.stopId, nearDestIds, tripsCache);

      for (const trip of trips.slice(0, 5)) {
        const destStop  = destStopMap.get(trip.dest_stop_id)!;
        const travelMin = await estimateTravelMinutes(
          trip.trip_id, trip.stop_count, trip.modal,
          node.stopId, trip.dest_stop_id,
          freqCache
        );
        const shapeCoords = await getShapeForTrip(trip.trip_id, node.stopId, trip.dest_stop_id);
        const walkDest    = walkMinutes(destStop.distance_m);
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
        const newMin   = node.totalMin + travelMin + walkDest;
        const newCost  = node.totalCost + fare;
        const newTrans = Math.max(0, newLegs.length - 1); // corrigido: transfers = legs - 1

        const fp = newLegs.map(l => l.route_name + l.from_stop).join('|');
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          foundRoutes.push({
            legs: newLegs,
            summary: { total_minutes: newMin, transfers: newTrans, estimated_cost_brl: newCost },
          });
        }
      }

      // Expansão BFS para próxima camada (baldeações)
      if (node.transfers < MAX_TRANSFERS) {
        const intermediateStops = await getNearbyStopsAlongRoute(
          node.stop.lat, node.stop.lng,
          destStops[0]?.lat ?? node.stop.lat,
          destStops[0]?.lng ?? node.stop.lng
        );

        for (const interStop of intermediateStops.slice(0, 8)) {
          if (interStop.id === node.stopId) continue;
          const prevBest = visited.get(interStop.id) ?? Infinity;
          const interTrips = await getTripsFromStop(node.stopId, [interStop.id], tripsCache);
          if (interTrips.length === 0) continue;

          const interTrip   = interTrips[0];
          const interMin    = await estimateTravelMinutes(
            interTrip.trip_id, interTrip.stop_count, interTrip.modal,
            node.stopId, interStop.id,
            freqCache
          );
          const interShape  = await getShapeForTrip(interTrip.trip_id, node.stopId, interStop.id);
          const newTotalMin = node.totalMin + interMin;

          if (newTotalMin >= prevBest) continue;
          visited.set(interStop.id, newTotalMin);

          const interLeg: RouteLeg = {
            modal:             interTrip.modal,
            route_name:        interTrip.route_name,
            from_stop:         node.stop.name,
            to_stop:           interStop.name,
            from_coords:       { lat: node.stop.lat,  lng: node.stop.lng  },
            to_coords:         { lat: interStop.lat,  lng: interStop.lng  },
            shape_coords:      interShape,
            estimated_minutes: interMin,
            walk_to_stop_m:    node.stop.distance_m,
          };

          nextQueue.push({
            stopId:    interStop.id,
            stop:      interStop,
            legs:      [...node.legs, interLeg],
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

// Busca paradas intermediárias ao longo do vetor origem→destino
async function getNearbyStopsAlongRoute(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number
): Promise<NearbyStop[]> {
  const midLat = (originLat + destLat) / 2;
  const midLng = (originLng + destLng) / 2;
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
    getNearbyStops(originLat, originLng),
    getNearbyStops(destLat,   destLng),
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
