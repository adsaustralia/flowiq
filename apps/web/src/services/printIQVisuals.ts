const VISUALS_RESULT_EVENT = 'flowiq:printiq-visuals-result';

// Reuse the Quote Builder export, including from the dashboard's Submit action.
export function generatePrintIQVisuals(campaignId: string, tenantId?: string | null): Promise<File> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Preparing campaign visuals';
    let phase = 'loading the campaign export';
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set('view', 'quote');
    url.searchParams.set('campaignId', campaignId);
    url.searchParams.set('printIQVisuals', requestId);
    if (tenantId) url.searchParams.set('tenantId', tenantId);
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      frame.remove();
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      if (event.data?.requestId !== requestId) return;
      if (event.data.type === 'flowiq:printiq-visuals-progress') {
        if (typeof event.data.phase === 'string') phase = event.data.phase;
        return;
      }
      if (event.data.type !== VISUALS_RESULT_EVENT) return;
      cleanup();
      if (event.data.file instanceof Blob && event.data.file.type === 'application/pdf') {
        resolve(new File([event.data.file], event.data.fileName || 'Campaign Visuals.pdf', { type: 'application/pdf' }));
      } else {
        reject(new Error(event.data.error || 'Unable to generate the campaign Visuals PDF.'));
      }
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Preparing the Visuals PDF timed out while ${phase}. No PrintIQ submission was sent by this attempt.`));
    }, 180_000);
    window.addEventListener('message', receive);
    frame.src = url.toString();
    document.body.appendChild(frame);
  });
}
