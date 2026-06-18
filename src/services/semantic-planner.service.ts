/**
 * semantic-planner.service.ts  — Busca Semântica v2
 *
 * PRINCÍPIO: a busca web recebe LINGUAGEM NATURAL (origem/destino como o
 * usuário os conhece), NUNCA coordenadas. O geocoding ocorre DEPOIS, apenas
 * para traduzir os endereços das legs já identificadas para o RAPTOR.
 *
 * Fontes (paralelas):
 *   A — Jina + You.com (busca web via web-search.ts)
 *   B — Groq LLM com contexto das linhas do banco
 *   C — Hub lookup O(1) — known_terminals do banco
 *
 * Validação cruzada + score de confiança (0-100).
 * Score < 40 em todos → modo degradado (RAPTOR puro, sem waypoints).
 */

import { pool } from '../db';
import { webSearch } from '../utils/web-search';

export interface SemanticLeg {
  leg:           number;
  waypoint_name: string;
  modal:         string;  // 'bus'|'brt'|'metro'|'trem'|'vlt'
  line_code:     string;
}

export interface SemanticPlan {
  legs:       SemanticLeg[];
  score:      number;   // 0-100
  source:     string;   // 'web'|'groq'|'hub'|'degraded'
  degraded:   boolean;
}

// ── Helpers de banco ──────────────────────────────────────────────────────────

async function getKnownLineCodes(): Promise<string[]> {
  try {
    const res = await pool.query<{ code: string }>(`
      SELECT DISTINCT COALESCE(route_short_name, route_long_name) AS code
      FROM gtfs_routes
      WHERE route_short_name IS NOT NULL
        AND LENGTH(route_short_name) <= 12
      LIMIT 200
    `);
    return res.rows.map(r => r.code);
  } catch {
    return [];
  }
}

async function getKnownTerminals(): Promise<{ name: string; lat: number; lng: number; modal: string; aliases: string[] }[]> {
  try {
    const res = await pool.query<{ name: string; lat: number; lng: number; modal: string; aliases: string[] }>(`
      SELECT name, lat, lng, modal, aliases
      FROM known_terminals
      ORDER BY name
    `);
    return res.rows;
  } catch {
    // fallback: tenta transit_hubs se known_terminals ainda não existir
    try {
      const res2 = await pool.query<{ name: string; lat: number; lng: number; modal: string }>(`
        SELECT name, lat, lng, modal FROM transit_hubs ORDER BY name
      `);
      return res2.rows.map(r => ({ ...r, aliases: [] }));
    } catch {
      return [];
    }
  }
}

async function getModalNetworkRoutes(): Promise<{ route_name: string; modal: string }[]> {
  try {
    const res = await pool.query<{ route_name: string; modal: string }>(`
      SELECT DISTINCT route_name, modal FROM modal_network ORDER BY modal, route_name LIMIT 100
    `);
    return res.rows;
  } catch {
    return [];
  }
}

// ── resolveStopFromLeg ────────────────────────────────────────────────────────
// Peça central da v2: dado um código de linha + nome de waypoint,
// encontra o stop_id REAL da linha mais próximo das coords do waypoint.
// Isso substitui o geocoding genérico de waypoints.

export interface ResolvedStop {
  stop_id:   string;
  stop_name: string;
  lat:       number;
  lng:       number;
  distance_m: number;
}

