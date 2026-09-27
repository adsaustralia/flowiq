type ArtworkPreviewSource = { name?: string; fileName: string; imageUrl?: string; previewUrl?: string; thumbnailUrl?: string };

// Use the small, pre-generated image before considering the print-size original.
export async function loadArtworkExportPreview(
  image: ArtworkPreviewSource,
  resolveUrl: (url: string) => string,
  renderPdf: (blob: Blob, width: number, signal: AbortSignal) => Promise<string>,
  sourceTimeoutMs = 15_000,
): Promise<string> {
  const name = image.fileName || image.name || 'Artwork';
  const sources = [
    { kind: 'preview', url: image.previewUrl },
    { kind: 'thumbnail', url: image.thumbnailUrl },
    { kind: 'original', url: image.imageUrl },
  ].filter((source, index, all): source is { kind: string; url: string } =>
    Boolean(source.url) && all.findIndex((candidate) => candidate.url === source.url) === index,
  );
  let lastError = 'No artwork URL';
  for (const source of sources) {
    const controller = new AbortController();
    let phase = `downloading ${source.kind}`;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(`${phase} timed out`);
        reject(new Error(`${phase} timed out`));
      }, sourceTimeoutMs);
    });
    try {
      try {
        const prepareSource = async () => {
          phase = `downloading ${source.kind}`;
          const response = await fetch(resolveUrl(source.url), { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          controller.signal.throwIfAborted();
          phase = `decoding ${source.kind}`;
          if (blob.type.includes('pdf') || /\.pdf(?:\?|$)/i.test(source.url)) {
            return await renderPdf(blob, 560, controller.signal);
          }
          const bitmap = await createImageBitmap(blob);
          try {
            controller.signal.throwIfAborted();
            const scale = Math.min(1, 560 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Unable to create preview canvas');
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            phase = `encoding ${source.kind}`;
            // Small bounded canvas; no asynchronous idle-frame encoder to wait on.
            return canvas.toDataURL('image/png');
          } finally { bitmap.close(); }
        };
        return await Promise.race([prepareSource(), timeout]);
      } catch (error) {
        lastError = controller.signal.aborted
          ? `${phase} timed out`
          : error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(timer!);
    }
  }
  throw new Error(`${name}: unable to prepare an artwork preview (${lastError}). Please check this artwork file.`);
}

export async function prepareArtworkExportPreviews<T>(items: T[], prepare: (item: T) => Promise<void>, progress: (completed: number, total: number) => void) {
  let next = 0, completed = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await prepare(item); }
      catch (error) { failed = true; throw error; }
      if (!failed) progress(++completed, items.length);
    }
  }));
}
