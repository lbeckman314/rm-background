// Tests for mask.js. Run with: node --test
//
// Two kinds of test, no dependencies:
//   - Examples: each photo in examples/examples.json is cleaned up from its
//     saved model mask (tests/fixtures/) with the default settings, and its
//     checkpoints must come out kept or removed. Known issues are reported
//     as "todo" and don't fail the run.
//   - Synthetic: small hand-made masks that pin down each rule precisely,
//     including cases no example photo covers yet.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { DEFAULTS, morph, refineMask } from "../mask.js";
import { checkCheckpoints, decodeFixture } from "./shared.js";

const root = new URL("../", import.meta.url);
const { examples } = JSON.parse(readFileSync(new URL("examples/examples.json", root)));

describe("examples", () => {
  for (const example of examples) {
    describe(example.id, () => {
      const fixture = new URL(`tests/fixtures/${example.id}.mask.gz`, root);

      test("has its image, thumbnail and saved mask", () => {
        assert.ok(existsSync(new URL(`examples/${example.id}.jpg`, root)), "image");
        assert.ok(existsSync(new URL(`examples/thumbs/${example.id}.jpg`, root)), "thumbnail");
        assert.ok(existsSync(fixture), "saved mask: open tests/fixtures.html to generate it");
      });
      if (!existsSync(fixture)) return;

      const { width, height, mask } = decodeFixture(gunzipSync(readFileSync(fixture)));
      const alpha = refineMask(mask, width, height, DEFAULTS);
      for (const result of checkCheckpoints(alpha, width, height, example.checkpoints)) {
        const name = `${result.kind}: ${result.note}`;
        const message = `${name} at [${result.at}] is ${Math.round((result.value / 255) * 100)}% opaque`;
        test(name, result.known ? { todo: result.known } : {}, () => assert.ok(result.pass, message));
      }
    });
  }
});

// The mug's handle gap is 15% of the mug: too big to fill at the default
// size limit anyway. At the slider's maximum it would qualify on size, so
// only the confidence rule keeps it; check that on a real photo too.
test("examples: mug handle gap is kept even at the largest hole size", () => {
  const fixture = new URL("tests/fixtures/mug.mask.gz", root);
  const { width, height, mask } = decodeFixture(gunzipSync(readFileSync(fixture)));
  const alpha = refineMask(mask, width, height, { ...DEFAULTS, fillSize: 20 });
  const mug = examples.find((example) => example.id === "mug");
  const gap = checkCheckpoints(alpha, width, height, mug.checkpoints).find((r) => r.note === "inside the handle");
  assert.ok(gap.pass, `inside the handle is ${Math.round((gap.value / 255) * 100)}% opaque`);
});

// ---- Synthetic masks ----

// A blank w × h confidence mask, and a helper to fill rectangles in it.
function blank(w, h) {
  const raw = new Uint8Array(w * h);
  const rect = (x0, y0, x1, y1, value) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) raw[y * w + x] = value;
  };
  return { raw, rect, at: (alpha, x, y) => alpha[y * w + x] };
}

describe("levels (cutoff and softness)", () => {
  test("low confidence becomes transparent, high becomes opaque", () => {
    const { raw, rect, at } = blank(10, 1);
    rect(0, 0, 3, 1, 20); // 8%: below the 40% cutoff
    rect(3, 0, 6, 1, 250); // 98%: above cutoff + softness
    const alpha = refineMask(raw, 10, 1, { ...DEFAULTS, trim: false, fill: false });
    assert.equal(at(alpha, 1, 0), 0);
    assert.equal(at(alpha, 4, 0), 255);
  });

  test("values in between fade in, so soft edges stay soft", () => {
    const { raw, rect, at } = blank(10, 1);
    rect(0, 0, 10, 1, 166); // 65%: halfway between 40% and 90%
    const alpha = refineMask(raw, 10, 1, { ...DEFAULTS, trim: false, fill: false });
    assert.ok(at(alpha, 5, 0) > 100 && at(alpha, 5, 0) < 155);
  });

  test("raising the cutoff removes more", () => {
    const { raw, rect, at } = blank(10, 1);
    rect(0, 0, 10, 1, 140); // 55%
    const opts = { ...DEFAULTS, trim: false, fill: false };
    assert.ok(at(refineMask(raw, 10, 1, opts), 5, 0) > 0);
    assert.equal(at(refineMask(raw, 10, 1, { ...opts, cutoff: 60 }), 5, 0), 0);
  });
});

