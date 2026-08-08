/** Minimal SSE reader for `fetch` responses (EventSource cannot POST). */
export type SseMessage = { event: string; data: string; id?: string };

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      // Frames are separated by a blank line; \r\n\r\n is legal too.
      while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawFrame = buffer.slice(0, split);
        buffer = buffer.slice(split + (buffer[split] === '\r' ? 4 : 2));

        let event = 'message';
        let id: string | undefined;
        const dataLines: string[] = [];
        for (const line of rawFrame.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') dataLines.push(value);
          else if (field === 'id') id = value;
        }
        if (dataLines.length) yield { event, data: dataLines.join('\n'), id };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
