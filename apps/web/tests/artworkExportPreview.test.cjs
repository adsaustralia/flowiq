const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/artworkExportPreview.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(fetch, decode) {
  const state = { closed: 0, canvases: [] };
  const context = {
    exports: {}, setTimeout, clearTimeout, AbortController, fetch,
    createImageBitmap: decode || (async () => ({ width: 1200, height: 800, close() { state.closed++; } })),
    document: { createElement() {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,preview' };
      state.canvases.push(canvas);
      return canvas;
    } },
  };
  vm.runInNewContext(compiled, context);
  return { ...context.exports, state };
}
const image = { fileName: 'Creative 13.png', imageUrl: '/large.png', previewUrl: '/small.webp', thumbnailUrl: '/thumb.webp' };
const ok = { ok: true, blob: async () => ({ type: 'image/webp' }) };

test('uses stored preview only, bounds canvas, and releases bitmap', async () => {
  const urls = [];
  const api = setup(async url => { urls.push(url); return ok; });
  await api.loadArtworkExportPreview(image, url => url, () => assert.fail('unexpected PDF render'));
  assert.deepEqual(urls, ['/small.webp']);
  assert.equal(api.state.closed, 1);
  assert.equal(api.state.canvases[0].width, 560);
  assert(api.state.canvases[0].height <= 560);
});

test('missing preview falls back to thumbnail before original', async () => {
  const urls = [];
  const api = setup(async url => { urls.push(url); return url === '/small.webp' ? { ok: false, status: 404 } : ok; });
  await api.loadArtworkExportPreview(image, url => url, () => assert.fail());
  assert.deepEqual(urls, ['/small.webp', '/thumb.webp']);
});

test('PDF original without stored previews uses the PDF fallback', async () => {
  const api = setup(async () => ({ ok: true, blob: async () => ({ type: 'application/pdf' }) }));
  let calls = 0;
  const result = await api.loadArtworkExportPreview({ fileName: 'legacy.pdf', imageUrl: '/legacy.pdf' }, url => url, async (blob, width, signal) => {
    calls++; assert.equal(width, 560); assert.equal(signal.aborted, false); return 'pdf-preview';
  });
  assert.equal(result, 'pdf-preview');
  assert.equal(calls, 1);
});

for (const stage of ['fetch', 'body', 'decode']) {
  test(`hung preview ${stage} is aborted and falls back to thumbnail`, async () => {
    const signals = [], urls = [];
    const never = () => new Promise(() => {});
    let decodeCalls = 0;
    const api = setup(async (url, options) => {
      urls.push(url); signals.push(options.signal);
      if (url === '/small.webp' && stage === 'fetch') return never();
      return url === '/small.webp' && stage === 'body' ? { ok: true, blob: never } : ok;
    }, stage === 'decode' ? async () => (++decodeCalls === 1 ? never() : { width: 1200, height: 800, close() {} }) : undefined);
    await api.loadArtworkExportPreview(image, url => url, () => assert.fail(), 20);
    assert.deepEqual(urls, ['/small.webp', '/thumb.webp']);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
  });
}

test('missing artwork reports a named error instead of silently omitting its preview', async () => {
  const api = setup(async () => ({ ok: false, status: 404 }));
  await assert.rejects(api.loadArtworkExportPreview(image, url => url, () => assert.fail()), /Creative 13.png: unable to prepare.*HTTP 404/);
});

test('reports the filename only after every available source times out', async () => {
  const never = () => new Promise(() => {});
  const api = setup(never);
  await assert.rejects(api.loadArtworkExportPreview(image, url => url, () => assert.fail(), 10), /Creative 13.png: unable to prepare.*original timed out/);
});

test('limits concurrent previews to three and reports all completions', async () => {
  const api = setup();
  let active = 0, peak = 0;
  const counts = [];
  await api.prepareArtworkExportPreviews(Array.from({ length: 13 }, (_, i) => i), async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  }, (count, total) => { assert.equal(total, 13); counts.push(count); });
  assert.equal(peak, 3);
  assert.deepEqual(counts, Array.from({ length: 13 }, (_, i) => i + 1));
});
