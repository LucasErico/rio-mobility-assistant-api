// Tipos compartilhados do motor RAPTOR

export type Priority = 'cheaper' | 'faster' | 'less_transfers';

// ── Grafo em memória (BinaryTransitGraph) ─────────────────────────────────────
// Cada route (linha) tem um array de stops em sequência.
// Cada stop tem um array de routes que a atendem.

export interface RaptorStop {
  stopId:   string;
  name:     string;
  lat:      number;
  lng:      number;
}

export interface RaptorRoute {
  routeId:    string;
  routeName:  string;
  modal:      string;        // 'metro'|'trem'|'brt'|'vlt'|'bus'
  stops:      string[];      // stop_ids em sequência
  headwaySec: number;       // headway médio (espera = headway/2)
  faresBrl:   number;
}

// Footpath: caminhada pré-computada entre dois stops de modais diferentes
export interface Footpath {
  fromStopId: string;
  toStopId:   string;
  walkSec:    number;
}

// Grafo completo carregado em memória
export interface TransitGraph {
  stops:      Map<string, RaptorStop>;      // stopId → stop
  routes:     Map<string, RaptorRoute>;     // routeId → route
  stopRoutes: Map<string, string[]>;        // stopId → routeIds que passam por ele
  footpaths:  Footpath[];                   // todos os footpaths pré-computados
}

// ── Labels do RAPTOR ──────────────────────────────────────────────────────────
export interface RaptorLabel {
  arrivalSec:  number;       // tempo acumulado em segundos desde t=0
  costBrl:     number;
  transfers:   number;
  boardStop:   string | null;
  exitStop:    string | null;
  routeId:     string | null;
  prevStopId:  string | null;  // para reconstrução do caminho
}

// ── Resultado final ───────────────────────────────────────────────────────────
// (compatível com RouteOption existente em routing.service.ts)
export interface RouteLeg {
  modal:             string;
  route_name:        string;
  from_stop:         string;
  to_stop:           string;
  from_coords:       { lat: number; lng: number };
  to_coords:         { lat: number; lng: number };
  shape_coords:      { lat: number; lng: number }[];
  estimated_minutes: number;
  walk_to_stop_m:    number;
}

export interface RouteOption {
  legs: RouteLeg[];
  summary: {
    total_minutes:      number;
    transfers:          number;
    estimated_cost_brl: number;
  };
}
