/**
 * Quién sabe qué worktree está "bajo el cursor" para `review.open` (ARCHITECTURE §3.16). Módulo sin
 * imports a propósito: lo usan `store/review.ts` (consulta) y `store/worktrees.ts` (registra su
 * cursor) sin formar un ciclo entre los dos.
 */
export type ReviewTargetProvider = () => string | null

const providers: ReviewTargetProvider[] = []

/** Registra un proveedor; devuelve la función para quitarlo. Se consultan en orden de registro. */
export function addReviewTarget(provider: ReviewTargetProvider): () => void {
  providers.push(provider)
  return () => {
    const i = providers.indexOf(provider)
    if (i !== -1) providers.splice(i, 1)
  }
}

/** Primer worktree que ofrece algún proveedor, o `null`. */
export function providedReviewTarget(): string | null {
  for (const p of providers) {
    const id = p()
    if (id) return id
  }
  return null
}
