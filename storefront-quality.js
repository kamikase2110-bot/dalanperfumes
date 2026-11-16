(() => {
    let activeProduct = null;
    let widget = null;
    let turnstilePromise = null;
    let reviewRequest = 0;
    let orderConditions = 'Cargando condiciones...';

    function showConditions() {
        document.querySelectorAll('[data-order-policy]').forEach(node => { node.textContent = orderConditions; });
    }

    async function api(url, options) {
        const response = await fetch(url, { cache: 'no-store', ...options });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
        return data;
    }

    async function loadInfo() {
        const target = document.getElementById('storeInfo');
        target.textContent = 'Cargando informacion...';
        try {
            const data = await api('/api/store-info');
            orderConditions = data.pedidos;
            const welcomeDescription = document.getElementById('promoDescription');
            if (welcomeDescription) welcomeDescription.textContent = data.aviso;
            showConditions();
            target.innerHTML = '<div class="info-grid"></div>';
            const grid = target.firstElementChild;
            for (const [field, title] of [['entregas', 'Entregas'], ['pagos', 'Pagos'], ['pedidos', 'Pedidos especiales']]) {
                const section = document.createElement('section');
                const heading = document.createElement('h3');
                heading.textContent = title;
                const text = document.createElement('p');
                text.textContent = data[field];
                section.append(heading, text);
                grid.append(section);
            }
        } catch (error) {
            orderConditions = 'No se pudieron cargar las condiciones. Actualiza la informacion de compra o consulta por WhatsApp.';
            showConditions();
            target.textContent = `${error.message} Puedes actualizar esta seccion o consultar por WhatsApp.`;
        }
    }

    function loadTurnstile() {
        if (globalThis.turnstile) return Promise.resolve();
        if (!turnstilePromise) {
            turnstilePromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                script.onload = resolve;
                script.onerror = () => { script.remove(); turnstilePromise = null; reject(new Error('No se pudo cargar la verificacion antispam. Reintenta.')); };
                document.head.append(script);
            });
        }
        return turnstilePromise;
    }

    function removeWidget() {
        if (widget !== null && globalThis.turnstile) globalThis.turnstile.remove(widget);
        widget = null;
    }

    async function loadReviews(id, page = 1) {
        const requestId = ++reviewRequest;
        activeProduct = id;
        removeWidget();
        const target = document.getElementById('productReviews');
        target.textContent = 'Cargando resenas...';
        try {
            const data = await api(`/api/reviews?productId=${id}&page=${page}`);
            if (requestId !== reviewRequest || activeProduct !== id || !target.isConnected) return;
            target.innerHTML = `<h3>Opiniones de clientes</h3>
                <p>${Number(data.summary.total) ? `${escapeHtml(data.summary.promedio)} / 5 · ${escapeHtml(data.summary.total)} opiniones aprobadas` : 'Este perfume aun no tiene resenas.'}</p>
                <div>${data.reviews.map(review => `<article class="review-entry"><strong>${escapeHtml(review.autor)}</strong>
                    <p>${review.puntuacion} / 5 estrellas · ${escapeHtml(new Date(review.created_at).toLocaleDateString('es-BO'))}</p>
                    <p class="review-comment">${escapeHtml(review.comentario)}</p></article>`).join('')}</div>
                <div class="review-pages"></div><div class="review-compose"></div>`;
            const pages = target.querySelector('.review-pages');
            for (const [text, next, disabled] of [['Anterior', page - 1, page === 1], ['Siguiente', page + 1, page * 10 >= Number(data.summary.total)]]) {
                const button = document.createElement('button');
                button.type = 'button'; button.textContent = text; button.disabled = disabled;
                button.onclick = () => loadReviews(id, next);
                pages.append(button);
            }
            const compose = target.querySelector('.review-compose');
            if (!data.siteKey) {
                compose.textContent = 'El envio de nuevas resenas aun no esta habilitado.';
                return;
            }
            compose.innerHTML = `<form class="review-form">
                <h3>Comparte tu experiencia</h3>
                <label>Nombre de pila o alias <input name="autor" maxlength="60" autocomplete="nickname" required></label>
                <label>Tu puntuacion <select name="puntuacion" required><option value="">Selecciona</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}">${n} de 5 estrellas</option>`).join('')}</select></label>
                <label>Tu opinion <textarea name="comentario" maxlength="1000" rows="4" required></textarea></label>
                <small>No escribas telefonos, direcciones ni otros datos privados. Tu alias y opinion seran publicos solo si DALAN aprueba la resena. La verificacion antispam procesa tu conexion y limita envios repetidos.</small>
                <label class="consent"><input name="consentimiento" type="checkbox" required> Autorizo publicar mi alias, puntuacion y comentario en este producto.</label>
                <div class="turnstile-slot"></div>
                <p class="review-status" role="status" aria-live="polite">Cargando verificacion antispam...</p>
                <button type="submit" disabled>Enviar para aprobacion</button>
            </form>`;
            const form = compose.querySelector('form');
            const status = form.querySelector('.review-status');
            const button = form.querySelector('button');
            await loadTurnstile();
            if (requestId !== reviewRequest || activeProduct !== id || !form.isConnected) return;
            widget = globalThis.turnstile.render(form.querySelector('.turnstile-slot'), {
                sitekey: data.siteKey, action: 'review', size: 'compact',
                callback: () => { button.disabled = false; status.textContent = ''; },
                'expired-callback': () => { button.disabled = true; status.textContent = 'La verificacion vencio. Completala de nuevo.'; },
                'error-callback': () => { button.disabled = true; status.textContent = 'No se pudo verificar el envio. Cierra y vuelve a abrir la ficha para reintentar.'; }
            });
            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (button.disabled) return;
                button.disabled = true;
                status.textContent = 'Enviando resena...';
                try {
                    const result = await api('/api/reviews', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            product_id: id, autor: form.elements.autor.value,
                            puntuacion: Number(form.elements.puntuacion.value),
                            comentario: form.elements.comentario.value,
                            consentimiento: form.elements.consentimiento.checked,
                            token: globalThis.turnstile.getResponse(widget)
                        })
                    });
                    form.reset();
                    status.textContent = result.message;
                } catch (error) {
                    status.textContent = `${error.message} Tu comentario sigue en el formulario.`;
                } finally {
                    if (form.isConnected && widget !== null) {
                        button.disabled = true;
                        globalThis.turnstile.reset(widget);
                    }
                }
            });
        } catch (error) {
            if (requestId === reviewRequest && activeProduct === id && target.isConnected) {
                const message = document.createElement('p');
                message.textContent = error.message;
                const retry = document.createElement('button');
                retry.type = 'button'; retry.className = 'details-btn'; retry.textContent = 'Reintentar resenas';
                retry.onclick = () => loadReviews(id, page);
                target.replaceChildren(message, retry);
            }
        }
    }

    globalThis.dalanQuality = { loadInfo, loadReviews, showConditions };
    document.getElementById('productDialog').addEventListener('close', () => { activeProduct = null; removeWidget(); });
    loadInfo();
})();
