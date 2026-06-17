import { pool } from '../db';
import { getTransitGraph } from './graph-loader';
import { runRaptor } from './raptor-router';
import type { RouteOption, RouteLeg, Priority } from './types';

// Tarifa correta 2026 por modal
const MODAL_FARE: Record<string, number> = {
  bus:   5.00,
  metro: 7.90,
  trem:  7.60,
  vlt:   5.00,
  brt:   5.00,
};

// ── Shape real para legs de rota GTFS (bus/brt) ───────────────────────────
async function resolveShapeForLeg(
  leg: RouteLeg
): Promise<{ lat: number; lng: number }[]> {
  if (leg.modal === 'metro' || leg.modal === 'trem' || leg.modal === 'vlt') {
    // Para trilhos virtuais retornamos array vazio — o frontend desenha linha reta
    // ou usa a geometria da linha curada. Fase 4 adiciona shapes reais.
    return [];
  }

  try {
    // Busca trip_id para esse par (route_name, from_stop, to_stop)
    const tripRes = await pool.query<{ trip_id: string; shape_id: string | null }>(`
      SELECT DISTINCT t.trip_id, t.shape_id
      FROM gtfs_trips t
      JOIN gtfs_routes r   ON r.route_id = t.route_id
      JOIN gtfs_stop_times st1 ON st1.trip_id = t.trip_id
      JOIN gtfs_stop_times st2 ON st2.trip_id = t.trip_id
      JOIN gtfs_stops s1   ON s1.stop_id = st1.stop_id
      JOIN gtfs_stops s2   ON s2.stop_id = st2.stop_id
      WHERE COALESCE(r.route_short_name, r.route_long_name) = $1
        AND st2.stop_sequence > st1.stop_sequence
        AND ST_DWithin(
          s1.geom::geography,
          ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, 300
        )
        AND ST_DWithin(
          s2.geom::geography,
          ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, 300
        )
      LIMIT 1
    `, [
      leg.route_name,
      leg.from_coords.lat, leg.from_coords.lng,
      leg.to_coords.lat,   leg.to_coords.lng,
    ]);

    if (!tripRes.rows.length || !tripRes.rows[0].shape_id) return [];

    const { trip_id, shape_id } = tripRes.rows[0];

    // Fractions via ST_LineLocatePoint
    const fracRes = await pool.query<{ frac_from: number; frac_to: number }>(`
      WITH shape_line AS (
        SELECT ST_MakeLine(
          ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326)
          ORDER BY shape_pt_sequence
        ) AS line
        FROM gtfs_shapes WHERE shape_id = $1
      )
      SELECT
        ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($3,$2),4326)) AS frac_from,
        ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($5,$4),4326)) AS frac_to
      FROM shape_line
    `, [
      shape_id,
      leg.from_coords.lat, leg.from_coords.lng,
      leg.to_coords.lat,   leg.to_coords.lng,
    ]);

    if (!fracRes.rows.length) return [];
    let { frac_from, frac_to } = fracRes.rows[0];
    if (frac_from > frac_to) [frac_from, frac_to] = [frac_to, frac_from];

    const shapeRes = await pool.query<{ lat: number; lng: number }>(`
      WITH shape_line AS (
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
      LIMIT 250
    `, [shape_id, frac_from, frac_to]);

    return shapeRes.rows.map(r => ({ lat: Number(r.lat), lng: Number(r.lng) }));
  } catch {
    return [];
  }
}

// ── Entry point público — mesma assinatura que o BFS anterior ────────────────
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

  // Resolve shapes em paralelo para todas as legs
  const withShapes = await Promise.all(
    raw.map(async route => ({
      ...route,
      legs: await Promise.all(
        route.legs.map(async leg => ({
          ...leg,
          shape_coords: await resolveShapeForLeg(leg),
          // Corrige tarifa usando o map oficial 2026
          estimated_minutes: leg.estimated_minutes,
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
