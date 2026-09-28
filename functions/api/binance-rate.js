export async function onRequestGet() {
    try {
        const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                page: 1,
                rows: 10,
                tradeType: 'BUY',
                asset: 'USDT',
                fiat: 'BOB',
                payTypes: [],
                publisherType: 'merchant',
                merchantCheck: true
            }),
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`Binance respondió con ${response.status}`);
        }

        const data = await response.json();
        const price = Number(data?.data?.[0]?.adv?.price);

        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('Binance no devolvió anuncios P2P disponibles.');
        }

        return Response.json({ price }, {
            headers: { 'Cache-Control': 'public, max-age=300' }
        });
    } catch (error) {
        console.error('No se pudo obtener la cotización de Binance:', error);
        return Response.json(
            { error: 'No se pudo consultar la cotización de Binance.' },
            { status: 502, headers: { 'Cache-Control': 'no-store' } }
        );
    }
}