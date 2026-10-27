import { z } from 'zod'

export const EntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Identifier contains unsupported characters')

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected a SHA-256 hex digest')
export const TimestampSchema = z.iso.datetime({ offset: true })
export const LocaleSchema = z.enum(['zh-CN', 'en-US'])

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export const PermissionSetSchema = z
  .object({
    aiAllowed: z.boolean(),
    resumeAllowed: z.boolean(),
    shareAllowed: z.boolean(),
  })
  .strict()

export type PermissionSet = z.infer<typeof PermissionSetSchema>

export const SourceLocatorSchema = z
  .object({
    documentId: EntityIdSchema,
    fragmentId: EntityIdSchema.optional(),
    page: z.number().int().positive().optional(),
    section: z.string().trim().min(1).max(240).optional(),
    quote: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()

export type SourceLocator = z.infer<typeof SourceLocatorSchema>

export const ActorSchema = z.enum(['user', 'ai', 'importer', 'system'])
export type Actor = z.infer<typeof ActorSchema>
