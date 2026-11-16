import { productProfit } from './pricing.js';
import { availability, productImages } from './product-info.js';

const $ = id => document.getElementById(id);
const form = $('product-form');
let products = [];
let selected = null;
let rate = null;
let pricing = null;
let dirty = false;
let busy = false;
let page = 1;
let gallery = [];
let infoVersion = null;
let infoDirty = false;
let reviewPage = 1;
let reviewLoading = false;
let reviewHasNext = false;
const pageSize = 25;

function status(message, error = false) {
    $('status').textContent = message;
    $('status').dataset.error = String(error);
}

function showLogin() {
    $('login-section').hidden = false;
    $('panel').hidden = true;
    $('logout').hidden = true;
}

async function request(path, options = {}, retry = true) {
    const response = await fetch(`/api/admin/${path}`, { ...options, credentials: 'same-origin' });
    if (response.status === 401 && retry && !['refresh', 'session'].includes(path)) {
        await request('refresh', { method: 'POST' }, false);
        return request(path, options, false);
    }
    const body = await response.json().catch(() => { throw new Error('El servidor no devolvio una respuesta valida. Revisa la configuracion de Cloudflare.'); });
    if (!response.ok) {
        if (response.status === 401) showLogin();
        throw new Error(body.error || `No se pudo completar la operacion (${response.status}).`);
    }
    return body;
}

function sendJson(method, data) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function confirmDiscard() {
    return !dirty || window.confirm('Tienes cambios de producto sin guardar. Deseas descartarlos?');
}

function setBusy(value) {
    busy = value;
    document.querySelectorAll('#panel button, #product-form input, #product-form select, #product-form textarea, #logout')
        .forEach(element => { element.disabled = value; });
    if (!value) { renderList(); updatePhoto(); }
    $('save-info').disabled = value || infoVersion === null;
    $('review-state').disabled = value || reviewLoading;
    $('review-previous').disabled = value || reviewLoading || reviewPage <= 1;
    $('review-next').disabled = value || reviewLoading || !reviewHasNext;
}

function renderList() {
    const query = $('search').value.trim().toLocaleLowerCase('es');
    const visibility = $('visibility').value;
    const filtered = products.filter(product =>
        `${product.nombre} ${product.marca} ${product.referencia || ''}`.toLocaleLowerCase('es').includes(query) &&
        (visibility === 'all' || (visibility === 'hidden' ? product.oculto : !product.oculto)));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages);
    $('count').textContent = `(${filtered.length})`;
    $('product-list').replaceChildren();
    for (const product of filtered.slice((page - 1) * pageSize, page * pageSize)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'product-row';
        button.setAttribute('aria-pressed', String(selected?.id === product.id));
        button.textContent = product.nombre;
        const detail = document.createElement('small');
        detail.textContent = `${product.marca || 'Sin marca'} · USD ${product.precioUSD} · ${product.oculto ? 'Oculto' : availability(product).label}`;
        button.append(detail);
        button.disabled = busy;
        button.addEventListener('click', () => {
            if (!busy && confirmDiscard()) edit(product);
        });
        $('product-list').append(button);
    }
    if (!filtered.length) $('product-list').textContent = 'No hay productos que coincidan.';
    $('page').textContent = `${page} / ${pages}`;
    $('previous').disabled = busy || page <= 1;
    $('next').disabled = busy || page >= pages;
}

function clearPendingPhoto() {
    for (const entry of gallery) if (entry.file) URL.revokeObjectURL(entry.url);
    gallery = [];
    $('photo-file').value = '';
}

function updatePhoto() {
    const value = gallery[0]?.url;
    form.elements.imagen.value = value || '';
    $('photo-preview').hidden = !value;
    if (value) $('photo-preview').src = value;
    else $('photo-preview').removeAttribute('src');
    $('gallery-editor').replaceChildren();
    gallery.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'gallery-row';
        const img = document.createElement('img');
        img.src = entry.url; img.alt = index === 0 ? 'Portada' : `Foto ${index + 1}`;
        const label = document.createElement('span');
        label.textContent = `${index === 0 ? 'Portada' : `Foto ${index + 1}`}${entry.file ? ' (pendiente de subir)' : ''}`;
        row.append(img, label);
        for (const [text, action, disabled] of [
            ['Subir', () => { [gallery[index - 1], gallery[index]] = [gallery[index], gallery[index - 1]]; }, index === 0],
            ['Bajar', () => { [gallery[index + 1], gallery[index]] = [gallery[index], gallery[index + 1]]; }, index === gallery.length - 1],
            ['Quitar', () => { if (entry.file) URL.revokeObjectURL(entry.url); gallery.splice(index, 1); }, false]
        ]) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'secondary'; button.textContent = text; button.disabled = busy || disabled;
            button.setAttribute('aria-label', `${text} foto ${index + 1}`);
            button.onclick = () => { action(); dirty = true; updatePhoto(); };
            row.append(button);
        }
        $('gallery-editor').append(row);
    });
}

