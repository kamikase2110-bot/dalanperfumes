begin;

alter table public.products drop constraint if exists "products_tipoStock_check";
alter table public.products add constraint "products_tipoStock_check" check ("tipoStock" in (0, 1, 2));
alter table public.products add column if not exists presentacion text not null default ''
    check (length(presentacion) <= 100);
alter table public.products add column if not exists imagenes jsonb not null default '[]'
    check (jsonb_typeof(imagenes) = 'array' and jsonb_array_length(imagenes) <= 4);

create table if not exists public.store_info (
    id smallint primary key check (id = 1),
    entregas text not null check (length(entregas) between 1 and 3000),
    pagos text not null check (length(pagos) between 1 and 3000),
    pedidos text not null check (length(pedidos) between 1 and 5000),
    aviso text not null default 'Compra con confianza en DALAN. Los pedidos especiales tardan de 5 a 7 dias calendario desde el encargo al proveedor, despues de recibir el anticipo.'
        check (length(aviso) between 1 and 300),
    version integer not null default 1 check (version > 0)
);
insert into public.store_info (id, entregas, pagos, pedidos) values (1,
    'Delivery dentro de la ciudad de Santa Cruz. Envios a provincias y otros departamentos mediante transportadoras. El delivery y el transporte se cobran por separado y se pagan al recibir o retirar en agencia. Consulta el costo segun tu destino.',
    'Aceptamos transferencias y pagos por QR. Solicita los datos de pago directamente a DALAN por WhatsApp.',
    'Los pedidos especiales requieren un anticipo del 30 % del valor del producto. El plazo es de 5 a 7 dias calendario desde que DALAN realiza el encargo al proveedor, despues de recibir el anticipo. Si el cliente cancela despues de realizado el encargo al proveedor, pierde el anticipo; esta penalizacion no se aplica si DALAN o el proveedor no pueden cumplir. Desde el aviso de llegada tienes 10 dias adicionales para completar el pago o coordinar el retiro. Si necesitas mas tiempo, comunicate con DALAN para coordinar. Los trayectos posteriores de transportadora se coordinan por separado.')
on conflict (id) do nothing;

create table if not exists public.product_reviews (
    id bigint generated always as identity primary key,
    product_id bigint not null references public.products(id),
    autor text not null check (length(trim(autor)) between 1 and 60),
    puntuacion smallint not null check (puntuacion between 1 and 5),
    comentario text not null check (length(trim(comentario)) between 1 and 1000),
    consentimiento boolean not null check (consentimiento),
    estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada', 'oculta')),
    created_at timestamptz not null default now(),
    version integer not null default 1 check (version > 0)
);
create index if not exists reviews_product_state on public.product_reviews(product_id, estado, created_at desc, id desc);
create index if not exists reviews_moderation on public.product_reviews(estado, created_at desc, id desc);

create table if not exists public.review_limits (
    key text primary key,
    attempts integer not null check (attempts between 1 and 3),
    expires_at timestamptz not null
);
create index if not exists review_limits_expiry on public.review_limits(expires_at);

create or replace function public.consume_review_limit(p_key text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare accepted boolean;
begin
    delete from public.review_limits where expires_at <= now();
    insert into public.review_limits as limits (key, attempts, expires_at)
    values (p_key, 1, now() + interval '1 hour')
    on conflict (key) do update set attempts = limits.attempts + 1
        where limits.attempts < 3
    returning true into accepted;
    return coalesce(accepted, false);
end;
$$;
revoke all on function public.consume_review_limit(text) from public, anon, authenticated;
grant execute on function public.consume_review_limit(text) to service_role;

create or replace function public.product_review_summary(p_product_id bigint)
returns table(total bigint, promedio numeric)
language sql stable security definer set search_path = public, pg_temp as $$
    select count(*), round(avg(puntuacion), 1)
    from public.product_reviews where product_id = p_product_id and estado = 'aprobada';
$$;
revoke all on function public.product_review_summary(bigint) from public, anon, authenticated;
grant execute on function public.product_review_summary(bigint) to service_role;

alter table public.store_info enable row level security;
alter table public.product_reviews enable row level security;
alter table public.review_limits enable row level security;
revoke all on public.store_info, public.product_reviews, public.review_limits from public, anon, authenticated;
grant all on public.store_info, public.product_reviews, public.review_limits to service_role;
grant usage, select on sequence public.product_reviews_id_seq to service_role;

commit;
