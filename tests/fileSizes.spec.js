import path from "node:path";

import { FileSizes } from "../src/fileSizes.js";

const DATA_PATH = path.resolve(process.cwd(), "tests", "data");

/**
 * Compression sizes are non-deterministic across platforms and Node versions,
 * best we can do is check for keys & that the values are numbers > 0
 *
 * @param {Record<string, number>} result
 */
function compressedResultAssertionHelper(result) {
  expect(Object.keys(result).sort()).toEqual([
    "index.cjs",
    "index.html",
    "index.js",
    "index.mjs",
  ]);

  for (const key in result) {
    expect(typeof result[key]).toEqual("number");
    expect(result[key] > 0).toBe(true);
  }
}

describe("methods", () => {
  test("Should support `.filterFiles`", async () => {
    const plugin = new FileSizes({});

    const filtered = await plugin.filterFiles([
      "index.mjs",
      "index.js",
      "index.html",
      "style.css",
      "image.png",
    ]);

    expect(filtered).toEqual([
      "index.mjs",
      "index.js",
      "index.html",
      "style.css",
    ]);
  });

  test("Should support `.readFromDisk`", async () => {
    const plugin = new FileSizes({});

    const result = await plugin.readFromDisk(
      DATA_PATH,
    );

    compressedResultAssertionHelper(result);
  });

  test("Should support `.getDiff`", async () => {
    const plugin = new FileSizes({});

    const diff = plugin.getDiff(
      {
        "index.mjs": 513,
        "index.js": 47,
        "index.html": 80,
      },
      {
        "index.mjs": 500,
        "index.js": 50,
        "index.html": 80,
      },
    );

    expect(diff).toEqual([
      {
        filename: "index.mjs",
        size: 500,
        delta: -13,
      },
      {
        filename: "index.js",
        size: 50,
        delta: 3,
      },
      {
        filename: "index.html",
        size: 80,
        delta: 0,
      },
    ]);
  });

  test("should support `.printSize`", async () => {
    const plugin = new FileSizes({});

    const sizeText = plugin.printSizes([
      {
        filename: "index.mjs",
        size: 500,
        delta: -13,
      },
      {
        filename: "index.js",
        size: 50,
        delta: 3,
      },
      {
        filename: "index.html",
        size: 80,
        delta: 0,
      },
    ]);

    const lines = sizeText.split("\n");

    expect(lines[0]).toEqual("  index.mjs ⏤ 500 B (-13 B)");
    expect(lines[1]).toEqual("   index.js ⏤ 50 B (+3 B)");
    expect(lines[2]).toEqual(" index.html ⏤ 80 B");
  });
});

describe("options", () => {
  test("Should support `compression`", async () => {
      const resultGzip = await new FileSizes({
      compression: "gzip",
    }).readFromDisk(DATA_PATH);

    compressedResultAssertionHelper(resultGzip);

    const resultBrotli = await new FileSizes({
      compression: "brotli",
    }).readFromDisk(DATA_PATH);

    compressedResultAssertionHelper(resultBrotli);

    const resultNone = await new FileSizes({
      compression: "none",
    }).readFromDisk(DATA_PATH);

    compressedResultAssertionHelper(resultNone);
  });

  test("Should support `pattern`", async () => {
    const plugin = new FileSizes({
      pattern: "**/*.avif",
    });

    const filtered = await plugin.filterFiles([
      "index.mjs",
      "index.js",
      "index.html",
      "style.css",
      "photo.avif",
    ]);

    expect(filtered).toEqual(["photo.avif"]);
  });

  test("Should support `exclude`", async () => {
    const plugin = new FileSizes({
      exclude: "**/*.{css,png}",
    });

    const filtered = await plugin.filterFiles([
      "index.mjs",
      "index.js",
      "index.html",
      "style.css",
      "photo.avif",
    ]);

    expect(filtered).toEqual(["index.mjs", "index.js", "index.html"]);
  });

  test("Should support `stripHash`", async () => {
    const plugin = new FileSizes({
      stripHash: (filename) => filename.replace(/-(.{8})\.(css|mjs|js)/, ".$2"),
    });

    const sizes = await plugin.getSizes({
      "index-12345678.mjs": "foo",
      "index-12345678.js": "bar",
      "index-12345678.html": "baz",
    });

    expect(Object.keys(sizes).sort()).toEqual([
      "index-12345678.html",
      "index.js",
      "index.mjs",
    ]);
  });
});