function previewPrice() {
    if (!pricing) return;
    const cost = Number(form.elements.precioUSD.value);
    const profit = productProfit({
        nombre: form.elements.nombre.value,
        categoria: form.elements.categoria.value
    }, pricing);
    if (!rate) {
        $('price-preview').textContent = 'Sin cotizacion disponible: el precio final se mostrara para consultar.';
    } else if (cost > 0) {
        const total = (cost + pricing.transporteUSD) * rate + profit;
        $('price-preview').textContent = `Precio en tienda: Bs ${Math.round(total)} · (${cost} + ${pricing.transporteUSD}) × ${rate} + ${profit} Bs. La tasa puede cambiar.`;
    } else {
        $('price-preview').textContent = 'Con costo 0 se muestra "Consultar precio". Ingresa un costo mayor que 0 para calcularlo.';
    }
}

function edit(product = null) {
    selected = product ? { ...product } : null;
    form.reset();
    clearPendingPhoto();
    for (const field of ['nombre', 'marca', 'referencia', 'inspiracion', 'notas', 'precioUSD', 'tipoStock', 'categoria', 'presentacion']) {
        if (product) form.elements[field].value = product[field] ?? '';
    }
    gallery = product ? productImages(product).map(url => ({ url })) : [];
    form.elements.oculto.checked = product?.oculto || false;
    $('editor-title').textContent = product ? `Editar producto #${product.id}` : 'Agregar producto';
    dirty = false;
    updatePhoto();
    previewPrice();
    renderList();
}

async function loadProducts(keepEditor = false) {
    const data = await request('products');
    products = data.products;
    rate = data.rate;
    pricing = data.pricing;
    $('pricing').textContent = `Transporte: USD ${pricing.transporteUSD} · Ganancia perfumes: ${pricing.gananciaBs} Bs · Minis/desodorantes/splash/lociones: ${pricing.gananciaDesodorantesMinisBs} Bs`;
    $('brands').replaceChildren();
    for (const brand of [...new Set(products.map(product => product.marca).filter(Boolean))].sort()) {
        const option = document.createElement('option');
        option.value = brand;
        $('brands').append(option);
    }
    if (!keepEditor) edit(selected ? products.find(product => product.id === selected.id) : null);
    else { renderList(); previewPrice(); }
    status(data.warning || `${products.length} productos cargados. Los cambios se publican al guardar.`, Boolean(data.warning));
}

async function showPanel(email) {
    $('account').textContent = email;
    $('login-section').hidden = true;
    $('panel').hidden = false;
    $('logout').hidden = false;
    setBusy(true);
    try {
        await loadProducts(dirty);
        await Promise.all([infoDirty ? Promise.resolve() : loadInfo(), loadReviews()]);
    } finally { setBusy(false); }
}

$('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const login = event.currentTarget;
    const button = login.querySelector('button');
    button.disabled = true;
    status('Ingresando...');
    try {
        const data = await request('session', sendJson('POST', {
            email: login.elements.email.value,
            password: login.elements.password.value
        }), false);
        login.elements.password.value = '';
        await showPanel(data.email);
    } catch (error) {
        status(error.message, true);
    } finally { button.disabled = false; }
});

