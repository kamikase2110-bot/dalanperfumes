import { allProducts, errorResponse, getRate, json, toPublic } from '../_lib/catalog.js';

export async function onRequestGet({ env }) {
    try {
        const products = await allProducts(env);
        let rate = null;
        let warning = null;
        try {
            rate = await getRate();
        } catch (error) {
            console.error('No se pudo obtener la cotizacion:', error);
            warning = 'No se pudo actualizar el tipo de cambio. Consulta los precios por WhatsApp.';
        }
        return json({ products: products.map(product => toPublic(product, rate)), rate, warning });
    } catch (error) {
        return errorResponse(error);
    }
}
