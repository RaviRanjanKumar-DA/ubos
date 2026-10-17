// CSV reading/writing and column matching for bulk lead upload.

/** Parses CSV text (quotes, escaped quotes, CRLF/LF, BOM). Delimiter is detected from the header line: , ; or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

/** Builds CSV text (always quotes cells that need it). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

/** Standard targets a column can map to (custom fields are added per workspace). */
export const IMPORT_TARGETS: Record<string, { label: string; synonyms: string[] }> = {
  name: { label: 'Name', synonyms: ['name', 'full name', 'customer name', 'client name', 'lead name', 'contact name', 'naam'] },
  mobile: { label: 'Mobile', synonyms: ['mobile', 'mobile no', 'mobile number', 'phone', 'phone no', 'phone number', 'contact', 'contact no', 'contact number', 'whatsapp', 'whatsapp no', 'cell'] },
  email: { label: 'Email', synonyms: ['email', 'email id', 'e mail', 'mail', 'email address'] },
  city: { label: 'City', synonyms: ['city', 'location', 'town'] },
  source: { label: 'Source', synonyms: ['source', 'lead source', 'channel', 'utm source'] },
  status: { label: 'Lead status', synonyms: ['status', 'lead status', 'temperature', 'priority'] },
  stage: { label: 'Stage', synonyms: ['stage', 'lead stage', 'pipeline stage'] },
  remark: { label: 'Remark', synonyms: ['remark', 'remarks', 'note', 'notes', 'comment', 'comments', 'description', 'requirement'] },
  follow_up: { label: 'Next follow-up (date)', synonyms: ['follow up', 'followup', 'follow up date', 'next follow up', 'callback', 'call back date'] },
  owner: { label: 'Owner (user email)', synonyms: ['owner', 'assigned to', 'rm', 'rm email', 'owner email', 'assignee'] },
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-./]+/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Suggests a target for each column header. Custom fields match by label or key.
 * Returns header index → target key ('' = ignore). Each target is used at most once.
 */
export function guessMapping(headers: string[], customFields: { key: string; label: string }[] = []): string[] {
  const used = new Set<string>();
  const candidates: [string, string[]][] = [
    ...Object.entries(IMPORT_TARGETS).map(([k, v]) => [k, v.synonyms] as [string, string[]]),
    ...customFields.map((f) => [`cf:${f.key}`, [norm(f.label), norm(f.key)]] as [string, string[]]),
  ];
  return headers.map((h) => {
    const n = norm(h);
    const hit = candidates.find(([k, syn]) => !used.has(k) && syn.includes(n));
    if (!hit) return '';
    used.add(hit[0]);
    return hit[0];
  });
}

/** Parses common Indian date inputs for follow-ups: 2026-11-05, 05/11/2026, 05-11-2026 (day first), optional time. */
export function parseDateInput(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return validDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 10, m[5] ? +m[5] : 0);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return validDate(+m[3], +m[2], +m[1], m[4] ? +m[4] : 10, m[5] ? +m[5] : 0);
  return null;
}

function validDate(y: number, mo: number, d: number, h: number, mi: number): Date | null {
  const date = new Date(y, mo - 1, d, h, mi);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}
