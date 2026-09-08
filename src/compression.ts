import { gzipSize } from "gzip-size";
import { sync as brotliSize } from "brotli-size";

export type CompressionMethod = "gzip" | "brotli" | "none";

export const noop = <T>(a: T): T => a;

const noneSize = (input: string): number => Buffer.byteLength(input);

const compressionMethods: Record<
  CompressionMethod,
  (input: string) => number | Promise<number>
> = {
  brotli: brotliSize,
  gzip: gzipSize,
  none: noneSize,
};

export async function compressContent(
  method: CompressionMethod,
  content: string,
): Promise<number> {
  return await compressionMethods[method](content);
}