form.addEventListener('input', () => { dirty = true; previewPrice(); });
$('photo-file').addEventListener('change', event => {
    const files = [...event.target.files];
    if (!files.length) return;
    if (files.length + gallery.length > 5 || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024)) {
        event.target.value = '';
        status('Maximo cinco fotos en total. Cada foto debe ser JPG, PNG o WebP de hasta 4 MB.', true);
        return;
    }
    gallery.push(...files.map(file => ({ file, url: URL.createObjectURL(file) })));
    event.target.value = '';
    dirty = true;
    updatePhoto();
});
$('add-photo-url').addEventListener('click', () => {
    const value = $('gallery-url').value.trim();
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Usa un enlace HTTPS sin credenciales.');
        if (gallery.length >= 5) throw new Error('Ya hay cinco fotos en la galeria.');
        if (gallery.some(entry => entry.url === value)) throw new Error('Esta foto ya esta en la galeria.');
        gallery.push({ url: value }); dirty = true; $('gallery-url').value = ''; updatePhoto();
    } catch (error) { status(`No se agrego la foto: ${error.message}`, true); }
});
$('photo-preview').addEventListener('error', () => {
    $('photo-preview').hidden = true;
    status('No se pudo mostrar la foto. Revisa el enlace o selecciona otra imagen.', true);
});
$('clear-photo').addEventListener('click', () => {
    clearPendingPhoto();
    form.elements.imagen.value = '';
    dirty = true;
    updatePhoto();
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const product = {
        nombre: form.elements.nombre.value,
        marca: form.elements.marca.value,
        referencia: form.elements.referencia.value,
        inspiracion: form.elements.inspiracion.value,
        presentacion: form.elements.presentacion.value,
        notas: form.elements.notas.value,
        imagen: form.elements.imagen.value,
        precioUSD: Number(form.elements.precioUSD.value),
        tipoStock: Number(form.elements.tipoStock.value),
        categoria: form.elements.categoria.value,
        oculto: form.elements.oculto.checked,
        ...(selected ? { id: selected.id, version: selected.version } : {})
    };
    setBusy(true);
    status('Guardando...');
    try {
        for (const entry of gallery) {
            if (!entry.file) continue;
            const photo = await request('image', { method: 'POST', headers: { 'Content-Type': entry.file.type }, body: entry.file });
            URL.revokeObjectURL(entry.url);
            entry.url = photo.url;
            delete entry.file;
        }
        product.imagen = gallery[0]?.url || '';
        product.imagenes = gallery.slice(1).map(entry => entry.url);
        updatePhoto();
        const data = await request('products', sendJson(selected ? 'PUT' : 'POST', product));
        const index = products.findIndex(item => item.id === data.product.id);
        if (index >= 0) products[index] = data.product;
        else products.push(data.product);
        edit(data.product);
        status(data.product.oculto ? 'Producto guardado y oculto de la tienda.' : 'Producto guardado y publicado. Recarga la tienda para verlo.');
    } catch (error) {
        status(`${error.message} Tus cambios siguen en el formulario.`, true);
    } finally { setBusy(false); }
});

$('new').addEventListener('click', () => {
    if (!busy && confirmDiscard()) { edit(); form.elements.nombre.focus(); }
});
$('discard').addEventListener('click', () => { if (!busy && confirmDiscard()) edit(selected); });
$('reload').addEventListener('click', async () => {
    if (busy || !confirmDiscard()) return;
    setBusy(true);
    try { await loadProducts(); await loadReviews(); } catch (error) { status(error.message, true); } finally { setBusy(false); }
});
for (const id of ['search', 'visibility']) $(id).addEventListener('input', () => { page = 1; renderList(); });
$('previous').addEventListener('click', () => { page--; renderList(); });
$('next').addEventListener('click', () => { page++; renderList(); });
$('logout').addEventListener('click', async () => {
    if (busy || !confirmDiscard() || (infoDirty && !window.confirm('Hay condiciones sin guardar. Deseas cerrar sesion?'))) return;
    setBusy(true);
    try {
        await request('session', { method: 'DELETE' }, false);
        dirty = false;
        infoDirty = false;
        infoVersion = null;
        products = [];
        edit();
        showLogin();
        status('Sesion cerrada.');
    } catch (error) { status(error.message, true); } finally { setBusy(false); }
});
window.addEventListener('beforeunload', event => {
    if (dirty || infoDirty || busy) { event.preventDefault(); event.returnValue = ''; }
});

