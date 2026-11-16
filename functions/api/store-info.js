import { database, errorResponse, HttpError, json } from '../_lib/catalog.js';

export async function onRequestGet({ env }) {
    try {
        const rows = await database(env, 'store_info?select=entregas,pagos,pedidos,aviso&id=eq.1');
        if (!rows.length) throw new HttpError(503, 'La informacion de compra aun no esta disponible.');
        return json(rows[0]);
    } catch (error) { return errorResponse(error); }
}
