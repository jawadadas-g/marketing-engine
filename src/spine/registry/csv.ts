/**
 * A small RFC 4180 reader. Node has no CSV parser and the format is smaller
 * than the dependency: quoted fields, doubled quotes inside them, commas and
 * newlines inside quotes, CRLF or LF line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  // Strip a UTF-8 BOM: Excel writes one and it would corrupt the first header.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;

    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    switch (char) {
      case '"':
        // A quote only opens a field at its start; elsewhere it is a character.
        if (!started && field === '') quoted = true;
        else field += char;
        started = true;
        break;
      case ',':
        endField();
        break;
      case '\r':
        if (body[i + 1] === '\n') i += 1;
        endRow();
        break;
      case '\n':
        endRow();
        break;
      default:
        field += char;
        started = true;
    }
  }

  // A trailing newline should not produce an empty final row.
  if (field !== '' || row.length > 0) endRow();

  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

export const IMPORT_HEADER = [
  'name',
  'country',
  'cr',
  'vat',
  'domain',
  'phone',
  'email',
  'relationship',
  'tags',
] as const;

export type ImportRow = Record<(typeof IMPORT_HEADER)[number], string>;

export class CsvFormatError extends Error {}

/** Rows keyed by the fixed header, which must match exactly. */
export function readImport(text: string): ImportRow[] {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new CsvFormatError('the file is empty');

  const given = header.map((h) => h.trim().toLowerCase());
  if (given.join(',') !== IMPORT_HEADER.join(',')) {
    throw new CsvFormatError(
      `header must be exactly: ${IMPORT_HEADER.join(',')} (got: ${given.join(',')})`,
    );
  }

  return rows.map((row) => {
    const record = {} as ImportRow;
    IMPORT_HEADER.forEach((key, i) => {
      record[key] = (row[i] ?? '').trim();
    });
    return record;
  });
}