describe("trim (narrow areas at the border)", () => {
  // A square subject with a narrow strip running from it to the bottom edge,
  // like a gap between floorboards.
  function subjectWithStrip(stripWidth) {
    const s = blank(200, 200);
    s.rect(50, 30, 150, 130, 250);
    s.rect(100 - stripWidth / 2, 130, 100 + stripWidth / 2, 200, 250);
    return s;
  }

  test("removes a narrow strip that runs to the border", () => {
    const { raw, at } = subjectWithStrip(10);
    const alpha = refineMask(raw, 200, 200, DEFAULTS);
    assert.equal(at(alpha, 100, 190), 0, "strip removed");
    assert.equal(at(alpha, 100, 80), 255, "subject kept");
  });

  test("keeps a strip wider than the trim width", () => {
    const { raw, at } = subjectWithStrip(40);
    assert.equal(at(refineMask(raw, 200, 200, DEFAULTS), 100, 190), 255);
  });

  test("keeps a narrow part that doesn't reach the border", () => {
    const s = blank(200, 200);
    s.rect(50, 30, 150, 130, 250);
    s.rect(95, 130, 105, 170, 250); // a short stem, stopping well short of the edge
    assert.equal(s.at(refineMask(s.raw, 200, 200, DEFAULTS), 100, 160), 255);
  });

  test("can be turned off", () => {
    const { raw, at } = subjectWithStrip(10);
    assert.equal(at(refineMask(raw, 200, 200, { ...DEFAULTS, trim: false }), 100, 190), 255);
  });
});

describe("fill (holes inside the subject)", () => {
  // A subject with a hole the model was unsure about (like a dark visor), a
  // real gap it was confident about (like the inside of a handle), and a
  // faded patch with no transparent core. Each has a soft rim.
  function subjectWithHoles() {
    const s = blank(200, 200);
    s.rect(40, 40, 160, 160, 250);
    s.rect(58, 58, 82, 82, 150);
    s.rect(60, 60, 80, 80, 40); // unsure hole: 16% confidence
    s.rect(108, 108, 132, 132, 150);
    s.rect(110, 110, 130, 130, 2); // real gap: ~1% confidence
    s.rect(140, 50, 146, 56, 200); // faded patch
    return s;
  }

  test("fills a hole the model was unsure about, including its rim", () => {
    const { raw, at } = subjectWithHoles();
    const alpha = refineMask(raw, 200, 200, DEFAULTS);
    assert.equal(at(alpha, 70, 70), 255, "core");
    assert.equal(at(alpha, 59, 59), 255, "rim");
  });

  test("keeps a real gap, and leaves its rim soft", () => {
    const { raw, at } = subjectWithHoles();
    const alpha = refineMask(raw, 200, 200, DEFAULTS);
    assert.equal(at(alpha, 120, 120), 0, "gap");
    assert.ok(at(alpha, 109, 109) > 0 && at(alpha, 109, 109) < 255, "rim");
  });

  test("fills a faded patch with no transparent core", () => {
    const { raw, at } = subjectWithHoles();
    assert.equal(at(refineMask(raw, 200, 200, DEFAULTS), 142, 52), 255);
  });

  test("leaves the outside of the subject alone", () => {
    const { raw, at } = subjectWithHoles();
    const alpha = refineMask(raw, 200, 200, DEFAULTS);
    assert.equal(at(alpha, 10, 10), 0);
    assert.equal(at(alpha, 100, 40), 255);
  });

  test("respects the size limit, and can be turned off", () => {
    const { raw, at } = subjectWithHoles();
    assert.equal(at(refineMask(raw, 200, 200, { ...DEFAULTS, fillSize: 1 }), 70, 70), 0, "2.8% hole over a 1% limit");
    assert.equal(at(refineMask(raw, 200, 200, { ...DEFAULTS, fill: false }), 70, 70), 0, "off");
  });
});

describe("morph (erosion and dilation)", () => {
  test("matches a brute-force implementation", () => {
    const w = 37;
    const h = 23;
    const r = 3;
    let seed = 1; // deterministic pseudo-random input
    const bits = new Uint8Array(w * h).map(() => ((seed = (seed * 16807) % 2147483647) % 10 < 6 ? 1 : 0));
    for (const erode of [true, false]) {
      const fast = morph(bits, w, h, r, erode);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let all = 1;
          let any = 0;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const X = x + dx;
              const Y = y + dy;
              const v = X < 0 || Y < 0 || X >= w || Y >= h ? (erode ? 1 : 0) : bits[Y * w + X];
              all &= v;
              any |= v;
            }
          }
          assert.equal(fast[y * w + x], erode ? all : any, `${erode ? "erode" : "dilate"} at ${x},${y}`);
        }
      }
    }
  });
});

test("cleans up a full-size mask quickly", () => {
  const raw = new Uint8Array(1024 * 1024).fill(250);
  const start = performance.now();
  refineMask(raw, 1024, 1024, DEFAULTS);
  const ms = performance.now() - start;
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});
