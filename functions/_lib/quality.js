import { database, HttpError, readBody } from './catalog.js';

export async function readJson(request) {
    const text = new TextDecoder().decode(await readBody(request, 20000));
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'Los datos enviados no son validos.'); }
}

export function positiveId(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, 'Identificador no valido.');
    return value;
}

export function validateInfo(input) {
    const result = {};
    for (const [field, max] of Object.entries({ entregas: 3000, pagos: 3000, pedidos: 5000, aviso: 300 })) {
        if (typeof input?.[field] !== 'string' || !input[field].trim() || input[field].trim().length > max) {
            throw new HttpError(400, `Revisa ${field} (obligatorio, hasta ${max} caracteres).`);
        }
        result[field] = input[field].trim();
    }
    return result;
}

export async function visibleProduct(env, id) {
    const rows = await database(env, `products?select=id&id=eq.${positiveId(id)}&oculto=eq.false`);
    if (!rows.length) throw new HttpError(404, 'Producto no disponible.');
}

export function validateReview(input) {
    const product_id = positiveId(input?.product_id);
    if (!Number.isInteger(input.puntuacion) || input.puntuacion < 1 || input.puntuacion > 5) throw new HttpError(400, 'Selecciona de 1 a 5 estrellas.');
    const result = { product_id, puntuacion: input.puntuacion, consentimiento: true };
    for (const [field, max] of Object.entries({ autor: 60, comentario: 1000 })) {
        if (typeof input[field] !== 'string' || !input[field].trim() || input[field].trim().length > max) {
            throw new HttpError(400, `Revisa ${field} (hasta ${max} caracteres).`);
        }
        result[field] = input[field].trim();
    }
    if (input.consentimiento !== true) throw new HttpError(400, 'Debes autorizar la publicacion de tu resena.');
    return result;
}

export async function verifyReviewRequest(request, env, input) {
    if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) throw new HttpError(503, 'El envio de resenas todavia no esta habilitado.');
    if (typeof input.token !== 'string' || !input.token || input.token.length > 2048) throw new HttpError(400, 'Completa la verificacion antispam.');
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) throw new HttpError(503, 'No se pudo verificar el origen del envio.');
    const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: input.token, remoteip: ip }),
        signal: AbortSignal.timeout(10000)
    });
    if (!verification.ok) throw new HttpError(502, 'No se pudo verificar el envio. Intenta nuevamente.');
    const data = await verification.json();
    if (!data.success || data.hostname !== new URL(request.url).hostname || data.action !== 'review') {
        throw new HttpError(400, 'La verificacion vencio o no es valida. Intenta nuevamente.');
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.TURNSTILE_SECRET_KEY),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(ip)));
    const p_key = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    const accepted = await database(env, 'rpc/consume_review_limit', { method: 'POST', body: JSON.stringify({ p_key }) });
    if (accepted !== true) throw new HttpError(429, 'Ya enviaste varias resenas. Espera una hora antes de intentar nuevamente.');
}
