/**
 * semantic-planner.service.ts  — Camada 2 do Tribunal de Fontes
 *
 * Dado origem + destino como texto, descobre o itinerário nominal
 * (sequência de waypoints + modais) ANTES de qualquer geocoding.
 *
 * Fontes (paralelas):
 *   A — Jina + You.com (busca web via web-search.ts)
 *   B — Groq LLM com contexto das linhas do banco
 *   C — Hub lookup O(1) — transit_hubs do banco
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
  degraded:   boolean;  // true = RAPTOR puro sem waypoints
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

async function getTransitHubs(): Promise<{ name: string; lat: number; lng: number; modal: string }[]> {
  try {
    const res = await pool.query<{ name: string; lat: number; lng: number; modal: string }>(`
      SELECT name, lat, lng, modal
      FROM transit_hubs
      ORDER BY name
    `);
    return res.rows;
  } catch {
    return [];
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

// ── Validação cruzada ─────────────────────────────────────────────────────────

async function scorePlan(
  legs: SemanticLeg[],
  hubs: { name: string }[],
  lineCodes: string[],
  modalRoutes: { route_name: string }[]
): Promise<number> {
  if (!legs || legs.length === 0) return 0;

  let score = 0;
  const hubNames    = new Set(hubs.map(h => h.name.toLowerCase()));
  const allCodes    = new Set([...lineCodes, ...modalRoutes.map(m => m.route_name)].map(s => s.toLowerCase()));

  // +30: linhas validadas no banco
  const validatedLines = legs.filter(l => allCodes.has(l.line_code.toLowerCase()));
  score += Math.round((validatedLines.length / legs.length) * 30);

  // +30: waypoints encontrados em transit_hubs
  const validatedWps = legs.filter(l => hubNames.has(l.waypoint_name.toLowerCase()));
  score += Math.round((validatedWps.length / legs.length) * 30);

  // +20: modais válidos
  const validModals = new Set(['bus', 'brt', 'metro', 'trem', 'vlt']);
  const validatedModals = legs.filter(l => validModals.has(l.modal));
  score += Math.round((validatedModals.length / legs.length) * 20);

  // +20 reservado para consenso (aplicado pelo chamador se 2+ fontes concordam)
  return Math.min(score, 80);
}

// ── Fonte A: Busca Web ────────────────────────────────────────────────────────

async function planFromWeb(
  origin: string,
  destination: string
): Promise<SemanticLeg[] | null> {
  try {
    const query = `itinerário ${origin} até ${destination} Rio de Janeiro transporte público ônibus metrô BRT`;
    const results = await webSearch(query, 6);
    if (results.length === 0) return null;

    // Envia snippets para o Groq interpretar/estruturar
    const snippets = results.map(r => `[${r.title}] ${r.snippet}`).join('\n');
    return await parseSnippetsWithGroq(snippets, origin, destination);
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
              'Retorne APENAS um array JSON no formato: ' +
              '[{"leg":1,"waypoint_name":"Nome da Estação/Terminal","modal":"metro|brt|bus|trem|vlt","line_code":"código ou nome da linha"}]. ' +
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
  origin: string,
  destination: string,
  lineCodes: string[],
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
              'Retorne APENAS um array JSON no formato: ' +
              '[{"leg":1,"waypoint_name":"Nome do hub ou estação","modal":"metro|brt|bus|trem|vlt","line_code":"código"}]. ' +
              'Se não houver rota viável, retorne [].',
          },
          {
            role: 'user',
            content:
              `Origem: "${origin}"\nDestino: "${destination}"\n\n` +
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

// ── Fonte C: Hub lookup O(1) ──────────────────────────────────────────────────

function hubLookup(
  origin: string,
  destination: string,
  hubs: { name: string; modal: string }[]
): SemanticLeg[] | null {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normOrigin = norm(origin);
  const normDest   = norm(destination);

  const matchOrigin = hubs.find(h => norm(h.name).includes(normOrigin) || normOrigin.includes(norm(h.name)));
  const matchDest   = hubs.find(h => norm(h.name).includes(normDest)   || normDest.includes(norm(h.name)));

  if (!matchOrigin || !matchDest) return null;
  if (matchOrigin.name === matchDest.name) return null;

  return [
    {
      leg:           1,
      waypoint_name: matchOrigin.name,
      modal:         matchOrigin.modal,
      line_code:     matchOrigin.modal.toUpperCase(),
    },
    {
      leg:           2,
      waypoint_name: matchDest.name,
      modal:         matchDest.modal,
      line_code:     matchDest.modal.toUpperCase(),
    },
  ];
}

// ── Entry point público ───────────────────────────────────────────────────────

export async function buildSemanticPlan(
  origin: string,
  destination: string
): Promise<SemanticPlan> {
  // Carrega contexto do banco em paralelo
  const [lineCodes, hubs, modalRoutes] = await Promise.all([
    getKnownLineCodes(),
    getTransitHubs(),
    getModalNetworkRoutes(),
  ]);

  // Dispara as 3 fontes em paralelo
  const [webResult, groqResult] = await Promise.allSettled([
    planFromWeb(origin, destination),
    planFromGroq(origin, destination, lineCodes, modalRoutes),
  ]);

  const webLegs  = webResult.status  === 'fulfilled' ? webResult.value  : null;
  const groqLegs = groqResult.status === 'fulfilled' ? groqResult.value : null;
  const hubLegs  = hubLookup(origin, destination, hubs);

  // Score individual de cada fonte
  const [scoreWeb, scoreGroq, scoreHub] = await Promise.all([
    webLegs  ? scorePlan(webLegs,  hubs, lineCodes, modalRoutes) : Promise.resolve(0),
    groqLegs ? scorePlan(groqLegs, hubs, lineCodes, modalRoutes) : Promise.resolve(0),
    hubLegs  ? scorePlan(hubLegs,  hubs, lineCodes, modalRoutes) : Promise.resolve(0),
  ]);

  // Bônus de consenso: +20 se 2+ fontes têm o mesmo primeiro modal
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

  // Modo degradado: nenhum candidato com score >= 40
  if (!best || best.score < 40) {
    console.warn(
      `[semantic-planner] Todas as fontes com score baixo para "${origin}" → "${destination}". Modo degradado.`
    );
    return { legs: [], score: 0, source: 'degraded', degraded: true };
  }

  console.log(
    `[semantic-planner] Melhor plano: fonte=${best.source} score=${best.score} ` +
    `legs=${best.legs.length} para "${origin}" → "${destination}"`
  );

  return {
    legs:     best.legs,
    score:    best.score,
    source:   best.source,
    degraded: false,
  };
}
