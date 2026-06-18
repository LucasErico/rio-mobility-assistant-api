import type {
  TransitGraph, RaptorLabel, RaptorStop,
  RouteOption, RouteLeg, Priority,
} from './types';

const WALK_SPEED_M_PER_SEC = 1.1;   // ~80m/min
const MAX_ROUNDS           = 4;     // max 4 baldeacoes (= MAX_TRANSFERS do BFS)
const WALK_RADIUS_M        = 500;   // raio para encontrar stops proximos no grafo
const INF                  = Infinity;

// ── Haversine em metros ──────────────────────────────────────────────────
function haversineM(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R    = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Encontra stops do grafo dentro de um raio de um ponto geo ────────────────
function stopsWithinRadius(
  graph: TransitGraph,
  lat: number, lng: number,
  radiusM: number
): { stopId: string; distM: number }[] {
  const results: { stopId: string; distM: number }[] = [];
  for (const stop of graph.stops.values()) {
    const d = haversineM(lat, lng, stop.lat, stop.lng);
    if (d <= radiusM) results.push({ stopId: stop.stopId, distM: d });
  }
  results.sort((a, b) => a.distM - b.distM);

  // FIX-12: nao limitar a 30 fixo para nao excluir modais premium em zonas densas.
  // Garante ao menos 1 stop de cada modal presente, depois limita bus/brt a 20.
  const railStops = results.filter(s => s.stopId.startsWith('rail:'));
  const nonRailStops = results.filter(s => !s.stopId.startsWith('rail:')).slice(0, 20);
  return [...railStops, ...nonRailStops];
}

// ── Constroi indice de footpaths por stop de origem ────────────────────────
function buildFootpathIndex(
  graph: TransitGraph
): Map<string, { toStopId: string; walkSec: number }[]> {
  const idx = new Map<string, { toStopId: string; walkSec: number }[]>();
  for (const fp of graph.footpaths) {
    if (!idx.has(fp.fromStopId)) idx.set(fp.fromStopId, []);
    idx.get(fp.fromStopId)!.push({ toStopId: fp.toStopId, walkSec: fp.walkSec });
  }
  return idx;
}

// ── RAPTOR principal ──────────────────────────────────────────────────
export function runRaptor(
  graph:    TransitGraph,
  originLat: number, originLng: number,
  destLat:   number, destLng:   number,
  priority:  Priority
): RouteOption[] {

  // 1. Encontra source stops (paradas proximas a origem)
  const sourceStops = stopsWithinRadius(graph, originLat, originLng, WALK_RADIUS_M);
  const targetStops = stopsWithinRadius(graph, destLat,   destLng,   WALK_RADIUS_M);

  if (sourceStops.length === 0 || targetStops.length === 0) return [];

  const targetIds = new Set(targetStops.map(s => s.stopId));
  const fpIndex   = buildFootpathIndex(graph);

  // 2. Inicializa labels: tau[k][stopId] = melhor label em k transfers
  const tau: Map<string, RaptorLabel>[] = Array.from(
    { length: MAX_ROUNDS + 1 }, () => new Map()
  );

  // tau[0] = chegada a pe as source stops
  for (const { stopId, distM } of sourceStops) {
    const walkSec = distM / WALK_SPEED_M_PER_SEC;
    tau[0].set(stopId, {
      arrivalSec: walkSec,
      costBrl:    0,
      transfers:  0,
      boardStop:  null,
      exitStop:   null,
      routeId:    null,
      prevStopId: null,
    });
  }

  // Melhor tempo global para qualquer target (Early Pruning)
  let bestTargetSec = INF;
  for (const { stopId, distM } of targetStops) {
    const tau0 = tau[0].get(stopId);
    if (tau0 && tau0.arrivalSec < bestTargetSec) {
      bestTargetSec = tau0.arrivalSec;
    }
  }

  // 3. Rodadas RAPTOR
  for (let k = 1; k <= MAX_ROUNDS; k++) {
    const prev = tau[k - 1];
    const curr = new Map(prev);
    tau[k] = curr;

    // FIX-05: marked deve conter apenas stops que MELHORARAM em tau[k-1] vs tau[k-2].
    // Antes usava prev.keys() (todos os stops da rodada anterior), o que causava
    // reprocessamento desnecessario e potenciais loops.
    const prevPrev = tau[k - 2];
    const marked = new Set<string>();
    for (const [stopId, label] of prev.entries()) {
      const older = prevPrev?.get(stopId);
      if (!older || scoreLabel(label.arrivalSec, label.costBrl, label.transfers, priority) <
                    scoreLabel(older.arrivalSec, older.costBrl, older.transfers, priority)) {
        marked.add(stopId);
      }
    }
    // Na rodada k=1 nao ha tau[k-2]; marcamos todos de tau[0]
    if (k === 1) for (const stopId of prev.keys()) marked.add(stopId);

    if (marked.size === 0) break;

    // Coleta rotas que passam pelos stops marcados
    const routesToScan = new Map<string, string>(); // routeId -> stop de entrada mais cedo
    for (const stopId of marked) {
      const routeIds = graph.stopRoutes.get(stopId) ?? [];
      for (const routeId of routeIds) {
        const route = graph.routes.get(routeId)!;
        const idx   = route.stops.indexOf(stopId);
        if (idx < 0) continue;
        const existing = routesToScan.get(routeId);
        if (!existing) {
          routesToScan.set(routeId, stopId);
        } else {
          const existIdx = route.stops.indexOf(existing);
          if (idx < existIdx) routesToScan.set(routeId, stopId);
        }
      }
    }

    // Percorre cada rota a partir do stop de entrada
    for (const [routeId, boardStopId] of routesToScan.entries()) {
      const route       = graph.routes.get(routeId)!;
      const boardIdx    = route.stops.indexOf(boardStopId);
      const waitSec     = route.headwaySec / 2;
      const speedMpS    = modalSpeed(route.modal);

      let accumulated   = 0;
      let prevStopLat   = graph.stops.get(boardStopId)?.lat ?? destLat;
      let prevStopLng   = graph.stops.get(boardStopId)?.lng ?? destLng;
      let boardingLabel = prev.get(boardStopId);
      // FIX-04: rastreia o arrivalSec no momento do embarque para calcular
      // a duracao da leg como (arrivalAtStop - boardingArrivalSec)
      let boardingArrivalSec = boardingLabel?.arrivalSec ?? 0;

      for (let i = boardIdx; i < route.stops.length; i++) {
        const stopId = route.stops[i];
        const stop   = graph.stops.get(stopId);
        if (!stop) continue;

        if (i > boardIdx) {
          const segM  = haversineM(prevStopLat, prevStopLng, stop.lat, stop.lng);
          accumulated += segM / speedMpS;
        }
        prevStopLat = stop.lat;
        prevStopLng = stop.lng;

        // Tenta embarcar aqui se o label anterior e melhor que o boarding atual
        const candidateBoard = prev.get(stopId);
        if (candidateBoard && (
          !boardingLabel ||
          candidateBoard.arrivalSec < boardingLabel.arrivalSec
        )) {
          boardingLabel       = candidateBoard;
          boardingArrivalSec  = candidateBoard.arrivalSec;
          accumulated = 0;
          prevStopLat = stop.lat;
          prevStopLng = stop.lng;
        }

        if (!boardingLabel) continue;

        const arrivalAtStop = boardingLabel.arrivalSec + waitSec + accumulated;

        if (arrivalAtStop >= bestTargetSec) continue;

        const existing   = curr.get(stopId);
        const cost       = boardingLabel.costBrl + route.faresBrl;
        const score      = scoreLabel(arrivalAtStop, cost, k, priority);
        const existScore = existing
          ? scoreLabel(existing.arrivalSec, existing.costBrl, existing.transfers, priority)
          : INF;

        if (score < existScore) {
          curr.set(stopId, {
            arrivalSec:  arrivalAtStop,
            costBrl:     cost,
            transfers:   k,
            boardStop:   boardStopId,
            exitStop:    stopId,
            routeId,
            prevStopId:  boardingLabel.exitStop ?? boardingLabel.boardStop,
            // FIX-04: guarda o tempo de embarque para calculo correto da duracao da leg
            boardArrivalSec: boardingArrivalSec,
          } as RaptorLabel);
          marked.add(stopId);

          if (targetIds.has(stopId) && arrivalAtStop < bestTargetSec) {
            bestTargetSec = arrivalAtStop;
          }
        }
      }
    }

    // Aplica footpaths (baldeacoes a pe entre modais)
    for (const stopId of [...marked]) {
      const label = curr.get(stopId);
      if (!label) continue;

      const fps = fpIndex.get(stopId) ?? [];
      for (const fp of fps) {
        const arrivalViaWalk = label.arrivalSec + fp.walkSec;
        if (arrivalViaWalk >= bestTargetSec) continue;

        const existing   = curr.get(fp.toStopId);
        const score      = scoreLabel(arrivalViaWalk, label.costBrl, k, priority);
        const existScore = existing
          ? scoreLabel(existing.arrivalSec, existing.costBrl, existing.transfers, priority)
          : INF;

        if (score < existScore) {
          curr.set(fp.toStopId, {
            arrivalSec:     arrivalViaWalk,
            costBrl:        label.costBrl,
            transfers:      k,
            boardStop:      stopId,
            exitStop:       fp.toStopId,
            routeId:        'footpath',
            prevStopId:     stopId,
            boardArrivalSec: label.arrivalSec,
          } as RaptorLabel);
          if (targetIds.has(fp.toStopId) && arrivalViaWalk < bestTargetSec) {
            bestTargetSec = arrivalViaWalk;
          }
        }
      }
    }
  }

  // 4. Coleta resultados — pega o melhor label por target em cada rodada
  const candidates: { label: RaptorLabel; targetStop: RaptorStop; walkToDestM: number }[] = [];

  for (const { stopId, distM } of targetStops) {
    const stop = graph.stops.get(stopId);
    if (!stop) continue;
    for (let k = 0; k <= MAX_ROUNDS; k++) {
      const label = tau[k].get(stopId);
      if (label && label.routeId !== null) {
        candidates.push({ label, targetStop: stop, walkToDestM: distM });
        break;
      }
    }
  }

  if (candidates.length === 0) return [];

  // 5. Constroi RouteOptions com backtracking completo das legs
  const routes = candidates
    .map(({ label, targetStop, walkToDestM }) =>
      buildRouteOption(label, tau, graph, targetStop, walkToDestM)
    )
    .filter((r): r is RouteOption => r !== null);

  return sortByPriority(routes, priority).slice(0, 5);
}

// ── Score para comparar labels conforme prioridade ──────────────────────────
function scoreLabel(
  arrivalSec: number,
  costBrl:    number,
  transfers:  number,
  priority:   Priority
): number {
  if (priority === 'faster')         return arrivalSec;
  if (priority === 'cheaper')        return costBrl * 1000 + arrivalSec;
  if (priority === 'less_transfers') return transfers * 100_000 + arrivalSec;
  return arrivalSec;
}

// ── Velocidade m/s por modal ────────────────────────────────────────────
function modalSpeed(modal: string): number {
  const speeds: Record<string, number> = {
    metro:       10.0,  // ~36 km/h
    trem:         9.2,  // ~33 km/h
    brt:          7.5,  // ~27 km/h
    vlt:          5.0,  // ~18 km/h
    bus:          4.2,  // ~15 km/h
    bus_express:  8.0,  // ~29 km/h (linha expressa)
  };
  return speeds[modal] ?? 4.2;
}

// ── FIX-03: backtracking recursivo de labels para reconstruir TODAS as legs ──
// Percorre a cadeia label.prevStopId <- label.prevStopId ate tau[0]
// construindo um array de RouteLeg em ordem cronologica.
function backtrackLegs(
  finalLabel: RaptorLabel,
  tau:        Map<string, RaptorLabel>[],
  graph:      TransitGraph
): RouteLeg[] {
  const legs: RouteLeg[] = [];

  let current: RaptorLabel | undefined = finalLabel;

  while (current && current.routeId && current.boardStop && current.exitStop) {
    const route    = graph.routes.get(current.routeId);
    const fromStop = graph.stops.get(current.boardStop);
    const toStop   = graph.stops.get(current.exitStop);

    if (!fromStop || !toStop) break;

    // FIX-04: duracao = arrivalSec - boardArrivalSec (tempo real da leg)
    // boardArrivalSec foi armazenado no label durante o scan da rota.
    const boardArrSec  = (current as any).boardArrivalSec ?? 0;
    const legSec       = current.arrivalSec - boardArrSec;
    const legMin       = Math.max(1, Math.ceil(legSec / 60));

    if (current.routeId !== 'footpath') {
      const routeData = route;
      legs.unshift({
        modal:             routeData?.modal ?? 'bus',
        route_name:        routeData?.routeName ?? current.routeId,
        from_stop:         fromStop.name,
        to_stop:           toStop.name,
        from_coords:       { lat: fromStop.lat, lng: fromStop.lng },
        to_coords:         { lat: toStop.lat,   lng: toStop.lng   },
        shape_coords:      [],
        estimated_minutes: legMin,
        walk_to_stop_m:    0,
      });
    }
    // footpaths nao geram leg separada (sao baldacoes invissiveis no itinerario)

    // Sobe para o label anterior via prevStopId
    if (!current.prevStopId) break;
    let found: RaptorLabel | undefined;
    for (let k = tau.length - 1; k >= 0; k--) {
      const candidate = tau[k].get(current.prevStopId);
      if (candidate && candidate.arrivalSec < current.arrivalSec) {
        found = candidate;
        break;
      }
    }
    current = found;
  }

  return legs;
}

// ── Constroi RouteOption a partir do label final ───────────────────────────
function buildRouteOption(
  label:        RaptorLabel,
  tau:          Map<string, RaptorLabel>[],
  graph:        TransitGraph,
  targetStop:   RaptorStop,
  walkToDestM:  number
): RouteOption | null {
  if (!label.routeId || !label.exitStop || !label.boardStop) return null;

  // FIX-03: reconstruir TODAS as legs via backtracking, nao apenas a ultima
  const legs = backtrackLegs(label, tau, graph);
  if (legs.length === 0) return null;

  const walkDestMin = Math.ceil(walkToDestM / WALK_SPEED_M_PER_SEC / 60);
  const totalMin    = legs.reduce((acc, l) => acc + l.estimated_minutes, 0) + walkDestMin;

  return {
    legs,
    summary: {
      total_minutes:      Math.max(1, totalMin),
      transfers:          label.transfers,
      estimated_cost_brl: label.costBrl,
    },
  };
}

// ── Ordena por prioridade ───────────────────────────────────────────────
function sortByPriority(routes: RouteOption[], priority: Priority): RouteOption[] {
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
