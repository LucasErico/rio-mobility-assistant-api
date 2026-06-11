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

const SEARCH_RADIUS_M = 600;

export async function getNearbyStops(lat: number, lng: number): Promise<NearbyStop[]> {
  const results: NearbyStop[] = [];

  // GTFS bus stops
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
    LIMIT 20
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...busResult.rows);

  // Metro stations — usa is_active (coluna real da tabela metro_stations)
  const metroResult = await pool.query(`
    SELECT
      id::text AS id,
      name,
      ST_Y(geom::geometry) AS lat,
      ST_X(geom::geometry) AS lng,
      'metro' AS modal,
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
    LIMIT 5
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...metroResult.rows);

  // Train stations — sem filtro de status (coluna não existe na tabela)
  const trainResult = await pool.query(`
    SELECT
      id::text AS id,
      name,
      ST_Y(geom::geometry) AS lat,
      ST_X(geom::geometry) AS lng,
      'train' AS modal,
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
    LIMIT 5
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...trainResult.rows);

  // VLT stops — in_operation existe na tabela, sem alteração
  const vltResult = await pool.query(`
    SELECT
      id::text AS id,
      name,
      ST_Y(geom::geometry) AS lat,
      ST_X(geom::geometry) AS lng,
      'vlt' AS modal,
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
    LIMIT 5
  `, [lat, lng, SEARCH_RADIUS_M]);
  results.push(...vltResult.rows);

  return results.sort((a, b) => a.distance_m - b.distance_m);
}
