const printable = (value) => value === null || value === undefined ? '' : String(value).replaceAll('\n', ' ');

export const formatLedgerEvent = (event) => {
  const { timestamp = '', event: name = 'EVENT', ...fields } = event ?? {};
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${printable(typeof value === 'object' ? JSON.stringify(value) : value)}`)
    .join(' ');
  return `[${timestamp}] ${name}${details ? ` ${details}` : ''}`;
};

export function createLedger({ write = () => {} } = {}) {
  const counts = new Map();
  const record = (event) => {
    const date = event?.date ?? event?.ledgerId?.replace(/^v5-day-/, '');
    if (!date) return;
    const count = (counts.get(date) ?? 0) + 1;
    counts.set(date, count);
    try { Promise.resolve(write(formatLedgerEvent(event), event)).catch(() => {}); } catch {}
    if (event.event === 'DAY_FINALIZE') {
      const summary = `[${event.timestamp ?? ''}] Finalized trading day ${date} (${count} events).`;
      try { Promise.resolve(write(summary, { ...event, summary: true })).catch(() => {}); } catch {}
    }
  };
  return { record };
}
