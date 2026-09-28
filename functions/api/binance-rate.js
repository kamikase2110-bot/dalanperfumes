export async function onRequestGet() {
    try {
        const response = await fetch('https://api.dolarbluebolivia.click/v1/officialRate', {
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`La API de cotización respondió con ${response.status}`);
        }

        const data = await response.json();
        const price = Number(data?.data?.blue?.sell);

        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('La API no devolvió un precio de venta válido para USDT/BOB.');
        }

        return Response.json({ price }, {
            headers: { 'Cache-Control': 'public, max-age=60' }
        });
    } catch (error) {
        console.error('No se pudo obtener la cotización P2P de USDT/BOB:', error);
        return Response.json(
            { error: 'No se pudo consultar la cotización de Binance.' },
            { status: 502, headers: { 'Cache-Control': 'no-store' } }
        );
    }
}