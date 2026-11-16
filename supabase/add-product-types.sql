begin;

alter table public.products
    drop constraint products_categoria_check,
    add constraint products_categoria_check
        check (categoria in ('perfume', 'desodorante', 'mini', 'splash', 'locion'));

commit;
