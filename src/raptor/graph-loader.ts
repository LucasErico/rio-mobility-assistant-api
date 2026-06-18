import { pool } from '../db';
import type { TransitGraph, RaptorStop, RaptorRoute, Footpath } from './types';

// Singleton em memoria — carregado uma vez no boot, reutilizado em todas as requests
let cachedGraph: TransitGraph | null = null;
let loadingPromise: Promise<TransitGraph> | null = null;

export async function getTransitGraph(): Promise<TransitGraph> {
  if (cachedGraph) return cachedGraph;

  // FIX-13: promise coalescing — evita race condition no boot com requests paralelos
  if (loadingPromise) return loadingPromise;

  loadingPromise = buildGraph().then(g => {
    cachedGraph     = g;
    loadingPromise  = null;
    return g;
  });
  return loadingPromise;
}

// Invalida o cache (util para testes ou reload manual via endpoint admin)
export function invalidateGraphCache(): void {
  cachedGraph = null;
}

async function buildGraph(): Promise<TransitGraph> {
  console.log('[RAPTOR] Carregando grafo em memoria...');
  const t0 = Date.now();

  const [stops, routes, footpaths] = await Promise.all([
    loadStops(),
    loadRoutes(),
    loadFootpaths(),
  ]);

  // Indice reverso: stop -> quais rotas passam por ele
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

  // Paradas GTFS (bus, brt — estao em gtfs_stops)
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

  // FIX-08: paradas virtuais (metro/trem/VLT) buscam coords reais das
  // tabelas de origem (metro_stations, train_stations, vlt_stops) via
  // station_ref_id + station_ref_modal. Antes usava transit_hubs (lookup
  // por nome, impreciso) ou coords hardcoded (Centro fallback).
  const railRes = await pool.query<{
    route_id: number; line_code: string; modal: string;
    stop_sequence: number; station_name: string;
    station_ref_id: number | null; station_ref_modal: string | null;
  }>(`
    SELECT vrs.route_id, vrr.line_code, vrr.modal,
           vrs.stop_sequence, vrs.station_name,
           vrs.station_ref_id, vrs.station_ref_modal
    FROM public.virtual_rail_structure vrs
    JOIN public.virtual_rail_routes vrr ON vrr.id = vrs.route_id
    ORDER BY vrs.route_id, vrs.stop_sequence
  `);

  // Carrega coords reais das tres tabelas de estacoes em um unico mapa
  const stationCoords = new Map<string, { lat: number; lng: number }>();

  const [metroRes, trainRes, vltRes] = await Promise.all([
    pool.query<{ id: number; lat: string; lng: string }>(
      `SELECT id, stop_lat::float AS lat, stop_lon::float AS lng FROM public.metro_stations`
    ),
    pool.query<{ id: number; lat: string; lng: string }>(
      `SELECT id, stop_lat::float AS lat, stop_lon::float AS lng FROM public.train_stations`
    ),
    pool.query<{ id: number; lat: string; lng: string }>(
      `SELECT id, stop_lat::float AS lat, stop_lon::float AS lng FROM public.vlt_stops`
    ),
  ]);
  for (const r of metroRes.rows) stationCoords.set(`metro:${r.id}`, { lat: Number(r.lat), lng: Number(r.lng) });
  for (const r of trainRes.rows) stationCoords.set(`trem:${r.id}`,  { lat: Number(r.lat), lng: Number(r.lng) });
  for (const r of vltRes.rows)   stationCoords.set(`vlt:${r.id}`,   { lat: Number(r.lat), lng: Number(r.lng) });

  for (const row of railRes.rows) {
    const virtualId = `rail:${row.line_code}:${row.stop_sequence}`;
    if (stops.has(virtualId)) continue;

    // Busca coords da tabela correta via station_ref_id + station_ref_modal
    const coordKey = row.station_ref_id && row.station_ref_modal
      ? `${row.station_ref_modal}:${row.station_ref_id}`
      : null;
    const coords = (coordKey ? stationCoords.get(coordKey) : null) ??
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

// ── Carrega rotas: GTFS (via adjacency) + virtual rail ─────────────────────
async function loadRoutes(): Promise<Map<string, RaptorRoute>> {
  const routes = new Map<string, RaptorRoute>();

  // FIX-10: headways reais do gtfs_frequencies por route_id (mediana pico)
  // Carregados antes de montar as rotas para usar no fareMap
  const freqRes = await pool.query<{ route_id: string; avg_headway: string }>(`
    SELECT t.route_id, ROUND(AVG(f.headway_secs))::text AS avg_headway
    FROM gtfs_frequencies f
    JOIN gtfs_trips t ON t.trip_id = f.trip_id
    WHERE f.start_time >= '06:00:00' AND f.end_time <= '22:00:00'
    GROUP BY t.route_id
  `);
  const headwayByRoute = new Map<string, number>();
  for (const row of freqRes.rows) {
    headwayByRoute.set(row.route_id, Number(row.avg_headway));
  }

  // FIX-01: mapa correto de route_type -> modal
  // 0=VLT, 1=Metro, 2=Trem, 700=bus generico, 702=BRT SPPO, 200=bus_express
  const adjRes = await pool.query<{
    route_id: string; route_name: string; modal: string;
    from_stop_id: string; to_stop_id: string; stop_sequence: number;
  }>(`
    SELECT
      ra.route_id,
      COALESCE(r.route_short_name, r.route_long_name) AS route_name,
      CASE r.route_type
        WHEN 0   THEN 'vlt'
        WHEN 1   THEN 'metro'
        WHEN 2   THEN 'trem'
        WHEN 700 THEN 'bus'
        WHEN 702 THEN 'brt'
        WHEN 200 THEN 'bus_express'
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

  // FIX-02: fareMap completo incluindo bus_express e train
  const fareMap: Record<string, number> = {
    metro:       7.90,
    trem:        7.60,
    train:       7.60,
    brt:         5.00,
    vlt:         5.00,
    bus:         5.00,
    bus_express: 23.00,
  };

  for (const [routeId, data] of routeAdjMap.entries()) {
    data.edges.sort((a, b) => a.seq - b.seq);
    const stops: string[] = [];
    for (const edge of data.edges) {
      if (stops.length === 0) stops.push(edge.from);
      stops.push(edge.to);
    }

    // FIX-10: usa headway real se disponivel, senso fallback por modal
    const defaultHeadway = data.modal === 'metro' ? 240 :
                           data.modal === 'brt'   ? 360 :
                           data.modal === 'trem'  ? 600 : 720;
    const headwaySec = headwayByRoute.get(routeId) ?? defaultHeadway;

    routes.set(routeId, {
      routeId,
      routeName:  data.name,
      modal:      data.modal,
      stops,
      headwaySec,
      faresBrl:   fareMap[data.modal] ?? 5.00,
    });
  }

  // ── Virtual rail routes (metro/trem/VLT) ─────────────────────────────
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

// ── Carrega footpaths (baldeacoes a pe pre-computadas) ────────────────────
// FIX-09: gtfs_transfers_multimodal.from_stop_id contem nomes de estacoes
// (ex: "Central"), mas o grafo usa IDs virtuais (rail:L2:5).
// Resolvemos o mapeamento nome->ID via JOIN com virtual_rail_structure.
async function loadFootpaths(): Promise<Footpath[]> {
  const res = await pool.query<{
    from_virtual_id: string; to_virtual_id: string; walk_seconds: number;
  }>(`
    SELECT
      COALESCE('rail:' || vrr_from.line_code || ':' || vrs_from.stop_sequence,
               gtm.from_stop_id) AS from_virtual_id,
      COALESCE('rail:' || vrr_to.line_code   || ':' || vrs_to.stop_sequence,
               gtm.to_stop_id)   AS to_virtual_id,
      gtm.walk_seconds
    FROM public.gtfs_transfers_multimodal gtm
    -- tenta resolver from_stop_id como nome de estacao virtual
    LEFT JOIN public.virtual_rail_structure vrs_from
           ON vrs_from.station_name ILIKE gtm.from_stop_id
    LEFT JOIN public.virtual_rail_routes vrr_from
           ON vrr_from.id = vrs_from.route_id
    -- tenta resolver to_stop_id como nome de estacao virtual
    LEFT JOIN public.virtual_rail_structure vrs_to
           ON vrs_to.station_name ILIKE gtm.to_stop_id
    LEFT JOIN public.virtual_rail_routes vrr_to
           ON vrr_to.id = vrs_to.route_id
    WHERE gtm.walk_seconds <= 1800
    ORDER BY gtm.walk_seconds
  `);

  // Footpaths sao bidirecionais
  const footpaths: Footpath[] = [];
  for (const row of res.rows) {
    footpaths.push({ fromStopId: row.from_virtual_id, toStopId: row.to_virtual_id, walkSec: row.walk_seconds });
    footpaths.push({ fromStopId: row.to_virtual_id, toStopId: row.from_virtual_id, walkSec: row.walk_seconds });
  }
  return footpaths;
}
