import { describe, expect, it } from "vitest";
import { buildAnnotationAnchor } from "../annotation-anchor";
import { AnnotationAnchorSchema } from "@codevil/shared";
import type { DomMeta } from "@codevil/shared";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const startMeta: DomMeta = {
  parentTagName: "p",
  parentIndex: 0,
  textOffset: 5,
};

const endMeta: DomMeta = {
  parentTagName: "p",
  parentIndex: 0,
  textOffset: 15,
};

const goodSource = { startMeta, endMeta, text: "hello world" };

const goodBlock = {
  dataset: { blockId: "block-40-59", sourceLine: "5" },
};

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe("buildAnnotationAnchor — field mapping", () => {
  it("maps startMeta from source", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    expect(anchor?.startMeta).toEqual(startMeta);
  });

  it("maps endMeta from source", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    expect(anchor?.endMeta).toEqual(endMeta);
  });

  it("maps text from source", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    expect(anchor?.text).toBe("hello world");
  });

  it("maps blockId from dataset.blockId", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    expect(anchor?.blockId).toBe("block-40-59");
  });

  it("maps sourceLine as a number from dataset.sourceLine", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    expect(anchor?.sourceLine).toBe(5);
    expect(typeof anchor?.sourceLine).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// sourceLine parsing
// ---------------------------------------------------------------------------

describe("buildAnnotationAnchor — sourceLine parsing", () => {
  it("parses a multi-digit sourceLine", () => {
    const block = { dataset: { blockId: "block-0-10", sourceLine: "42" } };
    const anchor = buildAnnotationAnchor(goodSource, block);
    expect(anchor?.sourceLine).toBe(42);
  });

  it("returns null when sourceLine is '0' (not positive)", () => {
    const block = { dataset: { blockId: "block-0-10", sourceLine: "0" } };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });

  it("returns null when sourceLine is negative", () => {
    const block = { dataset: { blockId: "block-0-10", sourceLine: "-3" } };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });

  it("returns null when sourceLine is NaN (e.g. 'abc')", () => {
    const block = { dataset: { blockId: "block-0-10", sourceLine: "abc" } };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });

  it("returns null when sourceLine is float string (not integer)", () => {
    const block = { dataset: { blockId: "block-0-10", sourceLine: "3.5" } };
    // parseInt("3.5") === 3, which is positive — parseInt truncates, so this
    // should succeed (3 is valid).
    const anchor = buildAnnotationAnchor(goodSource, block);
    expect(anchor?.sourceLine).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Null paths — missing blockId / sourceLine
// ---------------------------------------------------------------------------

describe("buildAnnotationAnchor — null when block info absent", () => {
  it("returns null when blockId is undefined", () => {
    const block = { dataset: { sourceLine: "5" } };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });

  it("returns null when blockId is empty string", () => {
    const block = { dataset: { blockId: "", sourceLine: "5" } };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });

  it("returns null when sourceLine is undefined", () => {
    const block = { dataset: { blockId: "block-0-10" } };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });

  it("returns null when both blockId and sourceLine are undefined", () => {
    const block = { dataset: {} };
    expect(buildAnnotationAnchor(goodSource, block)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Schema validation: valid output passes AnnotationAnchorSchema
// ---------------------------------------------------------------------------

describe("buildAnnotationAnchor — schema validation", () => {
  it("result passes AnnotationAnchorSchema.parse for a good input", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    expect(anchor).not.toBeNull();
    // Throws if invalid — assertion success = parse succeeded
    expect(() => AnnotationAnchorSchema.parse(anchor)).not.toThrow();
  });

  it("parsed anchor has correct shape according to AnnotationAnchorSchema", () => {
    const anchor = buildAnnotationAnchor(goodSource, goodBlock);
    const parsed = AnnotationAnchorSchema.parse(anchor);
    expect(parsed.blockId).toBe("block-40-59");
    expect(parsed.sourceLine).toBe(5);
    expect(parsed.text).toBe("hello world");
    expect(parsed.startMeta.parentTagName).toBe("p");
    expect(parsed.endMeta.parentTagName).toBe("p");
  });
});
