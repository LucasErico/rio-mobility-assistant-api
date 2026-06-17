import { pool } from '../db';
import type { TransitGraph, RaptorStop, RaptorRoute, Footpath } from './types';

// Singleton em memória — carregado uma vez no boot, reutilizado em todas as requests
let cachedGraph: TransitGraph | null = null;
let loadingPromise: Promise<TransitGraph> | null = null;

export async function getTransitGraph(): Promise<TransitGraph> {
  if (cachedGraph) return cachedGraph;

  // Evita carregar em paralelo se múltiplos requests chegarem durante o boot
  if (loadingPromise) return loadingPromise;

  loadingPromise = buildGraph();
  cachedGraph = await loadingPromise;
  loadingPromise = null;
  return cachedGraph;
}

// Invalida o cache (útil para testes ou reload manual via endpoint admin)
export function invalidateGraphCache(): void {
  cachedGraph = null;
}

async function buildGraph(): Promise<TransitGraph> {
  console.log('[RAPTOR] Carregando grafo em memória...');
  const t0 = Date.now();

  const [stops, routes, footpaths] = await Promise.all([
    loadStops(),
    loadRoutes(),
    loadFootpaths(),
  ]);

  // Índice reverso: stop → quais rotas passam por ele
  const stopRoutes = new Map<string, string[]>();
  for (const [routeId, route] of routes.entries()) {
    for (const stopId of route.stops) {
      if (!stopRoutes.has(stopId)) stopRoutes.set(stopId, []);
      stopRoutes.get(stopId)!.push(routeId);
    }
  }

  const graph: TransitGraph = { stops, routes, stopRoutes, footpaths };

  console.log(
    `[RAPTOR] Grafo pronto em ${Date.now() - t0}ms — ` +
    `${stops.size} stops | ${routes.size} rotas | ${footpaths.length} footpaths`
  );

  return graph;
}

// ── Carrega todas as paradas (GTFS bus/brt + virtual rail metro/trem/VLT) ──────
async function loadStops(): Promise<Map<string, RaptorStop>> {
  const stops = new Map<string, RaptorStop>();

  // Paradas GTFS (bus, brt — estão em gtfs_stops)
  const gtfsRes = await pool.query<{
    stop_id: string; stop_name: string; lat: string; lng: string;
  }>(`
    SELECT stop_id, stop_name,
           ST_Y(geom::geometry)::float AS lat,
           ST_X(geom::geometry)::float AS lng
    FROM public.gtfs_stops
    WHERE geom IS NOT NULL
  `);
  for (const row of gtfsRes.rows) {
    stops.set(row.stop_id, {
      stopId: row.stop_id,
      name:   row.stop_name,
      lat:    Number(row.lat),
      lng:    Number(row.lng),
    });
  }

  // Paradas virtuais (metro/trem/VLT — estão em virtual_rail_structure)
  // Usamos o station_name como stopId virtual (prefixado para evitar colisão)
  const railRes = await pool.query<{
    route_id: number; line_code: string; modal: string;
    stop_sequence: number; station_name: string;
    station_ref_id: number | null;
  }>(`
    SELECT vrs.route_id, vrr.line_code, vrr.modal,
           vrs.stop_sequence, vrs.station_name, vrs.station_ref_id
    FROM public.virtual_rail_structure vrs
    JOIN public.virtual_rail_routes vrr ON vrr.id = vrs.route_id
    ORDER BY vrs.route_id, vrs.stop_sequence
  `);

  // Resolve coords das estações virtuais via transit_hubs (curadoria manual)
  const hubRes = await pool.query<{
    name: string; lat: string; lng: string;
  }>(`
    SELECT name,
           ST_Y(geom::geometry)::float AS lat,
           ST_X(geom::geometry)::float AS lng
    FROM public.transit_hubs
  `);
  const hubCoords = new Map<string, { lat: number; lng: number }>();
  for (const h of hubRes.rows) {
    hubCoords.set(h.name.toLowerCase().trim(), {
      lat: Number(h.lat), lng: Number(h.lng),
    });
  }

  for (const row of railRes.rows) {
    const virtualId = `rail:${row.line_code}:${row.stop_sequence}`;
    if (stops.has(virtualId)) continue;

    const coords = hubCoords.get(row.station_name.toLowerCase().trim()) ??
                   { lat: -22.9035, lng: -43.1731 }; // fallback Centro RJ

    stops.set(virtualId, {
      stopId: virtualId,
      name:   row.station_name,
      lat:    coords.lat,
      lng:    coords.lng,
    });
  }

  return stops;
}

