import { z } from "zod";

export const providerHttpHeadersSchema = z
  .object({
    entries: z
      .array(
        z.object({ name: z.string().max(256), value: z.string().max(8192) }),
      )
      .max(256),
    redacted: z.array(z.string().max(256)).max(256),
    truncated: z.boolean(),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 100_000,
    "HTTP headers exceed the metadata budget",
  );

const correlation = {
  requestId: z.string().max(128),
  clientRequestId: z.string().nullable(),
  turnId: z.string().nullable(),
  requestNumber: z.number().int().positive(),
  method: z.string().max(32).nullable(),
  origin: z.string().max(2048).nullable(),
  source: z.enum(["gateway", "native"]),
};

export const providerHttpMetadataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("capture"),
    state: z.literal("unavailable"),
    reason: z.string().max(1024),
    clientRequestId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("response"),
    ...correlation,
    status: z.number().int().min(100).max(599),
    headers: providerHttpHeadersSchema,
    receivedAt: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("finished"),
    ...correlation,
    outcome: z.enum(["completed", "aborted", "transport-error"]),
    trailers: providerHttpHeadersSchema,
  }),
]);

export type ProviderHttpMetadata = z.infer<typeof providerHttpMetadataSchema>;

export function sanitizeProviderHttpHeaders(
  rawHeaders: readonly string[],
): z.infer<typeof providerHttpHeadersSchema> {
  const entries: { name: string; value: string }[] = [];
  const redacted = new Set<string>();
  let bytes = 0;
  let truncated = false;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    const value = rawHeaders[index + 1]!;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || name.length > 256) {
      truncated = true;
      continue;
    }
    if (
      /(?:cookie|authorization|authentication|api[-_]?key|(?:^|[-_])(?:auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token)(?:$|[-_])|(?:^|[-_])token$|secret|credential)/i.test(
        name,
      )
    ) {
      if (redacted.size < 256) redacted.add(name.slice(0, 256));
      else truncated = true;
      continue;
    }
    const size = new TextEncoder().encode(
      JSON.stringify({ name, value }),
    ).byteLength;
    if (
      name.length > 256 ||
      value.length > 8192 ||
      bytes + size > 32_768 ||
      entries.length >= 256
    ) {
      truncated = true;
      continue;
    }
    entries.push({ name, value });
    bytes += size;
  }
  return { entries, redacted: [...redacted], truncated };
}
