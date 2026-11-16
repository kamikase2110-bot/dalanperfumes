import { allProducts, config, database, errorResponse, getRate, HttpError, json, pricing, productFields, readBody, serviceHeaders, validateProduct } from '../../_lib/catalog.js';
import { authRequest, checkOrigin, clearSession, cookies, requireAdmin, setSession } from '../../_lib/auth.js';
import { positiveId, readJson, validateInfo } from '../../_lib/quality.js';
import { features } from '../../../product-info.js';

async function uploadImage(request, env) {
    const type = request.headers.get('Content-Type');
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    if (!extensions[type]) throw new HttpError(400, 'Selecciona una foto JPG, PNG o WebP.');
    const bytes = await readBody(request, 4 * 1024 * 1024);
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new HttpError(413, 'La foto debe pesar como maximo 4 MB.');
    const valid = type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
        type === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) :
        String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!valid) throw new HttpError(400, 'El contenido del archivo no corresponde a una foto permitida.');
    const { url, key } = config(env);
    const path = `${crypto.randomUUID()}.${extensions[type]}`;
    const response = await fetch(`${url}/storage/v1/object/product-images/${path}`, {
        method: 'POST',
        headers: { ...serviceHeaders(key), 'Content-Type': type },
        body: bytes,
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
        console.error('Error al subir foto:', response.status);
        throw new HttpError(502, 'No se pudo subir la foto. Revisa el almacenamiento e intenta nuevamente.');
    }
    return json({ url: `${url}/storage/v1/object/public/product-images/${path}` }, 201);
}

export async function onRequest({ request, env, params }) {
    try {
        const path = Array.isArray(params.path) ? params.path.join('/') : params.path;
        const method = request.method;
        if (method !== 'GET') checkOrigin(request);
        const sessionCookies = cookies(request);

        if (path === 'session' && method === 'POST') {
            const input = await readJson(request);
            if (typeof input?.email !== 'string' || typeof input?.password !== 'string' || input.email.length > 254 || input.password.length > 1024) {
                throw new HttpError(400, 'Ingresa correo y contrasena.');
            }
            const session = await authRequest(env, 'token?grant_type=password', { email: input.email.trim(), password: input.password });
            const user = await requireAdmin(env, session.access_token);
            return setSession(json({ email: user.email }), session);
        }
        if (path === 'refresh' && method === 'POST') {
            const token = sessionCookies['__Host-dalan_refresh'];
            if (!token) throw new HttpError(401, 'Vuelve a iniciar sesion.');
            const session = await authRequest(env, 'token?grant_type=refresh_token', { refresh_token: token });
            const user = await requireAdmin(env, session.access_token);
            return setSession(json({ email: user.email }), session);
        }
        if (path === 'session' && method === 'DELETE') {
            const token = sessionCookies['__Host-dalan_access'];
            if (token) {
                const { url, anon } = config(env);
                const response = await fetch(`${url}/auth/v1/logout?scope=local`, {
                    method: 'POST',
                    headers: { apikey: anon, Authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok && response.status !== 401 && response.status !== 403) {
                    throw new HttpError(502, 'No se pudo cerrar la sesion. Intenta nuevamente.');
                }
            }
            return clearSession(json({ ok: true }));
        }

        const user = await requireAdmin(env, sessionCookies['__Host-dalan_access']);
        if (path === 'session' && method === 'GET') return json({ email: user.email });
        if (path === 'store-info' && method === 'GET') {
            const rows = await database(env, 'store_info?select=*&id=eq.1');
            if (!rows.length) throw new HttpError(503, 'Falta inicializar la informacion de compra.');
            return json(rows[0]);
        }
        if (path === 'store-info' && method === 'PUT') {
            const input = await readJson(request);
            const version = positiveId(input.version);
            const rows = await database(env, `store_info?id=eq.1&version=eq.${version}`, {
                method: 'PATCH', headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ ...validateInfo(input), version: version + 1 })
            });
            if (!rows.length) throw new HttpError(409, 'Las condiciones cambiaron. Recarga antes de guardar.');
            return json(rows[0]);
        }
        if (path === 'reviews' && !features.reviews) throw new HttpError(503, 'Las resenas estan pausadas temporalmente.');
        if (path === 'reviews' && method === 'GET') {
            const url = new URL(request.url);
            const state = url.searchParams.get('state') || 'pendiente';
            const page = positiveId(Number(url.searchParams.get('page') || 1));
            if (!['pendiente', 'aprobada', 'rechazada', 'oculta'].includes(state) || page > 10000) throw new HttpError(400, 'Filtro no valido.');
            const reviews = await database(env, `product_reviews?select=*&estado=eq.${state}&order=created_at.desc,id.desc&limit=26&offset=${(page - 1) * 25}`);
            return json({ reviews: reviews.slice(0, 25), hasNext: reviews.length > 25 });
        }
        if (path === 'reviews' && method === 'PUT') {
            const input = await readJson(request);
            const id = positiveId(input.id);
            const version = positiveId(input.version);
            if (!['aprobada', 'rechazada', 'oculta'].includes(input.estado)) throw new HttpError(400, 'Estado de resena no valido.');
            const rows = await database(env, `product_reviews?id=eq.${id}&version=eq.${version}`, {
                method: 'PATCH', headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ estado: input.estado, version: version + 1 })
            });
            if (!rows.length) throw new HttpError(409, 'Esta resena cambio. Recarga la lista.');
            return json({ review: rows[0] });
        }
        if (path === 'image' && method === 'POST') return await uploadImage(request, env);
        if (path === 'products' && method === 'GET') {
            const products = await allProducts(env, true);
            let rate = null;
            let warning = null;
            try { rate = await getRate(); } catch (error) {
                console.error('No se pudo obtener la cotizacion del panel:', error);
                warning = 'No hay cotizacion disponible. Puedes guardar costos, pero no ver el precio final.';
            }
            return json({ products, rate, pricing, warning });
        }
        if (path === 'products' && ['POST', 'PUT'].includes(method)) {
            const input = await readJson(request);
            const product = validateProduct(input);
            let resource = `products?select=${productFields}`;
            if (method === 'PUT') {
                if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.version) || input.version <= 0) {
                    throw new HttpError(400, 'Identificador o version no validos. Recarga el producto.');
                }
                resource += `&id=eq.${input.id}&version=eq.${input.version}`;
                product.version = input.version + 1;
            }
            const saved = await database(env, resource, {
                method: method === 'POST' ? 'POST' : 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify(product)
            });
            if (!saved.length) throw new HttpError(409, 'Este producto cambio en otra ventana. Recarga la lista antes de guardar.');
            return json({ product: saved[0] }, method === 'POST' ? 201 : 200);
        }
        throw new HttpError(404, 'Operacion no encontrada.');
    } catch (error) {
        return errorResponse(error);
    }
}
