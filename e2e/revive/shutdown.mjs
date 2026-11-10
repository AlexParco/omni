// Fase 3 de `pnpm e2e:revive`: "Apagar todo" (`app:shutdown`) cierra la app y vacía el registro.
export default async function (api, t) {
  t.check('Apagar todo pedido', true, '')
  await api.evaluate(`window.omni.invoke('app:shutdown').catch(() => null); true`)
}
