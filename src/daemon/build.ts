/**
 * Sello del build. El placeholder lo reemplaza el plugin `omni-build-stamp` de
 * `electron.vite.config.ts` al emitir el bundle con el hash del código del daemon (su chunk y
 * los que importa). Main y daemon salen del mismo build, así que comparten el valor; si solo
 * cambia main, el sello no cambia y el daemon (con sus sesiones) sobrevive al reinicio en dev.
 * En tests y sin bundlear queda el placeholder. `OMNI_TEST_BUILD` lo reemplaza en main y en el daemon
 * (que hereda el entorno): `e2e/upgrade.sh` fabrica así un daemon "de otra versión" (§3.10c).
 */
export const BUILD_STAMP = process.env.OMNI_TEST_BUILD || '__OMNI_BUILD_STAMP__'
