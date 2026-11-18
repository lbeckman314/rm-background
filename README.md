# rm background

Remove the background from photos, privately, in your browser. A free,
self-hostable alternative to services like remove.bg.

- **Private:** images are processed on your device and are never uploaded.
- **Fast:** about 0.5 s per image with WebGPU, or a few seconds on the CPU
  (WebAssembly) in browsers without it.
- **Full resolution:** the mask is scaled up to the original image's size.
- **Fine-tunable:** each result has controls for the background cutoff, edge
  softness, trimming narrow areas at the image border and filling holes inside
  the subject, plus an erase and restore brush. They update live, without
  running the model again.
- **Crop, rotate, straighten and flip:** a straighten dial (±45°) that keeps
  the corners filled, like the iOS photo editor, plus aspect ratio presets and
  "Fit to subject", which crops to the cut-out. Every edit can be undone and
  redone.
- **No build step and no dependencies:** a handful of static files.
- **Tested:** example photos with checkpoints, runnable in Node with no
  dependencies.

It runs [BRIA RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) with
[transformers.js](https://huggingface.co/docs/transformers.js). The model
weights (about 88 MB on GPU, 44 MB on CPU) are downloaded from the Hugging Face
hub on first use and cached by the browser.

## Running locally

Serve the directory with any static file server, for example:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly from disk
won't work, because browsers don't allow module workers on `file://` URLs.

For development, use the included server instead (`npm run dev`, or
`python3 scripts/dev-server.py`). It also turns off caching and can save
regenerated test fixtures.

## Files

| File / folder         | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `index.html`          | Page markup                                                  |
| `style.css`           | Styles, with light and dark themes                           |
| `app.js`              | UI: queueing images, background colour, examples, downloads  |
| `editor.js`           | Each result's preview, settings, brush, crop and undo/redo   |
| `mask.js`             | Cleans up the model's mask (cutoff, softness, trim, fill)    |
| `worker.js`           | Loads the model and predicts each mask, in a Web Worker      |
| `examples/`           | Example photos, thumbnails and `examples.json` (see below)   |
| `tests/`              | Tests and tools for `mask.js` (see below)                    |
| `scripts/dev-server.py` | Development server                                         |

## Examples and tests

`examples/examples.json` lists the example photos. Each one is shown in the
page's "Try an example" strip and is also a test case for `mask.js`, with
**checkpoints**: points that must end up kept or removed with the default
settings, like "helmet visor: keep" or "inside the mug's handle: remove".

- **`npm test`** (or `node --test`) runs the tests in Node, with no
  dependencies and no model: each example's mask is cleaned up from its saved
  model output in `tests/fixtures/` and its checkpoints are checked. There are
  also synthetic tests for each rule in `mask.js`. Checkpoints marked `known`
  are current failures, reported as "todo" without failing the run.
- **`tests/report.html`** shows every example's original and cut-out side by
  side, with its checkpoints marked. Click an image to get coordinates for a
  new checkpoint.
- **`tests/fixtures.html`** regenerates the saved model output, using the dev
  server. Do this after changing the model or its settings in `worker.js`
  (not after changing `mask.js`), then check the report: the same
  checkpoints show whether a new model is better or worse.

To add an example: put a public-domain or CC0 photo, at most 960 px wide, in
`examples/` with a 240 px thumbnail in `examples/thumbs/`; add it to
`examples.json` with its credit, licence and source; regenerate the fixtures;
then add checkpoints using the report.

## Deploying

Any static host works, for example GitHub Pages: push this directory to a
repository and enable Pages for the `main` branch. `tests/`, `scripts/` and
`package.json` aren't needed by the page, but are harmless to publish.

## Example photos

All example photos are public domain or CC0, cropped and scaled down. Using
them here doesn't imply endorsement by their creators or by NASA. NASA images
are generally not subject to copyright in the United States; see NASA's
[media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).

| Photo | Credit | Licence |
| ----- | ------ | ------- |
| Astronaut | Bruce McCandless II on the first untethered spacewalk, 1984. NASA ([S84-27017](https://images.nasa.gov/details/s84-27017)) | Public domain |
| Mug | Ryan Holloway, via Unsplash ([Commons](https://commons.wikimedia.org/wiki/File:Coffee_Mug_(Unsplash).jpg)) | CC0 |
| Fox | U.S. Fish & Wildlife Service, Alaska Region ([Commons](https://commons.wikimedia.org/wiki/File:Red_fox_(8385096018).jpg)) | Public domain |
| Floating hair | Karen Nyberg on the ISS, 2013. NASA ([iss036e018174](https://images.nasa.gov/details/iss036e018174)) | Public domain |
| Portrait | Astronaut Jack Hathaway, 2025. Josh Valcarcel, NASA ([jsc2025e068207_alt](https://images.nasa.gov/details/jsc2025e068207_alt)) | Public domain |
| Robotic arm | Canadarm2 above the Mozambique Channel, 2024. NASA ([iss071e361950](https://images.nasa.gov/details/iss071e361950)) | Public domain |
| Mars rover | Curiosity's selfie at "Aberlady" and "Kilmarie", 2019. NASA/JPL-Caltech/MSSS ([PIA23240](https://images.nasa.gov/details/PIA23240)) | Public domain |
| Space selfie | Buzz Aldrin, Gemini 12, 1966. NASA ([S66-62926](https://images.nasa.gov/details/S66-62926)) | Public domain |

The precomputed cut-out of the astronaut shown on first load was made with this
app's default settings, with no manual touch-up.

## Licence

RMBG-1.4 is released under the
[bria-rmbg-1.4 licence](https://huggingface.co/briaai/RMBG-1.4#license), which
allows non-commercial use only.
