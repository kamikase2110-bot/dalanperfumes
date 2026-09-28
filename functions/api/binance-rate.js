export async function onRequestGet() {
    try {
        const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://p2p.binance.com',
                'Referer': 'https://p2p.binance.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
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