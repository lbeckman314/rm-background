// Shared by the Node tests (mask.test.js) and the browser pages
// (fixtures.html, report.html), so they always agree.

// A fixture is a model's raw mask for one example, gzipped:
//   bytes 0-3  width  (uint32, little-endian)
//   bytes 4-7  height (uint32, little-endian)
//   then width × height bytes of confidence (0-255), row by row.

export function encodeFixture(mask, width, height) {
  const bytes = new Uint8Array(8 + mask.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  bytes.set(mask, 8);
  return bytes;
}

export function decodeFixture(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (bytes.length !== 8 + width * height) throw new Error("Malformed fixture");
  return { width, height, mask: bytes.subarray(8) };
}

// Checkpoint thresholds: "keep" must be at least mostly opaque, "remove" at
// most faint.
export const KEEP_MIN = 192;
export const REMOVE_MAX = 32;

// Check an example's checkpoints against a cleaned-up mask. Each checkpoint
// is { at: [x, y] in 0-1 image coordinates, note, known? }; `known` (the
// reason) marks a current failure that's tracked rather than treated as a
// test failure.
export function checkCheckpoints(alpha, width, height, checkpoints) {
  const results = [];
  for (const kind of ["keep", "remove"]) {
    for (const point of checkpoints[kind] ?? []) {
      const [x, y] = point.at;
      const px = Math.round(x * (width - 1));
      const py = Math.round(y * (height - 1));
      const value = alpha[py * width + px];
      const pass = kind === "keep" ? value >= KEEP_MIN : value <= REMOVE_MAX;
      results.push({ kind, at: point.at, note: point.note ?? "", known: point.known ?? "", value, pass });
    }
  }
  return results;
}
