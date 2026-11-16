import { pricing, productProfit } from '../../pricing.js';

export { pricing };
export const productFields = 'id,referencia,nombre,marca,tipoStock,inspiracion,notas,imagen,precioUSD,categoria,oculto,version';
export const publicFields = 'id,referencia,nombre,marca,tipoStock,inspiracion,notas,imagen,categoria';

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function json(data, status = 200, headers = {}) {
    return Response.json(data, {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
    });
}

export async function readBody(request, limit) {
    if (Number(request.headers.get('Content-Length')) > limit) {
        throw new HttpError(413, 'El archivo o los datos enviados superan el tamano permitido.');
    }
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > limit) {
                await reader.cancel();
                throw new HttpError(413, 'El archivo o los datos enviados superan el tamano permitido.');
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

export function config(env) {
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
    const anon = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
    if (!env.SUPABASE_URL || !key || !anon) {
        throw new HttpError(503, 'El administrador debe completar la conexion con Supabase.');
    }
    const url = new URL(env.SUPABASE_URL);
    if (url.protocol !== 'https:') throw new HttpError(503, 'La conexion de datos requiere HTTPS.');
    return { url: url.origin, key, anon };
}

export function serviceHeaders(key) {
    return { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) };
}

export async function database(env, resource, options = {}) {
    const { url, key } = config(env);
    const response = await fetch(`${url}/rest/v1/${resource}`, {
        ...options,
        headers: {
            ...serviceHeaders(key),
            'Content-Type': 'application/json',
            ...options.headers
        },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
        console.error('Error de datos:', response.status);
        if (response.status === 409) throw new HttpError(409, 'Ya existe un producto con esa referencia.');
        throw new HttpError(502, 'No se pudieron guardar o consultar los productos. Intenta nuevamente.');
    }
    return response.status === 204 ? null : response.json();
}

export async function allProducts(env, admin = false) {
    const products = [];
    for (let offset = 0; ; offset += 500) {
        const page = await database(env,
            `products?select=${admin ? productFields : `${publicFields},precioUSD`}&order=id.asc&limit=500&offset=${offset}${admin ? '' : '&oculto=eq.false'}`);
        products.push(...page);
        if (page.length < 500) return products;
    }
}

export function calculatePrice(product, rate) {
    if (!Number.isFinite(rate) || rate <= 0 || Number(product.precioUSD) <= 0) return null;
    return (Number(product.precioUSD) + pricing.transporteUSD) * rate +
        productProfit(product);
}

export function toPublic(product, rate) {
    const result = {};
    for (const key of publicFields.split(',')) result[key] = product[key];
    return { ...result, estadoTexto: product.tipoStock === 1 ? 'En stock' : 'Por pedido', precio: calculatePrice(product, rate) };
}

export async function getRate() {
    const response = await fetch('https://api.dolarbluebolivia.click/v1/officialRate', {
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Cotizacion: HTTP ${response.status}`);
    const data = await response.json();
    const rate = Number(data?.data?.blue?.sell);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Cotizacion no valida.');
    return rate;
}

export function validateProduct(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Producto no valido.');
    const result = {};
    const fields = { nombre: 500, marca: 100, referencia: 60, inspiracion: 500, notas: 2000, imagen: 2048 };
    for (const [field, max] of Object.entries(fields)) {
        if (typeof input[field] !== 'string' || input[field].trim().length > max) {
            throw new HttpError(400, `Revisa el campo ${field} (maximo ${max} caracteres).`);
        }
        result[field] = input[field].trim();
    }
    if (!result.nombre) throw new HttpError(400, 'El nombre es obligatorio.');
    if (typeof input.precioUSD !== 'number' || !Number.isFinite(input.precioUSD) || input.precioUSD < 0 || input.precioUSD > 100000) {
        throw new HttpError(400, 'El costo USD debe estar entre 0 y 100000. Usa 0 solo para mostrar "Consultar precio".');
    }
    if (![0, 1].includes(input.tipoStock)) throw new HttpError(400, 'Disponibilidad no valida.');
    if (!['perfume', 'desodorante', 'mini', 'splash', 'locion'].includes(input.categoria)) throw new HttpError(400, 'Categoria no valida.');
    if (typeof input.oculto !== 'boolean') throw new HttpError(400, 'Visibilidad no valida.');
    if (!result.imagen) result.imagen = 'Imagen no disponible';
    if (result.imagen !== 'Imagen no disponible') {
        let url;
        try { url = new URL(result.imagen); } catch { throw new HttpError(400, 'La foto debe ser un enlace HTTPS.'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, 'La foto debe ser un enlace HTTPS.');
    }
    result.referencia = result.referencia || null;
    return { ...result, precioUSD: input.precioUSD, tipoStock: input.tipoStock, categoria: input.categoria, oculto: input.oculto };
}

export function errorResponse(error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error('Error en API de catalogo:', error);
    return json({ error: 'Ocurrio un error en el servidor. Intenta nuevamente.' }, 500);
}