async function loadInfo() {
    try {
        const info = await request('store-info');
        for (const field of ['entregas', 'pagos', 'pedidos', 'aviso']) $('info-form').elements[field].value = info[field];
        infoVersion = info.version; infoDirty = false;
        $('info-status').textContent = 'Los cambios se publican al guardar.';
        $('save-info').disabled = false;
    } catch (error) { $('info-status').textContent = error.message; }
}
$('info-form').addEventListener('input', () => { infoDirty = true; });
$('reload-info').addEventListener('click', () => {
    if (!busy && (!infoDirty || window.confirm('Descartar las condiciones sin guardar?'))) loadInfo();
});
$('info-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !infoVersion) return;
    setBusy(true);
    try {
        const elements = event.currentTarget.elements;
        const data = await request('store-info', sendJson('PUT', {
            version: infoVersion, entregas: elements.entregas.value,
            pagos: elements.pagos.value, pedidos: elements.pedidos.value, aviso: elements.aviso.value
        }));
        infoVersion = data.version; infoDirty = false;
        $('info-status').textContent = 'Condiciones guardadas y publicadas.';
    } catch (error) { $('info-status').textContent = `${error.message} Tus cambios siguen en el formulario.`; }
    finally { setBusy(false); }
});

async function loadReviews() {
    if (reviewLoading) return;
    reviewLoading = true;
    $('review-state').disabled = true;
    $('review-previous').disabled = true;
    $('review-next').disabled = true;
    $('review-status').textContent = 'Cargando resenas...';
    try {
        const data = await request(`reviews?state=${$('review-state').value}&page=${reviewPage}`);
        $('review-list').replaceChildren();
        for (const review of data.reviews) {
            const article = document.createElement('article');
            article.className = 'review-admin';
            const title = document.createElement('h3');
            title.textContent = products.find(product => product.id === review.product_id)?.nombre || `Producto #${review.product_id}`;
            const author = document.createElement('p');
            author.textContent = `${review.autor} · ${review.puntuacion}/5 · ${new Date(review.created_at).toLocaleDateString('es-BO')}`;
            const comment = document.createElement('p');
            comment.className = 'review-comment'; comment.textContent = review.comentario;
            article.append(title, author, comment);
            for (const [text, state] of [['Aprobar', 'aprobada'], ['Rechazar', 'rechazada'], ['Ocultar', 'oculta']]) {
                if (state === review.estado) continue;
                const button = document.createElement('button');
                button.type = 'button'; button.textContent = text;
                button.onclick = async () => {
                    if (busy || reviewLoading) return;
                    setBusy(true);
                    try {
                        await request('reviews', sendJson('PUT', { id: review.id, version: review.version, estado: state }));
                        await loadReviews();
                    } catch (error) { $('review-status').textContent = error.message; }
                    finally { setBusy(false); }
                };
                article.append(button);
            }
            $('review-list').append(article);
        }
        $('review-status').textContent = data.reviews.length ? 'Solo las aprobadas aparecen en la tienda.' : 'No hay resenas en este estado.';
        $('review-page').textContent = `Pagina ${reviewPage}`;
        $('review-previous').disabled = reviewPage <= 1;
        reviewHasNext = data.hasNext;
        $('review-next').disabled = !reviewHasNext;
    } catch (error) { $('review-status').textContent = error.message; }
    finally { reviewLoading = false; $('review-state').disabled = false; }
}
$('review-state').addEventListener('change', () => { reviewPage = 1; loadReviews(); });
$('reload-reviews').addEventListener('click', () => { if (!busy) loadReviews(); });
$('review-previous').addEventListener('click', () => { if (!reviewLoading && !busy && reviewPage > 1) { reviewPage--; loadReviews(); } });
$('review-next').addEventListener('click', () => { if (!reviewLoading && !busy) { reviewPage++; loadReviews(); } });

async function initialize() {
    try {
        let response = await fetch('/api/admin/session', { credentials: 'same-origin' });
        if (response.status === 401) {
            response = await fetch('/api/admin/refresh', { method: 'POST', credentials: 'same-origin' });
        }
        const data = await response.json();
        if (!response.ok) {
            showLogin();
            if (response.status === 401) status('Ingresa para administrar el catalogo.');
            else status(data.error || 'No se pudo comprobar el acceso.', true);
            return;
        }
        await showPanel(data.email);
    } catch (error) {
        showLogin();
        status(`No se pudo abrir el panel: ${error.message}`, true);
    }
}
initialize();
