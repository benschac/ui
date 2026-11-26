import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import type { Noop, NoopTypeId } from "../Component.ts"

// The same string as `Component.NoopTypeId`, which the annotation checks. Declared here too so this module
// needs `Component.ts` for types only.
const TypeId: NoopTypeId = "~@effect/ui/Component/Noop"

/** @internal */
export const noop: Noop = Object.freeze({ [TypeId]: TypeId })

/**
 * Recognises the value by its type id, not by identity, so a copy made by another copy of `effect` in the
 * same bundle counts.
 *
 * @internal
 */
export const isNoop = (u: unknown): u is Noop =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId

/**
 * Recognises the `Component.Noop` schema by the type id it's annotated with, so an annotated copy counts.
 *
 * @internal
 */
export const isNoopSchema = (schema: Schema.Top): boolean =>
  SchemaAST.resolveAt(TypeId)(schema.ast) === TypeId
