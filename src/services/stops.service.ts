import { pool } from '../db';

export type ModalType = 'bus' | 'metro' | 'train' | 'vlt';

export interface NearbyStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  modal: ModalType;
  distance_m: number;
}

const SEARCH_RADIUS_M = 1000;

// Para origem: LIMIT 40 (performance - não precisamos de todos)
// Para destino: LIMIT 60 (cobertura - terminais como Alvorada têm 46+ plataformas)
export async function getNearbyStops(
  lat: number,
  lng: number,
  isDestination = false
): Promise<NearbyStop[]> {
  const results: NearbyStop[] = [];
  const busLimit = isDestination ? 60 : 40;

  // GTFS bus/BRT
  const busResult = await pool.query(`
    SELECT
      stop_id   AS id,
      stop_name AS name,
      stop_lat  AS lat,
      stop_lon  AS lng,
      'bus'     AS modal,
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
    LIMIT $4
  `, [lat, lng, SEARCH_RADIUS_M, busLimit]);
  results.push(...busResult.rows);

  // Metro stations
  const metroResult = await pool.query(`
    SELECT
      id::text                  AS id,
      name,
      ST_Y(geom::geometry)      AS lat,
      ST_X(geom::geometry)      AS lng,
      'metro'                   AS modal,
      ROUND(ST_Distance(
        geom::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      ))::int AS distance_m
    FROM metro_stations
    WHERE (is_active = true OR is_active IS NULL)
      AND ST_DWithin(
        geom::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
    ORDER BY distance_m
    LIMIT 10
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...metroResult.rows);

  // Train stations
  const trainResult = await pool.query(`
    SELECT
      id::text                  AS id,
      name,
      ST_Y(geom::geometry)      AS lat,
      ST_X(geom::geometry)      AS lng,
      'train'                   AS modal,
      ROUND(ST_Distance(
        geom::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      ))::int AS distance_m
    FROM train_stations
    WHERE ST_DWithin(
      geom::geography,
      ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
      $3
    )
    ORDER BY distance_m
    LIMIT 10
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...trainResult.rows);

  // VLT stops
  const vltResult = await pool.query(`
    SELECT
      id::text                  AS id,
      name,
      ST_Y(geom::geometry)      AS lat,
      ST_X(geom::geometry)      AS lng,
      'vlt'                     AS modal,
      ROUND(ST_Distance(
        geom::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      ))::int AS distance_m
    FROM vlt_stops
    WHERE ST_DWithin(
      geom::geography,
      ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
      $3
    )
    ORDER BY distance_m
    LIMIT 10
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...vltResult.rows);

  return results.sort((a, b) => a.distance_m - b.distance_m);
}
