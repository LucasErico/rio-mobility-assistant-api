const RIO_BOUNDS = {
  latMin: -23.1,
  latMax: -22.7,
  lngMin: -43.8,
  lngMax: -43.0,
};

function isInsideRio(lat: number, lng: number): boolean {
  return (
    lat >= RIO_BOUNDS.latMin && lat <= RIO_BOUNDS.latMax &&
    lng >= RIO_BOUNDS.lngMin && lng <= RIO_BOUNDS.lngMax
  );
}

async function geocodeWithNominatim(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const encoded = encodeURIComponent(address + ', Rio de Janeiro, Brasil');
    const viewbox = `${RIO_BOUNDS.lngMin},${RIO_BOUNDS.latMax},${RIO_BOUNDS.lngMax},${RIO_BOUNDS.latMin}`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&viewbox=${viewbox}&bounded=1&countrycodes=br`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RioMobilityAssistant/1.0' }
    });
    const data = await res.json() as any[];

    if (!data || data.length === 0) return null;

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);

    if (!isInsideRio(lat, lng)) {
      console.warn(`[Nominatim] Resultado fora do Rio para "${address}": ${lat}, ${lng}`);
      return null;
    }

    return { lat, lng };
  } catch (err) {
    console.warn('[Nominatim] Erro:', err);
    return null;
  }
}

async function geocodeWithGroq(address: string): Promise<{ lat: number; lng: number } | null> {
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
        'Authorization': `Bearer ${apiKey}`,
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

    const json = await res.json() as any;
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const coords = JSON.parse(content);
    if (typeof coords.lat !== 'number' || typeof coords.lng !== 'number') return null;

    if (!isInsideRio(coords.lat, coords.lng)) {
      console.warn(`[Groq Geocode] Resultado fora do Rio para "${address}": ${coords.lat}, ${coords.lng}`);
      return null;
    }

    console.log(`[Groq Geocode] Resolvido "${address}" → ${coords.lat}, ${coords.lng}`);
    return { lat: coords.lat, lng: coords.lng };
  } catch (err) {
    console.warn('[Groq Geocode] Erro:', err);
    return null;
  }
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  // 1º tenta Nominatim restrito ao Rio
  const nominatim = await geocodeWithNominatim(address);
  if (nominatim) return nominatim;

  console.log(`[Geocode] Nominatim falhou para "${address}", tentando Groq...`);

  // 2º fallback: Groq
  const groq = await geocodeWithGroq(address);
  if (groq) return groq;

  throw new Error(`Não foi possível localizar "${address}" no Rio de Janeiro.`);
}
