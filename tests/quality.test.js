import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validateProduct, toPublic } from '../functions/_lib/catalog.js';
import { validateReview } from '../functions/_lib/quality.js';
import { onRequest as reviews } from '../functions/api/reviews.js';
import { onRequestGet as storeInfo } from '../functions/api/store-info.js';
import { onRequest as admin } from '../functions/api/admin/[[path]].js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ADMIN_EMAILS: 'admin@example.test',
    TURNSTILE_SITE_KEY: 'public-test-key', TURNSTILE_SECRET_KEY: 'private-test-key'
};
const product = {
    nombre: 'Perfume', marca: 'Marca', referencia: '', inspiracion: '', notas: '',
    imagen: 'https://example.test/cover.jpg', precioUSD: 20, tipoStock: 2,
    categoria: 'perfume', oculto: false
};
const input = { product_id: 1, autor: 'Cliente', puntuacion: 5, comentario: 'Mi experiencia', consentimiento: true, token: 'test-token' };
const request = (method, body, path = '/api/reviews', headers = {}) => new Request(`https://dalan.example${path}`, {
    method, headers: { Origin: 'https://dalan.example', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const adminContext = (path, method, body, authenticated = true) => ({
    env, params: { path: [path] },
    request: request(method, body, `/api/admin/${path}`, authenticated ? { Cookie: '__Host-dalan_access=test-token' } : {})
});
function backend({ token = true, limit = true, hostname = 'dalan.example', action = 'review', saved = null } = {}) {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const address = String(url);
        calls.push({ address, ...options });
        if (address.includes('/auth/v1/user')) return Response.json({ email: 'admin@example.test', email_confirmed_at: '2026-01-01' });
        if (address.includes('/siteverify')) return Response.json({ success: token, hostname, action });
        if (address.includes('/rpc/consume_review_limit')) return Response.json(limit);
        if (address.includes('/products?')) return Response.json([{ id: 1 }]);
        if (address.includes('/product_reviews') && options.method === 'POST') {
            assert.equal(options.headers.Prefer, 'return=representation');
            saved?.(JSON.parse(options.body));
            return Response.json([{ id: 1 }], { status: 201 });
        }
        throw new Error(`Unexpected request: ${address}`);
    };
    return calls;
}

test('gallery preserves legacy cover, accepts five photos and rejects extra, duplicate or unsafe entries', () => {
    const images = [1, 2, 3, 4].map(n => `https://example.test/${n}.jpg`);
    const valid = validateProduct({ ...product, imagenes: images, presentacion: ' 100 ml ' });
    assert.equal(valid.presentacion, '100 ml');
    assert.deepEqual(valid.imagenes, images);
    assert.equal(toPublic(valid, 10).estadoTexto, 'Agotado');
    assert.equal(toPublic({ ...valid, tipoStock: 1 }, 10).estadoTexto, 'Disponible');
    assert.equal(validateProduct(product).imagen, product.imagen);
    for (const patch of [
        { imagenes: [...images, 'https://example.test/5.jpg'] },
        { imagenes: [product.imagen] }, { imagenes: [42] },
        { imagenes: ['javascript:alert(1)'] }, { imagenes: ['https://user:pass@example.test/x.jpg'] },
        { imagen: '', imagenes: images }, { presentacion: 'x'.repeat(101) }
    ]) assert.throws(() => validateProduct({ ...product, ...patch }), { status: 400 });
});

test('review requires consent and valid bounded content', () => {
    for (const patch of [
        { product_id: -1 }, { autor: ' ' }, { autor: 'x'.repeat(61) }, { comentario: '' },
        { comentario: 'x'.repeat(1001) }, { puntuacion: 0 }, { puntuacion: 6 },
        { puntuacion: '5' }, { consentimiento: false }
    ]) assert.throws(() => validateReview({ ...input, ...patch }), { status: 400 });
});

test('review submission saves only validated pending data after hostname, action and persistent limit verification', async () => {
    let saved;
    const calls = backend({ saved: value => { saved = value; } });
    const response = await reviews({ env, request: request('POST', { ...input, estado: 'aprobada', version: 99 }) });
    assert.equal(response.status, 201);
    assert.match((await response.json()).message, /pendiente/);
    assert.deepEqual(saved, { product_id: 1, puntuacion: 5, consentimiento: true, autor: 'Cliente', comentario: 'Mi experiencia' });
    const counter = JSON.parse(calls.find(call => call.address.includes('consume_review_limit')).body);
    assert.match(counter.p_key, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(counter).includes('192.0.2.1'));
});

test('review rejects invalid, expired or reused verification and stops before storage', async () => {
    for (const settings of [{ token: false }, { hostname: 'other.example' }, { action: 'login' }]) {
        const calls = backend(settings);
        const response = await reviews({ env, request: request('POST', input) });
        assert.equal(response.status, 400);
        assert.ok(!calls.some(call => call.address.includes('consume_review_limit')));
        assert.ok(!calls.some(call => call.address.includes('/product_reviews')));
    }
});

test('review persistent limit blocks fourth submission without saving', async () => {
    const calls = backend({ limit: false });
    const response = await reviews({ env, request: request('POST', input) });
    assert.equal(response.status, 429);
    assert.ok(!calls.some(call => call.address.includes('/product_reviews')));
});

test('review rejects cross-origin, oversized and missing-consent requests without contacting services', async () => {
    globalThis.fetch = () => assert.fail('Invalid input must not contact services');
    for (const [req, status] of [
        [request('POST', input, '/api/reviews', { Origin: 'https://other.example' }), 403],
        [request('POST', { ...input, consentimiento: false }), 400],
        [request('POST', { ...input, comentario: 'x'.repeat(21000) }), 413]
    ]) assert.equal((await reviews({ env, request: req })).status, status);
});

test('reviews fail closed when anti-spam configuration is missing', async () => {
    const calls = backend();
    const response = await reviews({ env: { ...env, TURNSTILE_SECRET_KEY: '' }, request: request('POST', input) });
    assert.equal(response.status, 503);
    assert.ok(!calls.some(call => call.address.includes('/siteverify') || call.address.includes('/product_reviews')));
});

test('public review query includes only approved public fields and paginates independently from summary', async () => {
    const calls = [];
    globalThis.fetch = async url => {
        const address = String(url); calls.push(address);
        if (address.includes('/products?')) return Response.json([{ id: 1 }]);
        if (address.includes('/rpc/product_review_summary')) return Response.json([{ total: 15, promedio: 4.5 }]);
        assert.ok(address.includes('estado=eq.aprobada'));
        assert.ok(address.includes('select=id,autor,puntuacion,comentario,created_at'));
        assert.ok(address.includes('offset=10'));
        return Response.json([{ id: 2, autor: 'Cliente', puntuacion: 4, comentario: 'Opinion', created_at: '2026-01-01' }]);
    };
    const response = await reviews({ env, request: request('GET', undefined, '/api/reviews?productId=1&page=2') });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.summary.total, 15);
    assert.equal(body.reviews[0].comentario, 'Opinion');
    assert.ok(!JSON.stringify(body).includes('private-test-key'));
    assert.equal(calls.length, 3);
});

test('hidden products have no public reviews or submission path', async () => {
    globalThis.fetch = async url => {
        assert.ok(String(url).includes('oculto=eq.false'));
        return Response.json([]);
    };
    assert.equal((await reviews({ env, request: request('GET', undefined, '/api/reviews?productId=1') })).status, 404);
    assert.equal((await reviews({ env, request: request('POST', input) })).status, 404);
});

test('moderation and business-info editing require administrator and detect concurrent changes', async () => {
    globalThis.fetch = () => assert.fail('No service calls without session');
    for (const path of ['reviews', 'store-info']) {
        assert.equal((await admin(adminContext(path, 'GET', undefined, false))).status, 401);
    }
    globalThis.fetch = async (url, options) => {
        if (String(url).includes('/auth/v1/user')) return Response.json({ email: 'admin@example.test', email_confirmed_at: '2026-01-01' });
        assert.ok(String(url).includes('version=eq.1'));
        const patch = JSON.parse(options.body);
        assert.equal(patch.version, 2);
        assert.ok(!Object.hasOwn(patch, 'comentario'));
        return Response.json([]);
    };
    assert.equal((await admin(adminContext('reviews', 'PUT', { id: 1, version: 1, estado: 'aprobada', comentario: 'Changed' }))).status, 409);
    assert.equal((await admin(adminContext('store-info', 'PUT', { version: 1, entregas: 'Delivery', pagos: 'QR', pedidos: 'Condiciones', aviso: 'Bienvenida' }))).status, 409);
});

test('public business information requests only public text blocks', async () => {
    globalThis.fetch = async url => {
        assert.ok(String(url).includes('select=entregas,pagos,pedidos,aviso'));
        return Response.json([{ entregas: 'Santa Cruz', pagos: 'QR', pedidos: '30 %', aviso: 'Bienvenida' }]);
    };
    const response = await storeInfo({ env });
    assert.deepEqual(await response.json(), { entregas: 'Santa Cruz', pagos: 'QR', pedidos: '30 %', aviso: 'Bienvenida' });
});

test('purchase conditions still load after the welcome notice is closed', async () => {
    const info = { entregas: 'Santa Cruz', pagos: 'QR', pedidos: 'Condiciones del encargo', aviso: 'Bienvenida' };
    const sections = [];
    const policy = { textContent: '' };
    const target = {
        textContent: '',
        firstElementChild: { append: section => sections.push(section) },
        set innerHTML(value) { this.textContent = ''; sections.length = 0; }
    };
    const context = {
        fetch: async () => ({ ok: true, json: async () => info }),
        document: {
            getElementById: id => ({
                storeInfo: target, promoDescription: null,
                productDialog: { addEventListener() {} }
            })[id],
            querySelectorAll: () => [policy],
            createElement: () => ({ textContent: '', append(...children) { this.children = children; } })
        }
    };
    runInNewContext(await readFile(new URL('../storefront-quality.js', import.meta.url), 'utf8'), context);
    await context.dalanQuality.loadInfo();
    assert.equal(policy.textContent, info.pedidos);
    assert.equal(target.textContent, '');
    assert.deepEqual(sections.map(section => section.children[1].textContent), [info.entregas, info.pagos, info.pedidos]);
});
