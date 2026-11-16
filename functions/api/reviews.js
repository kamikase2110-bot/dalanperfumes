import { database, errorResponse, HttpError, json } from '../_lib/catalog.js';
import { checkOrigin } from '../_lib/auth.js';
import { positiveId, readJson, validateReview, verifyReviewRequest, visibleProduct } from '../_lib/quality.js';
import { features } from '../../product-info.js';

export async function onRequest({ request, env }) {
    try {
        if (!features.reviews) throw new HttpError(503, 'Las resenas estan pausadas temporalmente.');
        if (request.method === 'GET') {
            const url = new URL(request.url);
            const id = positiveId(Number(url.searchParams.get('productId')));
            const page = positiveId(Number(url.searchParams.get('page') || 1));
            if (page > 10000) throw new HttpError(400, 'Pagina no valida.');
            await visibleProduct(env, id);
            const [reviews, summary] = await Promise.all([
                database(env, `product_reviews?select=id,autor,puntuacion,comentario,created_at&product_id=eq.${id}&estado=eq.aprobada&order=created_at.desc,id.desc&limit=10&offset=${(page - 1) * 10}`),
                database(env, 'rpc/product_review_summary', { method: 'POST', body: JSON.stringify({ p_product_id: id }) })
            ]);
            if (!summary.length) throw new HttpError(502, 'No se pudo obtener el resumen de resenas.');
            return json({ reviews, summary: summary[0], page,
                siteKey: env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY || null : null });
        }
        if (request.method !== 'POST') throw new HttpError(405, 'Metodo no permitido.');
        checkOrigin(request);
        const input = await readJson(request);
        const review = validateReview(input);
        await visibleProduct(env, review.product_id);
        await verifyReviewRequest(request, env, input);
        await database(env, 'product_reviews?select=id', {
            method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(review)
        });
        return json({ message: 'Gracias. Tu resena fue recibida y esta pendiente de aprobacion.' }, 201);
    } catch (error) { return errorResponse(error); }
}
