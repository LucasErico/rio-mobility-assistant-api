export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  const encoded = encodeURIComponent(address + ', Rio de Janeiro, Brasil');
  const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'RioMobilityAssistant/1.0' }
  });
  const data = await res.json() as any[];

  if (!data || data.length === 0) {
    throw new Error(`Endereço não encontrado: ${address}`);
  }

  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon)
  };
}
