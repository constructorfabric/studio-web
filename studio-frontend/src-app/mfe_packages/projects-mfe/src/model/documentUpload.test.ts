import { describe, expect, it } from 'vitest';
import {
  UPLOAD_LIMITS,
  addableIds,
  batchProblem,
  canSendAlone,
  decodeUploadText,
  fileProblem,
  nameProblem,
  pickedEntry,
  rowProblem,
  titleKey,
  uploadSummary,
  type UploadEntry,
} from './documentUpload';

function entry(overrides: Partial<UploadEntry> = {}): UploadEntry {
  return {
    id: 'e-1',
    section: 'specs',
    fileName: 'notes.md',
    size: 10,
    title: 'notes.md',
    typeKey: null,
    content: '# Notes',
    status: 'ready',
    problem: null,
    message: null,
    documentId: null,
    ...overrides,
  };
}

const file = (name: string, size: number) => ({ name, size });

describe('a picked file', () => {
  it.each([
    ['notes.md', 10, null],
    ['NOTES.TXT', 10, null],
    ['diagram.png', 10, 'extension'],
    ['notes.md.bak', 10, 'extension'],
    ['notes', 10, 'extension'],
    ['big.md', UPLOAD_LIMITS.fileBytes, null],
    ['big.md', UPLOAD_LIMITS.fileBytes + 1, 'size'],
  ])('%s of %d bytes: %s', (name, size, problem) => {
    expect(fileProblem(file(name, size))).toBe(problem);
  });

  it('is read only when its name and size pass', () => {
    expect(pickedEntry('a', 'specs', file('notes.md', 10))).toMatchObject({
      status: 'reading',
      problem: null,
    });
    expect(pickedEntry('b', 'specs', file('notes.pdf', 10))).toMatchObject({
      status: 'error',
      problem: 'extension',
    });
  });
});

describe('reading a file', () => {
  const encoded = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => decodeUploadText(bytes, bytes.length);

  it('keeps UTF-8 text as it is, tabs and line ends included', () => {
    const text = '# Заметки\r\n\tпункт\n';
    expect(decode(encoded(text))).toEqual({ content: text });
  });

  it("drops a UTF-8 byte order mark, so a front matter stays the document's first line", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoded('---\ntype: prd\n---\n')]);
    expect(decode(bytes)).toEqual({ content: '---\ntype: prd\n---\n' });
  });

  it('refuses a Windows-1251 file by its encoding rather than reading mojibake', () => {
    // "Привет" in Windows-1251.
    expect(decode(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toEqual({
      problem: 'encoding',
    });
  });

  it('refuses control characters other than tab, LF and CR', () => {
    expect(decode(encoded('a\u0000b'))).toEqual({ problem: 'binary' });
    expect(decode(encoded('a\u007fb'))).toEqual({ problem: 'binary' });
  });

  it('notices a file that changed between the pick and the read', () => {
    expect(decodeUploadText(encoded('short'), 10)).toEqual({ problem: 'changed' });
  });
});

describe('a title as a key', () => {
  it('ignores case, the spaces around it and the Unicode form', () => {
    expect(titleKey('  README.md ')).toBe(titleKey('readme.MD'));
    // "é" composed and decomposed.
    expect(titleKey('café.md')).toBe(titleKey('café.md'));
  });
});

describe('a name', () => {
  it('is taken by a document of the project, whatever its case', () => {
    expect(nameProblem(entry({ title: 'readme.md' }), [], ['README.md'])).toBe('taken');
  });

  it('is taken by another row of the batch that keeps it', () => {
    const first = entry({ id: 'a', title: 'README.md' });
    const second = entry({ id: 'b', title: 'README.md', status: 'reading' });
    expect(nameProblem(second, [first, second], [])).toBe('taken');
  });

  it('is not taken by a row that cannot be sent, nor by the row itself', () => {
    const refused = entry({ id: 'a', title: 'README.md', status: 'error', problem: 'encoding' });
    const own = entry({ id: 'b', title: 'README.md' });
    expect(nameProblem(own, [refused, own], [])).toBeNull();
  });

  it('is free again once renamed', () => {
    const first = entry({ id: 'a', title: 'README.md' });
    const second = entry({ id: 'b', title: 'README (2).md', status: 'error', problem: 'taken' });
    expect(nameProblem(second, [first, second], ['notes.md'])).toBeNull();
  });

  it('is needed, and at most 255 characters', () => {
    expect(nameProblem(entry({ title: '   ' }), [], [])).toBe('empty');
    expect(nameProblem(entry({ title: `${'a'.repeat(252)}.md` }), [], [])).toBeNull();
    expect(nameProblem(entry({ title: `${'a'.repeat(253)}.md` }), [], [])).toBe('too_long');
  });
});

