import path from "node:path";
import { promises as fs, globSync } from "node:fs";

import picomatch from "picomatch";
import prettyBytes from "pretty-bytes";

import { noop, compressContent, type CompressionMethod } from "./compression";

export interface FileSizesOptions {
  /** Compression method to use, default: 'gzip' */
  compression?: CompressionMethod;
  /** minimatch pattern of files to track, default: '**\/*.{js,mjs,cjs,jsx,css,html}' */
  pattern?: string;
  /** minimatch pattern of files NOT to track, default: null */
  exclude?: string | null;
  /** Custom function to remove/normalize hashed filenames for comparison, default: identity */
  stripHash?: (filename: string) => string;
}

/** Compressed size of each tracked file, keyed by (hash-stripped) filename. */
export type FileSizeMap = Record<string, number>;

export interface Diff {
  filename: string;
  size: number;
  delta: number;
}

export class FileSizes {
  readonly options: Required<FileSizesOptions>;

  constructor(options: FileSizesOptions = {}) {
    this.options = {
      compression: options.compression ?? "gzip",
      pattern: options.pattern ?? "**/*.{js,mjs,cjs,jsx,css,html}",
      exclude: options.exclude ?? null,
      stripHash: options.stripHash ?? noop,
    };
  }

  filterFiles = (files: string[]): string[] => {
    const isMatched = picomatch(this.options.pattern);
    const isExcluded = this.options.exclude
      ? picomatch(this.options.exclude)
      : () => false;
    return files.filter((file) => isMatched(file) && !isExcluded(file));
  };

  readFromDisk = async (cwd: string): Promise<FileSizeMap> => {
    const files = globSync(this.options.pattern, {
      cwd,
      exclude: this.options.exclude ? [this.options.exclude] : undefined,
    });

    const result: FileSizeMap = {};
    await Promise.all(
      files.map(async (file) => {
        try {
          const fileContents = await fs.readFile(path.join(cwd, file), "utf-8");
          const size = await compressContent(
            this.options.compression,
            fileContents,
          );
          result[this.options.stripHash(file)] = size;
        } catch {}
      }),
    );

    return result;
  };

  getSizes = async (assets: Record<string, string>): Promise<FileSizeMap> => {
    const files = this.filterFiles(Object.keys(assets));

    const result: FileSizeMap = {};
    await Promise.all(
      files.map(async (file) => {
        try {
          const size = await compressContent(
            this.options.compression,
            assets[file],
          );
          result[this.options.stripHash(file)] = size;
        } catch {}
      }),
    );

    return result;
  };

  getDiff = (oldSizes: FileSizeMap, newSizes: FileSizeMap): Diff[] => {
    const filenames = new Set([
      ...Object.keys(oldSizes),
      ...Object.keys(newSizes),
    ]);

    const result: Diff[] = [];
    for (const filename of filenames) {
      const size = newSizes[filename] || 0;
      const sizeBefore = oldSizes[filename] || 0;
      const delta = size - sizeBefore;
      result.push({ filename, size, delta });
    }

    return result;
  };

  printSizes = (files: Diff[]): string => {
    const width = Math.max(...files.map((file) => file.filename.length), 0);

    let output = "";

    for (const file of files) {
      const { filename, size, delta } = file;
      const msg = " ".repeat(width - filename.length + 1) + filename + " ⏤ ";

      let sizeText = prettyBytes(size);

      if (delta && Math.abs(delta) > 1) {
        const deltaText = (delta > 0 ? "+" : "") + prettyBytes(delta);
        sizeText += ` (${deltaText})`;
      }

      output += msg + sizeText + "\n";
    }
    return output;
  };
}
