/**
 * web-search.ts
 * Wrapper de busca web — Jina AI Search + You.com Free
 * Ambos funcionam SEM API key e SEM cadastro.
 *
 * Jina Search:  https://s.jina.ai/?q={query}
 * You.com free: https://api.you.com/search?q={query}
 */

export interface WebSearchResult {
  title:   string;
  url:     string;
  snippet: string;
}

// ── Jina AI Search ────────────────────────────────────────────────────────────
async function searchWithJina(query: string): Promise<WebSearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://s.jina.ai/?q=${encoded}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RioMobilityAssistant/1.0',
      },
    });

    if (!res.ok) {
      console.warn(`[Jina] HTTP ${res.status} para query "${query}"`);
      return [];
    }

    const data = await res.json() as any;
    const items: any[] = data?.data ?? data?.results ?? [];

    return items.slice(0, 5).map((item: any) => ({
      title:   item.title   ?? '',
      url:     item.url     ?? '',
      snippet: item.content ?? item.description ?? item.snippet ?? '',
    }));
  } catch (err) {
    console.warn('[Jina] Erro na busca:', err);
    return [];
  }
}

// ── You.com Search (free, sem chave) ─────────────────────────────────────────
async function searchWithYou(query: string): Promise<WebSearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://api.you.com/search?q=${encoded}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RioMobilityAssistant/1.0',
      },
    });

    if (!res.ok) {
      console.warn(`[You.com] HTTP ${res.status} para query "${query}"`);
      return [];
    }

    const data = await res.json() as any;
    const hits: any[] = data?.hits ?? data?.results ?? data?.web?.results ?? [];

    return hits.slice(0, 5).map((item: any) => ({
      title:   item.title       ?? '',
      url:     item.url         ?? '',
      snippet: item.description ?? item.snippet ?? '',
    }));
  } catch (err) {
    console.warn('[You.com] Erro na busca:', err);
    return [];
  }
}

// ── Entry point público ───────────────────────────────────────────────────────
/**
 * Dispara Jina + You.com em paralelo.
 * Retorna resultados mesclados (sem duplicatas de URL), até `limit` itens.
 */
export async function webSearch(
  query: string,
  limit = 8
): Promise<WebSearchResult[]> {
  const [jinaResults, youResults] = await Promise.allSettled([
    searchWithJina(query),
    searchWithYou(query),
  ]);

  const jina = jinaResults.status === 'fulfilled' ? jinaResults.value : [];
  const you  = youResults.status  === 'fulfilled' ? youResults.value  : [];

  // Mescla sem duplicatas de URL
  const seen = new Set<string>();
  const merged: WebSearchResult[] = [];

  for (const r of [...jina, ...you]) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
    if (merged.length >= limit) break;
  }

  console.log(`[web-search] Query "${query}" → Jina:${jina.length} You:${you.length} merged:${merged.length}`);
  return merged;
}
