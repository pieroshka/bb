import { sanitizeProviderHttpHeaders } from "@bb/domain";
import { z } from "zod";

export const nativeHttpResponseSchema = z.object({
  threadId: z.string(),
  status: z.number().int().min(100).max(599),
  truncated: z.boolean().default(false),
  headers: z.array(z.string().max(1024 * 1024)).max(4096),
});

export function experimental_upstreamHttpUrl(
  gateway: string,
  endpoint: string,
): string {
  const target = new URL(endpoint);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    throw new Error(
      "HTTP capture requires an HTTP(S) endpoint without embedded credentials",
    );
  return `${gateway}/${Buffer.from(target.origin).toString("base64url")}${target.pathname}${target.search}`;
}

export function experimental_providerHttpResponse(
  input: z.input<typeof nativeHttpResponseSchema>,
) {
  const parsed = nativeHttpResponseSchema.parse(input);
  const headers = sanitizeProviderHttpHeaders(parsed.headers);
  return {
    jsonrpc: "2.0" as const,
    method: "experimental/provider/http",
    params: {
      ...parsed,
      headers: [
        ...headers.entries.flatMap(({ name, value }) => [name, value]),
        ...headers.redacted.flatMap((name) => [name, "[redacted]"]),
      ],
      truncated: parsed.truncated || headers.truncated,
    },
  };
}
