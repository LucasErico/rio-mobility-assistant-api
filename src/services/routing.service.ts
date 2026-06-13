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

// Tarifas 2026
const MODAL_FARE: Record<string, number> = {
  bus:   5.00,
  metro: 7.90,
  train: 7.60,
  vlt:   5.00,
  brt:   5.00,
};

// Velocidade média em metros/min por modal
const MODAL_SPEED_M_PER_MIN: Record<string, number> = {
  bus:   250,   // ~15 km/h
  brt:   450,   // ~27 km/h corredor exclusivo
  metro: 600,   // ~36 km/h
  train: 550,
  vlt:   300,
};

// Bonus de penalidade/preferência por modal (minutos adicionados ao score)
// Negativo = preferido, positivo = penalizado
const MODAL_SPEED_BONUS: Record<string, number> = {
  brt:   -5,   // BRT é mais rápido que ônibus comum na mesma distância
  metro: -8,
  train: -3,
  vlt:   -2,
  bus:    0,
};

const WALK_SPEED_M_PER_MIN = 80;
const WALK_TRANSFER_MAX_M  = 500;  // aumentado de 400 para 500m
const MAX_TRANSFERS        = 3;

function walkMinutes(meters: number): number {
  return Math.ceil(meters / WALK_SPEED_M_PER_MIN);
}

function haversineM(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Shape real via ST_LineLocatePoint ────────────────────────────────────────
async function getShapeForTrip(
  tripId: string,
  fromStopId: string,
  toStopId: string
): Promise<{ lat: number; lng: number }[]> {
  try {
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

    const shapeId = stopsRes.rows[0].shape_id;
    const fromRow = stopsRes.rows.find((r: any) => r.stop_id === fromStopId);
    const toRow   = stopsRes.rows.find((r: any) => r.stop_id === toStopId);
    if (!fromRow || !toRow) return [];

    const fractionsRes = await pool.query(
      `WITH shape_line AS (
         SELECT ST_MakeLine(
           ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326)
           ORDER BY shape_pt_sequence
         ) AS line
         FROM gtfs_shapes WHERE shape_id = $1
       )
       SELECT
         ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($3,$2),4326)) AS frac_from,
         ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($5,$4),4326)) AS frac_to
       FROM shape_line`,
      [shapeId, fromRow.lat, fromRow.lng, toRow.lat, toRow.lng]
    );

    if (!fractionsRes.rows.length) return [];

    let { frac_from, frac_to } = fractionsRes.rows[0];
    if (frac_from > frac_to) [frac_from, frac_to] = [frac_to, frac_from];

    const shapeRes = await pool.query(
      `WITH shape_line AS (
         SELECT ST_MakeLine(
           ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326)
           ORDER BY shape_pt_sequence
         ) AS line
         FROM gtfs_shapes WHERE shape_id = $1
       )
       SELECT shape_pt_lat AS lat, shape_pt_lon AS lng
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

    return shapeRes.rows.map((r: any) => ({
      lat: Number(r.lat), lng: Number(r.lng),
    }));
  } catch {
    return [];
  }
}

// ─── Trips de um stop para um conjunto de stops de destino ───────────────────
// Retorna até 10 trips, ordenadas por: mais rápido (distância real) primeiro.
// Inclui route_type para que o BFS possa aplicar preferência de modal.
async function getTripsFromStop(
  stopId: string,
  candidateDestStopIds: string[],
  cache: Map<string, any[]>
): Promise<{
  trip_id: string;
  route_name: string;
  modal: string;
  route_type: number;
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
         WHEN 1   THEN 'metro'
         WHEN 2   THEN 'train'
         WHEN 0   THEN 'vlt'
         WHEN 700 THEN 'brt'
         WHEN 702 THEN 'bus'
         WHEN 200 THEN 'bus'
         ELSE          'bus'
       END AS modal,
       r.route_type,
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
     -- Prioriza modais mais rápidos (menor route_type = metro/trem = mais rápido)
     -- Para mesmo route_type, menos paradas intermediárias
     ORDER BY
       CASE r.route_type WHEN 1 THEN 0 WHEN 2 THEN 1 WHEN 700 THEN 2 WHEN 702 THEN 3 ELSE 4 END,
       stop_count
     LIMIT 10`,
    [stopId, candidateDestStopIds]
  );

  cache.set(cacheKey, res.rows);
  return res.rows;
}

// ─── Estimativa de tempo ──────────────────────────────────────────────────────
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
         s1.geom::geography, s2.geom::geography
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

  // Aplica bônus de modal (BRT/metro são mais rápidos que ônibus na prática)
  const speedBonus = MODAL_SPEED_BONUS[modal] ?? 0;

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
      : modal === 'brt' ? 7 : modal === 'metro' ? 5 : 12;
    freqCache.set(tripId, waitMin);
  }

  return Math.max(1, waitMin + travelMin + speedBonus);
}

