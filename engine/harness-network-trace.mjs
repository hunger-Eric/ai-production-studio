import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';

const file = process.env.STUDIO_HARNESS_NETWORK_TRACE;
const tracked = new WeakMap();
let sequence = 0;
const emit = entry => {
  if (file) {
    try { appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
    catch { /* Network diagnostics must not change request behavior. */ }
  }
};

channel('undici:request:create').subscribe(({ request }) => {
  const endpoint = String(request.path ?? '').split('?')[0];
  if (request.origin !== 'https://api.openai.com' || request.method !== 'POST' ||
      !['/v1/responses', '/v1/chat/completions'].includes(endpoint)) return;
  const id = ++sequence;
  tracked.set(request, id);
  emit({ id, event: 'request', endpoint });
});
channel('undici:request:headers').subscribe(({ request, response }) => {
  const id = tracked.get(request);
  if (id) emit({ id, event: 'headers', status: response.statusCode });
});
channel('undici:request:trailers').subscribe(({ request }) => {
  const id = tracked.get(request);
  if (id) emit({ id, event: 'response_end' });
});
channel('undici:request:error').subscribe(({ request, error }) => {
  const id = tracked.get(request);
  if (id) emit({ id, event: 'transport_error', code: error?.code ?? error?.name });
});