// ── Carrega rotas: GTFS (via adjacency) + virtual rail ────────────────────────
async function loadRoutes(): Promise<Map<string, RaptorRoute>> {
  const routes = new Map<string, RaptorRoute>();

  // ── GTFS routes (bus, brt) — via gtfs_route_adjacency ─────────────────────
  const adjRes = await pool.query<{
    route_id: string; route_name: string; modal: string;
    from_stop_id: string; to_stop_id: string; stop_sequence: number;
  }>(`
    SELECT
      ra.route_id,
      COALESCE(r.route_short_name, r.route_long_name) AS route_name,
      CASE r.route_type
        WHEN 1   THEN 'metro'
        WHEN 2   THEN 'trem'
        WHEN 0   THEN 'vlt'
        WHEN 700 THEN 'brt'
        ELSE          'bus'
      END AS modal,
      ra.from_stop_id,
      ra.to_stop_id,
      ra.stop_sequence
    FROM public.gtfs_route_adjacency ra
    JOIN public.gtfs_trips t  ON t.trip_id  = ra.trip_id
    JOIN public.gtfs_routes r ON r.route_id = t.route_id
    ORDER BY ra.route_id, ra.stop_sequence
  `);

  const routeAdjMap = new Map<string, {
    name: string; modal: string;
    edges: { from: string; to: string; seq: number }[];
  }>();
  for (const row of adjRes.rows) {
    if (!routeAdjMap.has(row.route_id)) {
      routeAdjMap.set(row.route_id, { name: row.route_name, modal: row.modal, edges: [] });
    }
    routeAdjMap.get(row.route_id)!.edges.push({
      from: row.from_stop_id, to: row.to_stop_id, seq: row.stop_sequence,
    });
  }

  const fareMap: Record<string, number> = {
    metro: 7.90, trem: 7.60, brt: 5.00, vlt: 5.00, bus: 5.00,
  };

  for (const [routeId, data] of routeAdjMap.entries()) {
    data.edges.sort((a, b) => a.seq - b.seq);
    const stops: string[] = [];
    for (const edge of data.edges) {
      if (stops.length === 0) stops.push(edge.from);
      stops.push(edge.to);
    }
    routes.set(routeId, {
      routeId,
      routeName:  data.name,
      modal:      data.modal,
      stops,
      headwaySec: data.modal === 'metro' ? 240 :
                  data.modal === 'brt'   ? 360 :
                  data.modal === 'trem'  ? 600 : 720,
      faresBrl:   fareMap[data.modal] ?? 5.00,
    });
  }

  // ── Virtual rail routes (metro/trem/VLT) ──────────────────────────────────
  const railRes = await pool.query<{
    route_id: number; line_code: string; line_name: string; modal: string;
    fare_brl: string; headway_sec: number | null;
    stop_sequence: number; station_name: string;
  }>(`
    SELECT
      vrs.route_id,
      vrr.line_code,
      vrr.line_name,
      vrr.modal,
      vrr.fare_brl::text,
      vrf.headway_seconds AS headway_sec,
      vrs.stop_sequence,
      vrs.station_name
    FROM public.virtual_rail_structure vrs
    JOIN public.virtual_rail_routes vrr ON vrr.id = vrs.route_id
    LEFT JOIN public.virtual_rail_frequency vrf
           ON vrf.route_id = vrs.route_id
          AND vrf.period_name = 'entrepico'
    ORDER BY vrs.route_id, vrs.stop_sequence
  `);

  const railMap = new Map<string, {
    lineCode: string; lineName: string; modal: string;
    fare: number; headway: number; stops: string[];
  }>();
  for (const row of railRes.rows) {
    const key = String(row.route_id);
    if (!railMap.has(key)) {
      railMap.set(key, {
        lineCode: row.line_code,
        lineName: row.line_name,
        modal:    row.modal,
        fare:     Number(row.fare_brl),
        headway:  row.headway_sec ?? (row.modal === 'metro' ? 240 : row.modal === 'vlt' ? 480 : 600),
        stops:    [],
      });
    }
    railMap.get(key)!.stops.push(`rail:${row.line_code}:${row.stop_sequence}`);
  }

  for (const [, data] of railMap.entries()) {
    const routeId = `rail:${data.lineCode}`;
    routes.set(routeId, {
      routeId,
      routeName:  data.lineName,
      modal:      data.modal,
      stops:      data.stops,
      headwaySec: data.headway,
      faresBrl:   data.fare,
    });
  }

  return routes;
}

// ── Carrega footpaths (baldeações a pé pré-computadas) ───────────────────────
async function loadFootpaths(): Promise<Footpath[]> {
  const res = await pool.query<{
    from_stop_id: string; to_stop_id: string; walk_seconds: number;
  }>(`
    SELECT from_stop_id, to_stop_id, walk_seconds
    FROM public.gtfs_transfers_multimodal
    WHERE walk_seconds <= 1800
    ORDER BY walk_seconds
  `);

  // Footpaths são bidirecionais
  const footpaths: Footpath[] = [];
  for (const row of res.rows) {
    footpaths.push({ fromStopId: row.from_stop_id, toStopId: row.to_stop_id, walkSec: row.walk_seconds });
    footpaths.push({ fromStopId: row.to_stop_id, toStopId: row.from_stop_id, walkSec: row.walk_seconds });
  }
  return footpaths;
}
