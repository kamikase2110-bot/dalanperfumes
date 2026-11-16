# DALAN: tienda y panel privado

La tienda mantiene su diseno y pedidos por WhatsApp. El panel se abre en `/admin`.
Los productos se guardan en Supabase; Cloudflare Pages Functions verifica al
administrador y calcula los precios sin enviar costos USD al navegador publico.

## Activacion inicial

**No desplegar esta version en produccion hasta completar estos pasos.**
El catalogo ahora necesita Supabase; no existe un respaldo publico con costos
incrustados en el HTML.

1. Crear un proyecto de Supabase.
2. En su SQL Editor, ejecutar primero `supabase/schema.sql` y despues
   `supabase/seed.sql`. Este ultimo importa los **663 productos actuales**,
   conservando IDs, referencias, costos, fotos, notas y marcas normalizadas.
   No modifica productos cuyos IDs ya existan: no usarlo como restauracion.
3. En Authentication > Users, crear la cuenta del administrador con correo
   confirmado y contrasena fuerte. Desactivar registros publicos en la
   configuracion de Authentication. El panel no permite crear cuentas.
4. En Cloudflare > Workers & Pages > proyecto de Pages > Settings, configurar
   estas variables para el entorno de despliegue:

   | Variable | Valor |
   | --- | --- |
   | `SUPABASE_URL` | URL HTTPS del proyecto de Supabase |
   | `SUPABASE_PUBLISHABLE_KEY` | Clave `Publishable key` (`sb_publishable_...`) del proyecto |
   | `SUPABASE_SECRET_KEY` | Clave `Secret key` (`sb_secret_...`), **como secreto** |
   | `ADMIN_EMAILS` | Correo confirmado del administrador; varios separados por coma |

   Obtener las claves en la configuracion API del proyecto de Supabase.
   No pegar claves en el codigo, GitHub ni conversaciones. La clave
   `Secret key` solo debe existir como secreto de Cloudflare o localmente en
   `.dev.vars` (ignorado por Git).
   Si se usan claves antiguas, tambien se admiten las variables
   `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. Las claves nuevas se envian
   en `apikey`, no como JWT en Authorization.
5. Configurar el build de Cloudflare Pages:
   - Comando: `npm run build`
   - Directorio de salida: `dist`
   - Directorio raiz: el de este proyecto.
   - Node.js: 22 o superior compatible con Wrangler.
   - Conservar `functions` en la raiz del proyecto: Pages lo compila como Functions.
6. Primero crear un despliegue de **vista previa**, con las variables configuradas
   tambien para Preview. Preferir otro proyecto de Supabase para no modificar los
   productos de produccion durante las pruebas.
7. En esa vista previa, comprobar:
   - `/api/catalog` carga productos y precios, sin `precioUSD`.
   - `/admin` permite ingresar solo con la cuenta autorizada.
   - Crear un producto oculto, subir una foto y guardar. Recargar y verificar que
     los datos se conservan; hacerlo visible y comprobarlo en la tienda.
   - Editar stock, notas, inspiracion y costo; comprobar el nuevo precio.
   - Cerrar sesion y comprobar que las operaciones privadas ya no funcionan.
8. Solo despues de verificarlo, publicar en produccion.

**Publicar exclusivamente `dist`, nunca la raiz del repositorio.**
`supabase/seed.sql` contiene costos privados. El build copia solamente los
archivos publicos necesarios; no publica SQL, PDFs, pruebas ni scripts.
El historial anterior de Git ya contenia costos en el HTML: este cambio no
borra ese historial ni convierte un repositorio publico en privado.

## Uso diario

### Catalogo en celular

- Portada compacta y dos productos por fila desde 360 px; una columna en
  pantallas mas estrechas. Las fotos se muestran completas, sin ampliacion.
- Tocar la foto o **Ver detalles** abre la ficha con descripcion y todas las
  notas. Se cierra con el boton, Escape o el fondo, sin perder filtros ni pagina.
- El buscador queda visible; **Filtrar** abre marca, tipo, disponibilidad y orden
  de precio. Los criterios se combinan y se aplican inmediatamente.
  **Limpiar filtros** tambien borra la busqueda.
- Splash y lociones antiguos se reconocen por nombre con el mismo helper de
  tipos que utiliza el calculo de ganancia, sin editar su categoria guardada.
- La paginacion conserva 24 productos y muestra Anterior, Pagina X de Y y
  Siguiente. Precios, carrito, WhatsApp y administracion no cambian.
- **Decants** pregunta primero el perfume y, al pulsar **Siguiente**, la cantidad
  libre de ml (mayor que cero, admite decimales). **Atras** permite corregir el
  nombre. WhatsApp recibe ambos datos; cerrar y reabrir vuelve al primer paso
  conservando los valores escritos.

Abrir `/admin`, ingresar, buscar un producto o pulsar **Agregar perfume**.

- Campos: nombre/presentacion (los ml van en el nombre), marca, referencia,
  categoria, costo USD, disponibilidad, inspiracion/descripcion, notas y foto.
- Fotos: subir JPG, PNG o WebP de hasta 4 MB, o pegar un enlace HTTPS.
- **Guardar y publicar** persiste los cambios en Supabase.
  Los clientes los ven al recargar la tienda.
- **Ocultar** retira el producto de la tienda sin borrar sus datos.
- **Descartar cambios** revierte solo la edicion que todavia no se guardo.
- Para evitar sobreescribir otra edicion, cada producto tiene una version.
  Si aparece un conflicto, conservar los datos necesarios y recargar la lista.
- El panel avisa antes de salir con cambios pendientes.
- Los permisos se controlan en el servidor por correo confirmado y `ADMIN_EMAILS`.
  Para quitar acceso, retirar el correo de esa variable y volver a desplegar.
  Para recuperar una cuenta, usar Authentication en Supabase; no hay contrasena
  predeterminada incluida en este proyecto.

### Calculo de precio

`((costo USD + 5 USD de transporte) × tasa actual) + ganancia`

- Perfume: **100 Bs**.
- Desodorante o mini: **50 Bs**. Al agregar productos, seleccionar su categoria;
  no es necesario que el nombre comience con "Mini" o "Desodorante".
- Splash o locion: **50 Bs** al seleccionar su tipo en el panel, incluso si
  su nombre no incluye el tipo. Tambien se detectan automaticamente las palabras
  "Splash", "Locion", "Lociones" o "Lotion" en el nombre, sin distinguir
  mayusculas ni tildes. Se aplica a los productos existentes y nuevos, tanto
  en la tienda como en la vista previa del panel, sin cambiar su categoria.
- Costo **0**: muestra **Consultar precio**, como los cuatro productos existentes
  sin costo. No se inventan precios durante la migracion.
- Sin cotizacion disponible: se informa el problema y se muestra **Consultar
  precio**. No se usa una tasa inventada o antigua en silencio.
- La fuente de cotizacion sigue siendo la que usaba Cloudflare:
  `api.dolarbluebolivia.click`, campo `data.blue.sell`.
- La tienda y la vista previa del panel redondean al boliviano mas cercano,
  conservando el comportamiento anterior. La tasa puede cambiar entre visitas.

Los valores de transporte y ganancia se definen en `pricing.js`, compartido por
las Functions y la vista previa del panel.
Esta primera version permite administrar los productos, no cambiar reglas de
ganancia ni el contenido general de la portada.

### Actualizar una base existente para Splash y Locion

Antes de publicar el selector con los nuevos tipos, ejecutar
`supabase/add-product-types.sql` en el SQL Editor del proyecto existente.
Solo amplia los valores permitidos de `categoria`; no modifica ni elimina
productos. Para instalaciones nuevas, `supabase/schema.sql` ya los incluye.
No volver a importar `supabase/seed.sql`.

## Datos y respaldos

- `products` tiene RLS habilitado y no concede acceso a `anon` ni `authenticated`.
  El navegador nunca recibe la clave secreta; solo las Functions consultan datos.
- El bucket `product-images` permite leer fotos publicamente. La escritura
  se realiza por una Function autenticada; no crear politicas de escritura
  publica en Supabase.
- No se eliminan productos desde el panel. Las fotos anteriores tampoco se
  eliminan al reemplazarlas; controlar el uso del almacenamiento.
- Programar respaldos/exportaciones de Supabase segun las opciones del plan.
  Git no respalda los cambios cotidianos hechos en la base de datos.
- El seed es una importacion inicial, **no** un historial de cambios del panel.
- Se preservo el catalogo anterior sin corregir otros datos: el producto #558
  tiene un nombre largo que conviene revisar desde el panel.

## Desarrollo y verificaciones

```powershell
npm ci
npm test
npm run build
npx wrangler pages functions build --outdir .wrangler\functions-check
```

Para desarrollo conectado, crear `.dev.vars` local con las cuatro variables.
Ejecutar `npm run dev`. Las cookies son HttpOnly, Secure y SameSite=Strict;
usar HTTPS local si el navegador no acepta las cookies Secure en localhost.
Nunca usar las credenciales de produccion en pruebas automatizadas.

Las pruebas usan respuestas simuladas de Supabase y de cotizacion: comprueban
autorizacion, aislamiento de costos, formulas, validacion, conflictos, migracion
y escape del contenido editable. No sustituyen la prueba final en tu proyecto
real de Supabase.

Si hay un problema al activar el panel, volver al despliegue anterior de
Cloudflare Pages. No borrar la base ni las fotos: la tienda anterior puede
seguir usando su catalogo incrustado mientras se corrige la integracion.
