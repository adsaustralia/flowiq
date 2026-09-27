type ArtworkPreviewSource = { name?: string; fileName: string; imageUrl?: string; previewUrl?: string; thumbnailUrl?: string };

// Use the small, pre-generated image before considering the print-size original.
export async function loadArtworkExportPreview(
  image: ArtworkPreviewSource,
  resolveUrl: (url: string) => string,
  renderPdf: (blob: Blob, width: number, signal: AbortSignal) => Promise<string>,
  timeoutMs = 25_000,
): Promise<string> {
  const controller = new AbortController();
  const name = image.fileName || image.name || 'Artwork';
  let phase = 'downloading preview';
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${name}: timed out while ${phase}. Please check this artwork file.`));
    }, timeoutMs);
  });
  const load = async () => {
    const urls = [...new Set([image.previewUrl, image.thumbnailUrl, image.imageUrl].filter((url): url is string => Boolean(url)))];
    let lastError = 'No artwork URL';
    for (const url of urls) {
      controller.signal.throwIfAborted();
      try {
        phase = 'downloading preview';
        const response = await fetch(resolveUrl(url), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        phase = 'decoding preview';
        if (blob.type.includes('pdf') || /\.pdf(?:\?|$)/i.test(url)) {
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
          phase = 'encoding preview';
          // Small bounded canvas; no asynchronous idle-frame encoder to wait on.
          return canvas.toDataURL('image/png');
        } finally { bitmap.close(); }
      } catch (error) {
        controller.signal.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`${name}: unable to prepare an artwork preview (${lastError}).`);
  };
  try { return await Promise.race([load(), timeout]); }
  finally { clearTimeout(timer!); }
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
