/// <reference types="vite/client" />

/**
 * Declared so `import.meta.env.VITE_TARGET` is `string | undefined` rather than
 * the `any` that Vite's index signature would hand us — `resolveTarget` takes
 * `string | undefined`, and an `any` here would let a rename slip through
 * typecheck silently.
 */
interface ImportMetaEnv {
  /** `'web'` | `'native'`, or absent meaning `'web'`. See `src/config/target.ts`. */
  readonly VITE_TARGET?: string;
}
