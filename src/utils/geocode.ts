import { pool } from '../db';

const RIO_BOUNDS = {
  latMin: -23.1,
  latMax: -22.7,
  lngMin: -43.8,
  lngMax: -43.0,
};

const CONSENSUS_THRESHOLD_M = 200;

function isInsideRio(lat: number, lng: number): boolean {
  return (
    lat >= RIO_BOUNDS.latMin && lat <= RIO_BOUNDS.latMax &&
    lng >= RIO_BOUNDS.lngMin && lng <= RIO_BOUNDS.lngMax
  );
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function centroid(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): { lat: number; lng: number } {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

// ── Camada 0: known_terminals (lookup O(1) no banco, coords curadas) ──────────
async function geocodeFromKnownTerminals(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  try {
    const norm = address.trim().toLowerCase();
    const res = await pool.query<{ lat: number; lng: number; name: string }>(
      `SELECT lat, lng, name
       FROM known_terminals
       WHERE LOWER(name) = $1
          OR $1 = ANY(SELECT LOWER(a) FROM unnest(aliases) a)
          OR LOWER(name) LIKE '%' || $1 || '%'
       ORDER BY
         CASE WHEN LOWER(name) = $1 THEN 0
              WHEN $1 = ANY(SELECT LOWER(a) FROM unnest(aliases) a) THEN 1
              ELSE 2 END
       LIMIT 1`,
      [norm]
    );
    if (res.rows.length === 0) return null;
    const { lat, lng, name } = res.rows[0];
    console.log(`[Geocode] known_terminals hit: "${address}" → "${name}" (${lat}, ${lng})`);
    return { lat, lng };
  } catch (err) {
    console.warn('[Geocode] known_terminals lookup falhou:', err);
    return null;
  }
}

async function geocodeWithNominatim(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  try {
    const encoded = encodeURIComponent(address + ', Rio de Janeiro, Brasil');
    const viewbox = `${RIO_BOUNDS.lngMin},${RIO_BOUNDS.latMax},${RIO_BOUNDS.lngMax},${RIO_BOUNDS.latMin}`;
    const url =
      `https://nominatim.openstreetmap.org/search?q=${encoded}` +
      `&format=json&limit=1&viewbox=${viewbox}&bounded=1&countrycodes=br`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RioMobilityAssistant/1.0' },
    });
    const data = (await res.json()) as any[];
    if (!data || data.length === 0) return null;

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (!isInsideRio(lat, lng)) {
      console.warn(`[Nominatim] Fora do Rio para "${address}": ${lat}, ${lng}`);
      return null;
    }
    return { lat, lng };
  } catch (err) {
    console.warn('[Nominatim] Erro:', err);
    return null;
  }
}

async function geocodeWithPhoton(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  try {
    const encoded = encodeURIComponent(address + ' Rio de Janeiro');
    const url =
      `https://photon.komoot.io/api/?q=${encoded}` +
      `&limit=1&lang=pt&bbox=${RIO_BOUNDS.lngMin},${RIO_BOUNDS.latMin},${RIO_BOUNDS.lngMax},${RIO_BOUNDS.latMax}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RioMobilityAssistant/1.0' },
    });
    const data = (await res.json()) as any;
    const feature = data?.features?.[0];
    if (!feature) return null;

    const [lng, lat] = feature.geometry.coordinates as [number, number];
    if (!isInsideRio(lat, lng)) {
      console.warn(`[Photon] Fora do Rio para "${address}": ${lat}, ${lng}`);
      return null;
    }
    return { lat, lng };
  } catch (err) {
    console.warn('[Photon] Erro:', err);
    return null;
  }
}

async function geocodeWithGroq(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn('[Groq Geocode] GROQ_API_KEY não configurada.');
    return null;
  }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Você é um geocodificador especializado no Rio de Janeiro, Brasil. ' +
              'Dado um nome de local, ponto de referência ou endereço no Rio de Janeiro, ' +
              'responda SOMENTE um JSON válido no formato {"lat": number, "lng": number}. ' +
              'Não inclua nenhum texto fora do JSON. ' +
              'Se não souber a localização exata, use a melhor aproximação dentro do município do Rio de Janeiro.',
          },
          {
            role: 'user',
            content: `Qual é a latitude e longitude de: "${address}" no Rio de Janeiro?`,
          },
        ],
      }),
    });
    const json = (await res.json()) as any;
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const coords = JSON.parse(content);
    if (typeof coords.lat !== 'number' || typeof coords.lng !== 'number') return null;
    if (!isInsideRio(coords.lat, coords.lng)) {
      console.warn(`[Groq Geocode] Fora do Rio para "${address}": ${coords.lat}, ${coords.lng}`);
      return null;
    }
    console.log(`[Groq Geocode] Resolvido "${address}" → ${coords.lat}, ${coords.lng}`);
    return { lat: coords.lat, lng: coords.lng };
  } catch (err) {
    console.warn('[Groq Geocode] Erro:', err);
    return null;
  }
}

export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number }> {
  // Camada 0: known_terminals — lookup O(1) para terminais e estações conhecidas
  // Resolve ~80% dos hubs sem depender de Nominatim ou Photon
  const terminal = await geocodeFromKnownTerminals(address);
  if (terminal) return terminal;

  // Camada 1: Nominatim + Photon em paralelo
  const [nominatimResult, photonResult] = await Promise.allSettled([
    geocodeWithNominatim(address),
    geocodeWithPhoton(address),
  ]);

  const nominatim =
    nominatimResult.status === 'fulfilled' ? nominatimResult.value : null;
  const photon =
    photonResult.status === 'fulfilled' ? photonResult.value : null;

  if (nominatim && photon) {
    const dist = distanceMeters(nominatim, photon);
    if (dist <= CONSENSUS_THRESHOLD_M) {
      const result = centroid(nominatim, photon);
      console.log(
        `[Geocode] Consenso (${dist.toFixed(0)}m) para "${address}" → ${result.lat}, ${result.lng}`
      );
      return result;
    }
    console.warn(
      `[Geocode] Divergência (${dist.toFixed(0)}m) para "${address}" — usando Nominatim`
    );
    return nominatim;
  }

  if (nominatim) {
    console.log(`[Geocode] Só Nominatim para "${address}" → ${nominatim.lat}, ${nominatim.lng}`);
    return nominatim;
  }
  if (photon) {
    console.log(`[Geocode] Só Photon para "${address}" → ${photon.lat}, ${photon.lng}`);
    return photon;
  }

  // Fallback: Groq
  console.log(`[Geocode] Nominatim e Photon falharam para "${address}", tentando Groq...`);
  const groq = await geocodeWithGroq(address);
  if (groq) return groq;

  throw new Error(`Não foi possível localizar "${address}" no Rio de Janeiro.`);
}