export async function resolveStopFromLeg(
  lineCode:     string,
  waypointName: string
): Promise<ResolvedStop | null> {
  try {
    // 1. Buscar coords do waypoint na known_terminals
    const termRes = await pool.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM known_terminals
       WHERE LOWER(name) = LOWER($1)
          OR LOWER($1) = ANY(SELECT LOWER(a) FROM unnest(aliases) a)
          OR LOWER(name) LIKE '%' || LOWER($1) || '%'
       ORDER BY
         CASE WHEN LOWER(name) = LOWER($1) THEN 0
              WHEN LOWER($1) = ANY(SELECT LOWER(a) FROM unnest(aliases) a) THEN 1
              ELSE 2 END
       LIMIT 1`,
      [waypointName]
    );

    if (termRes.rows.length === 0) {
      console.warn(`[resolveStopFromLeg] "${waypointName}" não encontrado em known_terminals`);
      return null;
    }

    const { lat: wpLat, lng: wpLng } = termRes.rows[0];

    // 2. Encontrar o stop da linha lineCode mais próximo das coords do waypoint
    const stopRes = await pool.query<ResolvedStop>(
      `SELECT
         s.stop_id,
         s.stop_name,
         ST_Y(s.geom::geometry)  AS lat,
         ST_X(s.geom::geometry)  AS lng,
         ROUND(ST_Distance(
           s.geom::geography,
           ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography
         ))::int AS distance_m
       FROM gtfs_stop_times st
       JOIN gtfs_trips t    ON t.trip_id  = st.trip_id
       JOIN gtfs_routes r   ON r.route_id = t.route_id
       JOIN gtfs_stops  s   ON s.stop_id  = st.stop_id
       WHERE (r.route_short_name = $1 OR r.route_long_name ILIKE '%' || $1 || '%')
         AND ST_DWithin(
               s.geom::geography,
               ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
               1500   -- 1.5km de raio máximo
             )
       ORDER BY distance_m
       LIMIT 1`,
      [lineCode, wpLat, wpLng]
    );

    if (stopRes.rows.length === 0) {
      console.warn(`[resolveStopFromLeg] Nenhum stop da linha "${lineCode}" encontrado em 1.5km de "${waypointName}"`);
      return null;
    }

    const stop = stopRes.rows[0];
    console.log(
      `[resolveStopFromLeg] "${lineCode}" @ "${waypointName}" → stop "${stop.stop_name}" (${stop.distance_m}m)`
    );
    return stop;
  } catch (err) {
    console.warn('[resolveStopFromLeg] Erro:', err);
    return null;
  }
}

// ── Validação cruzada ─────────────────────────────────────────────────────────

async function scorePlan(
  legs: SemanticLeg[],
  terminals: { name: string; aliases: string[] }[],
  lineCodes: string[],
  modalRoutes: { route_name: string }[]
): Promise<number> {
  if (!legs || legs.length === 0) return 0;

  let score = 0;
  const terminalNames = new Set(
    terminals.flatMap(t => [t.name.toLowerCase(), ...t.aliases.map(a => a.toLowerCase())])
  );
  const allCodes = new Set(
    [...lineCodes, ...modalRoutes.map(m => m.route_name)].map(s => s.toLowerCase())
  );

  // +30: linhas validadas no banco
  const validatedLines = legs.filter(l => allCodes.has(l.line_code.toLowerCase()));
  score += Math.round((validatedLines.length / legs.length) * 30);

  // +30: waypoints encontrados em known_terminals
  const validatedWps = legs.filter(l =>
    terminalNames.has(l.waypoint_name.toLowerCase()) ||
    [...terminalNames].some(n => n.includes(l.waypoint_name.toLowerCase()) || l.waypoint_name.toLowerCase().includes(n))
  );
  score += Math.round((validatedWps.length / legs.length) * 30);

  // +20: modais válidos
  const validModals = new Set(['bus', 'brt', 'metro', 'trem', 'vlt']);
  const validatedModals = legs.filter(l => validModals.has(l.modal));
  score += Math.round((validatedModals.length / legs.length) * 20);

  return Math.min(score, 80);
}

// ── Fonte A: Busca Web ────────────────────────────────────────────────────────
// Query melhorada para induzir resultados com número de linha e nome de parada

async function planFromWeb(
  originText: string,   // texto puro do usuário, NUNCA coordenadas
  destText:   string
): Promise<SemanticLeg[] | null> {
  try {
    // Query estruturada para forçar resultados com número de linha e parada de embarque/desembarque
    const query = `como ir de "${originText}" para "${destText}" ônibus metrô BRT Rio de Janeiro linha número parada terminal`;
    const results = await webSearch(query, 6);
    if (results.length === 0) return null;

    const snippets = results.map(r => `[${r.title}] ${r.snippet}`).join('\n');
    return await parseSnippetsWithGroq(snippets, originText, destText);
  } catch (err) {
    console.warn('[semantic-planner] Fonte Web falhou:', err);
    return null;
  }
}

async function parseSnippetsWithGroq(
  snippets: string,
  origin: string,
  destination: string
): Promise<SemanticLeg[] | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Você é um especialista em transporte público do Rio de Janeiro. ' +
              'Dado trechos de busca web, extraia o itinerário de transporte público ' +
              'mais mencionado entre as fontes. ' +
              'Para cada leg do itinerário, identifique: o ponto de EMBARQUE (waypoint_name), ' +
              'o modal (metro, brt, bus, trem, vlt) e o NÚMERO ou NOME da linha (line_code). ' +
              'waypoint_name deve ser o nome do terminal, estação ou ponto de embarque — ' +
              'NUNCA coordenadas, NUNCA endereço genérico. ' +
              'Retorne APENAS um array JSON no formato: ' +
              '[{"leg":1,"waypoint_name":"Nome do Terminal/Estação","modal":"metro|brt|bus|trem|vlt","line_code":"número ou nome da linha"}]. ' +
              'Não inclua texto fora do JSON. Se não encontrar itinerário claro, retorne [].',
          },
          {
            role: 'user',
            content:
              `Origem: "${origin}"\nDestino: "${destination}"\n\nResultados de busca:\n${snippets.slice(0, 3000)}`,
          },
        ],
      }),
    });

    const json = await res.json() as any;
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as SemanticLeg[];
  } catch {
    return null;
  }
}

// ── Fonte B: Groq LLM direto com contexto do banco ────────────────────────────

async function planFromGroq(
  originText: string,
  destText:   string,
  lineCodes:  string[],
  modalRoutes: { route_name: string; modal: string }[]
): Promise<SemanticLeg[] | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const lineContext = [
    ...lineCodes.slice(0, 80),
    ...modalRoutes.map(m => `${m.route_name} (${m.modal})`).slice(0, 40),
  ].join(', ');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Você é um especialista em transporte público do Rio de Janeiro. ' +
              'Use SOMENTE linhas existentes na lista fornecida. Não invente. ' +
              'Para cada leg do itinerário, identifique o ponto de EMBARQUE (nome do terminal ' +
              'ou estação onde o passageiro embarca), o modal e o número da linha. ' +
              'waypoint_name deve ser SEMPRE o nome de um terminal ou estação real do Rio de Janeiro — ' +
              'NUNCA coordenadas ou endereços genéricos. ' +
              'Retorne APENAS um array JSON no formato: ' +
              '[{"leg":1,"waypoint_name":"Nome do Terminal/Estação","modal":"metro|brt|bus|trem|vlt","line_code":"código"}]. ' +
              'Se não houver rota viável, retorne [].',
          },
          {
            role: 'user',
            content:
              `Origem: "${originText}"\nDestino: "${destText}"\n\n` +
              `Linhas disponíveis no sistema: ${lineContext}`,
          },
        ],
      }),
    });

    const json = await res.json() as any;
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as SemanticLeg[];
  } catch {
    return null;
  }
}

// ── Fonte C: Known Terminals lookup O(1) ──────────────────────────────────────

function terminalLookup(
  originText: string,
  destText:   string,
  terminals:  { name: string; modal: string; aliases: string[] }[]
): SemanticLeg[] | null {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normOrigin = norm(originText);
  const normDest   = norm(destText);

  const matchTerminal = (text: string, t: { name: string; aliases: string[] }) => {
    const normName = norm(t.name);
    const normAliases = t.aliases.map(a => norm(a));
    return normName.includes(text) || text.includes(normName) ||
           normAliases.some(a => a.includes(text) || text.includes(a));
  };

  const matchOrigin = terminals.find(t => matchTerminal(normOrigin, t));
  const matchDest   = terminals.find(t => matchTerminal(normDest, t));

  if (!matchOrigin || !matchDest) return null;
  if (matchOrigin.name === matchDest.name) return null;

  return [
    { leg: 1, waypoint_name: matchOrigin.name, modal: matchOrigin.modal, line_code: matchOrigin.modal.toUpperCase() },
    { leg: 2, waypoint_name: matchDest.name,   modal: matchDest.modal,   line_code: matchDest.modal.toUpperCase() },
  ];
}

// ── Entry point público ───────────────────────────────────────────────────────

export async function buildSemanticPlan(
  originText: string,   // texto puro do usuário — NUNCA coordenadas
  destText:   string
): Promise<SemanticPlan> {
  // Carrega contexto do banco em paralelo
  const [lineCodes, terminals, modalRoutes] = await Promise.all([
    getKnownLineCodes(),
    getKnownTerminals(),
    getModalNetworkRoutes(),
  ]);

  // Dispara as 3 fontes em paralelo
  const [webResult, groqResult] = await Promise.allSettled([
    planFromWeb(originText, destText),
    planFromGroq(originText, destText, lineCodes, modalRoutes),
  ]);

  const webLegs  = webResult.status  === 'fulfilled' ? webResult.value  : null;
  const groqLegs = groqResult.status === 'fulfilled' ? groqResult.value : null;
  const hubLegs  = terminalLookup(originText, destText, terminals);

  const [scoreWeb, scoreGroq, scoreHub] = await Promise.all([
    webLegs  ? scorePlan(webLegs,  terminals, lineCodes, modalRoutes) : Promise.resolve(0),
    groqLegs ? scorePlan(groqLegs, terminals, lineCodes, modalRoutes) : Promise.resolve(0),
    hubLegs  ? scorePlan(hubLegs,  terminals, lineCodes, modalRoutes) : Promise.resolve(0),
  ]);

  // Bônus de consenso: +20 se 2+ fontes concordam no primeiro modal
  const firstModals = [webLegs, groqLegs, hubLegs]
    .filter(Boolean)
    .map(l => l![0]?.modal);
  const modalCounts = firstModals.reduce<Record<string, number>>((acc, m) => {
    if (m) acc[m] = (acc[m] ?? 0) + 1;
    return acc;
  }, {});
  const hasConsensus = Object.values(modalCounts).some(c => c >= 2);
  const consensusBonus = hasConsensus ? 20 : 0;

  const candidates = [
    { legs: webLegs,  score: Math.min(scoreWeb  + consensusBonus, 100), source: 'web'  },
    { legs: groqLegs, score: Math.min(scoreGroq + consensusBonus, 100), source: 'groq' },
    { legs: hubLegs,  score: Math.min(scoreHub  + consensusBonus, 100), source: 'hub'  },
  ].filter(c => c.legs !== null && c.legs!.length > 0) as
    { legs: SemanticLeg[]; score: number; source: string }[];

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  if (!best || best.score < 40) {
    console.warn(
      `[semantic-planner] Todas as fontes com score baixo para "${originText}" → "${destText}". Modo degradado.`
    );
    return { legs: [], score: 0, source: 'degraded', degraded: true };
  }

  console.log(
    `[semantic-planner] Melhor plano: fonte=${best.source} score=${best.score} ` +
    `legs=${best.legs.length} para "${originText}" → "${destText}"`
  );

  return {
    legs:     best.legs,
    score:    best.score,
    source:   best.source,
    degraded: false,
  };
}