// ─── Stops ao longo da rota para expansão BFS multi-hop ──────────────────────
// Usa múltiplos pontos da rota (25%, 50%, 75%) em vez de só o midpoint
// para garantir cobertura em rotas longas como Recreio → Candelária (25km)
async function getNearbyStopsAlongRoute(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number,
  alreadyVisited: Set<string>
): Promise<NearbyStop[]> {
  const totalDistM = haversineM(originLat, originLng, destLat, destLng);

  // Pontos de amostragem: 25%, 50%, 75% do trajeto
  const samplePoints = [0.25, 0.50, 0.75].map(frac => ({
    lat: originLat + frac * (destLat - originLat),
    lng: originLng + frac * (destLng - originLng),
  }));

  // Raio adaptativo: maior em trajetos curtos, menor em trajetos longos
  const radius = Math.min(Math.max(totalDistM * 0.15, 800), 2000);

  const allStops: NearbyStop[] = [];
  const seenIds = new Set<string>();

  for (const pt of samplePoints) {
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
       LIMIT 12`,
      [pt.lat, pt.lng, radius]
    );

    for (const row of res.rows) {
      if (!seenIds.has(row.id) && !alreadyVisited.has(row.id)) {
        seenIds.add(row.id);
        allStops.push(row);
      }
    }
  }

  return allStops;
}

// ─── Nó BFS ───────────────────────────────────────────────────────────────────
interface BfsNode {
  stopId:    string;
  stop:      NearbyStop;
  legs:      RouteLeg[];
  totalMin:  number;
  totalCost: number;
  transfers: number;
}

// ─── BFS principal ────────────────────────────────────────────────────────────
async function bfsRoutes(
  originStops: NearbyStop[],
  destStops:   NearbyStop[],
  priority:    Priority
): Promise<RouteOption[]> {
  const destStopMap      = new Map(destStops.map(s => [s.id, s]));
  const foundRoutes:     RouteOption[]   = [];
  const seenFingerprints = new Set<string>();
  const tripsCache:      Map<string, any[]>  = new Map();
  const freqCache:       Map<string, number> = new Map();
  const globalVisited:   Map<string, number> = new Map(); // stopId → melhor totalMin
  const visitedIds:      Set<string> = new Set(originStops.map(s => s.id));

  let queue: BfsNode[] = originStops.map(s => ({
    stopId:    s.id,
    stop:      s,
    legs:      [],
    totalMin:  walkMinutes(s.distance_m),
    totalCost: 0,
    transfers: 0,
  }));

  while (queue.length > 0 && foundRoutes.length < 5) {
    const nextQueue: BfsNode[] = [];

    for (const node of queue) {
      if (node.transfers > MAX_TRANSFERS) continue;

      const nearDestIds = destStops.map(s => s.id);

      // ── Chegada a pé ao destino ──────────────────────────────────────────
      const walkableDestIds = destStops
        .filter(ds =>
          haversineM(node.stop.lat, node.stop.lng, ds.lat, ds.lng) <= WALK_TRANSFER_MAX_M
        )
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
        if (foundRoutes.length >= 5) break;
      }

      // ── Trips diretas origem → destino ────────────────────────────────────
      const trips = await getTripsFromStop(node.stopId, nearDestIds, tripsCache);
      for (const trip of trips.slice(0, 5)) {
        const destStop  = destStopMap.get(trip.dest_stop_id)!;
        const travelMin = await estimateTravelMinutes(
          trip.trip_id, trip.stop_count, trip.modal,
          node.stopId, trip.dest_stop_id, freqCache
        );
        const shapeCoords = await getShapeForTrip(
          trip.trip_id, node.stopId, trip.dest_stop_id
        );
        const fare = MODAL_FARE[trip.modal] ?? MODAL_FARE.bus;

        const leg: RouteLeg = {
          modal:             trip.modal,
          route_name:        trip.route_name,
          from_stop:         node.stop.name,
          to_stop:           destStop.name,
          from_coords:       { lat: node.stop.lat, lng: node.stop.lng },
          to_coords:         { lat: destStop.lat,  lng: destStop.lng  },
          shape_coords:      shapeCoords,
          estimated_minutes: travelMin,
          walk_to_stop_m:    node.stop.distance_m,
        };

        const newLegs = [...node.legs, leg];
        const fp      = newLegs.map(l => l.route_name + l.from_stop).join('|');
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          foundRoutes.push({
            legs: newLegs,
            summary: {
              total_minutes:      node.totalMin + travelMin + walkMinutes(destStop.distance_m),
              transfers:          Math.max(0, newLegs.length - 1),
              estimated_cost_brl: node.totalCost + fare,
            },
          });
          if (foundRoutes.length >= 5) break;
        }
      }

      if (foundRoutes.length >= 5) break;

      // ── Expansão para baldeação ───────────────────────────────────────────
      if (node.transfers < MAX_TRANSFERS) {
        const interStops = await getNearbyStopsAlongRoute(
          node.stop.lat, node.stop.lng,
          destStops[0]?.lat ?? node.stop.lat,
          destStops[0]?.lng ?? node.stop.lng,
          visitedIds
        );

        for (const interStop of interStops.slice(0, 10)) {
          const interTrips = await getTripsFromStop(
            node.stopId, [interStop.id], tripsCache
          );
          if (interTrips.length === 0) continue;

          const interTrip   = interTrips[0];
          const interMin    = await estimateTravelMinutes(
            interTrip.trip_id, interTrip.stop_count, interTrip.modal,
            node.stopId, interStop.id, freqCache
          );
          const newTotalMin = node.totalMin + interMin;

          const prevBest = globalVisited.get(interStop.id) ?? Infinity;
          if (newTotalMin >= prevBest) continue;

          globalVisited.set(interStop.id, newTotalMin);
          visitedIds.add(interStop.id);

          const interShape = await getShapeForTrip(
            interTrip.trip_id, node.stopId, interStop.id
          );

          nextQueue.push({
            stopId:    interStop.id,
            stop:      interStop,
            legs:      [
              ...node.legs,
              {
                modal:             interTrip.modal,
                route_name:        interTrip.route_name,
                from_stop:         node.stop.name,
                to_stop:           interStop.name,
                from_coords:       { lat: node.stop.lat, lng: node.stop.lng },
                to_coords:         { lat: interStop.lat, lng: interStop.lng },
                shape_coords:      interShape,
                estimated_minutes: interMin,
                walk_to_stop_m:    node.stop.distance_m,
              },
            ],
            totalMin:  newTotalMin,
            totalCost: node.totalCost + (MODAL_FARE[interTrip.modal] ?? MODAL_FARE.bus),
            transfers: node.transfers + 1,
          });
        }
      }
    }

    queue = nextQueue;
  }

  return foundRoutes;
}

function sortByPriority(
  routes: RouteOption[],
  priority: Priority
): RouteOption[] {
  return [...routes].sort((a, b) => {
    if (priority === 'faster')
      return a.summary.total_minutes      - b.summary.total_minutes;
    if (priority === 'cheaper')
      return a.summary.estimated_cost_brl - b.summary.estimated_cost_brl;
    if (priority === 'less_transfers')
      return a.summary.transfers          - b.summary.transfers;
    return 0;
  });
}

export async function calculateRoutes(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number,
  priority:  Priority
): Promise<RouteOption[]> {
  const [originStops, destStops] = await Promise.all([
    getNearbyStops(originLat, originLng, false),
    getNearbyStops(destLat,   destLng,   true),
  ]);

  if (originStops.length === 0 || destStops.length === 0) {
    throw new Error(
      'Nenhum ponto de embarque encontrado próximo à origem ou destino.'
    );
  }

  const routes = await bfsRoutes(originStops, destStops, priority);

  if (routes.length === 0) {
    throw new Error(
      'Nenhuma rota encontrada entre os pontos informados.'
    );
  }

  return sortByPriority(routes, priority).slice(0, 5);
}
