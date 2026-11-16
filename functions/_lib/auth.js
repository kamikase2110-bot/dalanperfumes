import { config, HttpError } from './catalog.js';

export function checkOrigin(request) {
    if (request.headers.get('Origin') !== new URL(request.url).origin) {
        throw new HttpError(403, 'Solicitud no permitida desde ese origen.');
    }
}

export function cookies(request) {
    return Object.fromEntries((request.headers.get('Cookie') || '').split(';')
        .map(part => part.trim().split('=')).filter(parts => parts.length === 2));
}

export async function authRequest(env, path, body) {
    const { url, anon } = config(env);
    const response = await fetch(`${url}/auth/v1/${path}`, {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
        if (response.status === 429) throw new HttpError(429, 'Demasiados intentos. Espera antes de volver a ingresar.');
        if (response.status >= 500) throw new HttpError(502, 'El servicio de acceso no esta disponible.');
        throw new HttpError(401, 'No se pudo iniciar sesion. Revisa tus datos o vuelve a ingresar.');
    }
    return response.json();
}

export async function requireAdmin(env, token) {
    const { url, anon } = config(env);
    const allowed = (env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length) throw new HttpError(503, 'Falta configurar el acceso del administrador.');
    if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) throw new HttpError(401, 'Inicia sesion para continuar.');
    const response = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: anon, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000)
    });
    if (response.status >= 500) throw new HttpError(502, 'No se pudo comprobar la sesion.');
    if (!response.ok) throw new HttpError(401, 'La sesion vencio. Vuelve a ingresar.');
    const user = await response.json();
    if (!user.email_confirmed_at || !allowed.includes((user.email || '').toLowerCase())) {
        throw new HttpError(403, 'Esta cuenta no tiene acceso al panel.');
    }
    return user;
}

export function setSession(response, session) {
    const options = '; HttpOnly; Secure; SameSite=Strict; Path=/';
    response.headers.append('Set-Cookie', `__Host-dalan_access=${session.access_token}; Max-Age=${Math.min(session.expires_in, 3600)}${options}`);
    response.headers.append('Set-Cookie', `__Host-dalan_refresh=${session.refresh_token}; Max-Age=604800${options}`);
    return response;
}

export function clearSession(response) {
    for (const name of ['__Host-dalan_access', '__Host-dalan_refresh']) {
        response.headers.append('Set-Cookie', `${name}=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/`);
    }
    return response;
}
