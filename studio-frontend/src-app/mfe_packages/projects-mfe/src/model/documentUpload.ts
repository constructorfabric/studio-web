export const UPLOAD_LIMITS = {
  files: 20,
  fileBytes: 204_800,
  totalBytes: 1_048_576,
  titleChars: 255,
} as const;

export const UPLOAD_ACCEPT = '.md,.txt,text/markdown,text/plain';

const EXTENSION = /\.(md|txt)$/i;

export type FileProblem = 'extension' | 'size' | 'read' | 'changed' | 'encoding' | 'binary';

export type NameProblem = 'empty' | 'too_long' | 'taken';
export type UploadProblem = FileProblem | NameProblem | 'refused';
export type BatchProblem = 'too_many' | 'too_large';

export type UploadStatus = 'reading' | 'ready' | 'adding' | 'added' | 'error';
export type UploadSection = 'artifacts' | 'specs' | 'sources';

const UPLOAD_SECTIONS: readonly string[] = ['artifacts', 'specs', 'sources'];

export function isUploadSection(section: string): section is UploadSection {
  return UPLOAD_SECTIONS.includes(section);
}

export interface UploadEntry {
  id: string;
  section: UploadSection;
  fileName: string;
  size: number;
  title: string;
  typeKey: string | null;
  content: string | null;
  status: UploadStatus;
  problem: UploadProblem | null;
  message: string | null;
  documentId: string | null;
}

export type UploadRead = { content: string } | { problem: FileProblem };

const FILE_PROBLEMS: readonly UploadProblem[] = [
  'extension',
  'size',
  'read',
  'changed',
  'encoding',
  'binary',
];
const NAME_PROBLEMS: readonly UploadProblem[] = ['empty', 'too_long', 'taken'];

export function isFileProblem(problem: UploadProblem | null): problem is FileProblem {
  return problem !== null && FILE_PROBLEMS.includes(problem);
}

export function isNameProblem(problem: UploadProblem | null): problem is NameProblem {
  return problem !== null && NAME_PROBLEMS.includes(problem);
}

export function fileProblem(file: Pick<File, 'name' | 'size'>): FileProblem | null {
  if (!EXTENSION.test(file.name)) return 'extension';
  if (file.size > UPLOAD_LIMITS.fileBytes) return 'size';
  return null;
}

export function pickedEntry(
  id: string,
  section: UploadSection,
  file: Pick<File, 'name' | 'size'>
): UploadEntry {
  const problem = fileProblem(file);
  return {
    id,
    section,
    fileName: file.name,
    size: file.size,
    title: file.name,
    typeKey: null,
    content: null,
    status: problem ? 'error' : 'reading',
    problem,
    message: null,
    documentId: null,
  };
}

function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

export function decodeUploadText(bytes: ArrayBuffer | Uint8Array, size: number): UploadRead {
  if (bytes.byteLength !== size) return { problem: 'changed' };
  let content: string;
  try {
    // The decoder drops a byte order mark: the backend reads front matter from the first byte.
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { problem: 'encoding' };
  }
  return hasControlCharacters(content) ? { problem: 'binary' } : { content };
}

export function titleKey(title: string): string {
  return title.trim().normalize('NFC').toLowerCase();
}

function holdsName(entry: UploadEntry): boolean {
  return entry.status === 'ready' || entry.status === 'adding' || entry.status === 'added';
}

export function nameProblem(
  entry: Pick<UploadEntry, 'id' | 'title'>,
  batch: readonly UploadEntry[],
  existingTitles: readonly string[]
): NameProblem | null {
  const title = entry.title.trim();
  if (!title) return 'empty';
  if (title.length > UPLOAD_LIMITS.titleChars) return 'too_long';
  const key = titleKey(title);
  if (existingTitles.some((existing) => titleKey(existing) === key)) return 'taken';
  const twin = batch.some(
    (other) => other.id !== entry.id && holdsName(other) && titleKey(other.title) === key
  );
  return twin ? 'taken' : null;
}

export function rowProblem(
  entry: UploadEntry,
  held: readonly UploadEntry[],
  existingTitles: readonly string[]
): UploadProblem | null {
  if (entry.status !== 'error') return null;
  return isNameProblem(entry.problem) ? nameProblem(entry, held, existingTitles) : entry.problem;
}

/** The prototype's limits on one pick: the rows still in the panel count, the bytes of the new readable files do. */
export function batchProblem(
  entries: readonly UploadEntry[],
  added: readonly Pick<File, 'name' | 'size'>[]
): BatchProblem | null {
  const pending = entries.filter((entry) => entry.status !== 'added').length;
  if (pending + added.length > UPLOAD_LIMITS.files) return 'too_many';
  const bytes = added.reduce((sum, file) => sum + (fileProblem(file) ? 0 : file.size), 0);
  return bytes > UPLOAD_LIMITS.totalBytes ? 'too_large' : null;
}

export function addableIds(entries: readonly UploadEntry[]): string[] {
  return entries
    .filter((entry) => entry.status === 'ready' && entry.typeKey !== null)
    .map((entry) => entry.id);
}

export function canSendAlone(entry: UploadEntry, problem: UploadProblem | null): boolean {
  return (
    entry.status === 'error' &&
    !isFileProblem(entry.problem) &&
    !isNameProblem(problem) &&
    entry.typeKey !== null
  );
}

export interface UploadSummary {
  added: number;
  adding: number;
  attention: boolean;
  pending: UploadEntry[];
  waiting: boolean;
  firstAdded: UploadEntry | null;
}

export function uploadSummary(entries: readonly UploadEntry[]): UploadSummary {
  const pending = entries.filter((entry) => entry.status !== 'added');
  return {
    added: entries.length - pending.length,
    adding: entries.filter((entry) => entry.status === 'adding').length,
    attention: entries.some((entry) => entry.status === 'error'),
    pending,
    waiting: entries.some((entry) => entry.status === 'ready' || entry.status === 'reading'),
    firstAdded: entries.find((entry) => entry.status === 'added') ?? null,
  };
}