describe('a name being fixed', () => {
  const documents = ['README.md', 'Notes.md'];
  const kept = entry({ id: 'a', title: 'plan.md' });
  const fixing = (title: string) =>
    entry({ id: 'b', title, typeKey: 'prd', status: 'error', problem: 'taken' });

  it('is checked as it is typed, against the documents and every held file', () => {
    expect(rowProblem(fixing('README.md'), [kept], documents)).toBe('taken');
    expect(rowProblem(fixing('readme (2).md'), [kept], documents)).toBeNull();
    expect(rowProblem(fixing('notes.md'), [kept], documents)).toBe('taken');
    expect(rowProblem(fixing('Plan.md'), [kept], documents)).toBe('taken');
    expect(rowProblem(fixing('  '), [kept], documents)).toBe('empty');
  });

  it('is free once the file that held it is removed', () => {
    expect(rowProblem(fixing('plan.md'), [], documents)).toBeNull();
  });

  it('leaves every other problem as it was', () => {
    const refused = entry({ status: 'error', problem: 'refused', title: 'README.md' });
    const binary = entry({ status: 'error', problem: 'binary', title: 'README.md' });
    expect(rowProblem(refused, [], documents)).toBe('refused');
    expect(rowProblem(binary, [], documents)).toBe('binary');
    expect(rowProblem(entry({ title: 'README.md' }), [], documents)).toBeNull();
  });
});

describe('Add with this name and Try again', () => {
  const taken = (overrides: Partial<UploadEntry> = {}) =>
    entry({ title: 'README.md', status: 'error', problem: 'taken', ...overrides });
  const documents = ['README.md'];
  const can = (row: UploadEntry) => canSendAlone(row, rowProblem(row, [], documents));

  it('waits for a type and a free name, both', () => {
    expect(can(taken())).toBe(false);
    expect(can(taken({ typeKey: 'prd' }))).toBe(false);
    expect(can(taken({ title: 'README (2).md' }))).toBe(false);
    expect(can(taken({ typeKey: 'prd', title: 'README (2).md' }))).toBe(true);
    expect(can(taken({ typeKey: 'prd', title: '  ' }))).toBe(false);
  });

  it('tries a refused file again once it has a type', () => {
    const refused = entry({ title: 'README.md', status: 'error', problem: 'refused' });
    expect(can(refused)).toBe(false);
    expect(can({ ...refused, typeKey: 'prd' })).toBe(true);
  });

  it('has nothing to send for a file problem', () => {
    expect(can(entry({ status: 'error', problem: 'binary', typeKey: 'prd' }))).toBe(false);
  });
});

describe('a pick', () => {
  const rows = (count: number, status: UploadEntry['status'] = 'ready') =>
    Array.from({ length: count }, (_, index) => entry({ id: `e-${index}`, status }));

  it('holds at most 20 files with the rows still in the panel', () => {
    expect(batchProblem(rows(18), [file('a.md', 1), file('b.md', 1)])).toBeNull();
    expect(batchProblem(rows(19), [file('a.md', 1), file('b.md', 1)])).toBe('too_many');
  });

  it('does not count the rows already added', () => {
    expect(batchProblem(rows(19, 'added'), [file('a.md', 1), file('b.md', 1)])).toBeNull();
  });

  it('holds at most 1 MB of readable files', () => {
    const full = Array.from({ length: 5 }, (_, index) => file(`${index}.md`, UPLOAD_LIMITS.fileBytes));
    const rest = UPLOAD_LIMITS.totalBytes - 5 * UPLOAD_LIMITS.fileBytes;
    expect(batchProblem([], [...full, file('last.md', rest)])).toBeNull();
    expect(batchProblem([], [...full, file('last.md', rest + 1)])).toBe('too_large');
    expect(batchProblem([], [...full, file('last.png', rest + 1)])).toBeNull();
  });
});

describe('Add N documents', () => {
  it('sends the rows that are read, have a type and nothing wrong', () => {
    expect(
      addableIds([
        entry({ id: 'typed', typeKey: 'prd' }),
        entry({ id: 'untyped' }),
        entry({ id: 'conflict', typeKey: 'prd', status: 'error', problem: 'taken' }),
        entry({ id: 'reading', typeKey: 'prd', status: 'reading', content: null }),
        entry({ id: 'sent', typeKey: 'prd', status: 'added' }),
      ])
    ).toEqual(['typed']);
  });
});

describe('the toolbar over the rows', () => {
  it('shows while a row waits to be sent, not for a conflict or a refusal alone', () => {
    const waiting = (...rows: UploadEntry[]) => uploadSummary(rows).waiting;
    expect(waiting(entry({ status: 'error', problem: 'taken' }))).toBe(false);
    expect(waiting(entry({ status: 'error', problem: 'refused' }), entry({ status: 'added' }))).toBe(false);
    expect(waiting(entry({ status: 'error', problem: 'taken' }), entry({ id: 'b' }))).toBe(true);
    expect(waiting(entry({ status: 'reading', content: null }))).toBe(true);
  });
});
