import { pool } from '../db';
import { getTransitGraph } from './graph-loader';
import { runRaptor } from './raptor-router';
import type { RouteOption, RouteLeg, Priority } from './types';

// Tarifa correta 2026 por modal — fonte unica (importar daqui em outros modulos)
export const MODAL_FARE: Record<string, number> = {
  bus:         5.00,
  bus_express: 23.00, // linhas 2xxx (ex: 2335 Santa Cruz-Castelo)
  metro:       7.90,
  trem:        7.60,
  train:       7.60,  // alias de trem (consistencia com routing.service.ts)
  vlt:         5.00,
  brt:         5.00,
};

// ── Shape para legs de trilho (metro/trem/VLT) ────────────────────────────
// FIX-07: a query anterior usava vrs.geom (coluna inexistente) e vrs.rail_route_id
// (nome errado — coluna real e route_id). Reescrita para usar somente
// virtual_rail_routes.route_name + virtual_rail_structure.stop_sequence + station_name
// e chamar get_rail_line_polyline(route_id, seq_from, seq_to) diretamente.
async function resolveShapeForLeg(
  leg: RouteLeg
): Promise<{ lat: number; lng: number }[]> {

  if (leg.modal === 'metro' || leg.modal === 'trem' || leg.modal === 'vlt') {
    try {
      // Busca o route_id e as sequencias de parada mais proximas das coords da leg
      // Usa station_name para localizar as paradas (virtual_rail_structure nao tem geom)
      const railRes = await pool.query<{
        route_id: number;
        from_seq: number;
        to_seq: number;
      }>(`
        SELECT
          vrr.id            AS route_id,
          vrs_from.stop_sequence AS from_seq,
          vrs_to.stop_sequence   AS to_seq
        FROM virtual_rail_routes vrr
        JOIN virtual_rail_structure vrs_from ON vrs_from.route_id = vrr.id
        JOIN virtual_rail_structure vrs_to   ON vrs_to.route_id   = vrr.id
        WHERE vrr.route_name = $1
          AND vrs_from.station_name = $2
          AND vrs_to.station_name   = $3
        LIMIT 1
      `, [
        leg.route_name,
        leg.from_stop,
        leg.to_stop,
      ]);

      if (!railRes.rows.length) return [];
      const { route_id, from_seq, to_seq } = railRes.rows[0];

      const pts = await pool.query<{ lat: number; lng: number }>(
        `SELECT lat, lng FROM get_rail_line_polyline($1, $2, $3)`,
        [route_id, from_seq, to_seq]
      );
      return pts.rows.map(r => ({ lat: Number(r.lat), lng: Number(r.lng) }));
    } catch {
      return [];
    }
  }

  // ── Bus/BRT: usa get_precise_trip_polyline (Fase 4) ─────────────────────
  // ST_MakeLine executado UMA unica vez dentro da funcao SQL
  try {
    const tripRes = await pool.query<{ shape_id: string | null }>(`
      SELECT DISTINCT t.shape_id
      FROM gtfs_trips t
      JOIN gtfs_routes r    ON r.route_id = t.route_id
      JOIN gtfs_stop_times st1 ON st1.trip_id = t.trip_id
      JOIN gtfs_stop_times st2 ON st2.trip_id = t.trip_id
      JOIN gtfs_stops s1   ON s1.stop_id = st1.stop_id
      JOIN gtfs_stops s2   ON s2.stop_id = st2.stop_id
      WHERE COALESCE(r.route_short_name, r.route_long_name) = $1
        AND st2.stop_sequence > st1.stop_sequence
        AND ST_DWithin(s1.geom::geography,
          ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, 300)
        AND ST_DWithin(s2.geom::geography,
          ST_SetSRID(ST_MakePoint($5,$4),4326)::geography, 300)
      LIMIT 1
    `, [
      leg.route_name,
      leg.from_coords.lat, leg.from_coords.lng,
      leg.to_coords.lat,   leg.to_coords.lng,
    ]);

    if (!tripRes.rows.length || !tripRes.rows[0].shape_id) return [];

    const pts = await pool.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM get_precise_trip_polyline($1,$2,$3,$4,$5)`,
      [
        tripRes.rows[0].shape_id,
        leg.from_coords.lat, leg.from_coords.lng,
        leg.to_coords.lat,   leg.to_coords.lng,
      ]
    );
    return pts.rows.map(r => ({ lat: Number(r.lat), lng: Number(r.lng) }));
  } catch {
    return [];
  }
}

// ── Entry point publico ──────────────────────────────────────────────────
export async function calculateRoutesRaptor(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number,
  priority:  Priority
): Promise<RouteOption[]> {
  const graph = await getTransitGraph();

  const raw = runRaptor(graph, originLat, originLng, destLat, destLng, priority);

  if (raw.length === 0) {
    throw new Error('Nenhuma rota encontrada entre os pontos informados.');
  }

  const withShapes = await Promise.all(
    raw.map(async route => ({
      ...route,
      legs: await Promise.all(
        route.legs.map(async leg => ({
          ...leg,
          shape_coords: await resolveShapeForLeg(leg),
        }))
      ),
      summary: {
        ...route.summary,
        estimated_cost_brl:
          route.legs.reduce((acc, l) => acc + (MODAL_FARE[l.modal] ?? 5.00), 0),
      },
    }))
  );

  return withShapes;
}
