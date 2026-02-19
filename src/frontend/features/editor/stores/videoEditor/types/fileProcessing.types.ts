export type ImportDisposition =
  | 'imported-new'
  | 'imported-copy'
  | 'reused-existing';

export interface ImportedFileData {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
  thumbnail?: string;
  isDuplicate?: boolean;
  importDisposition?: ImportDisposition;
}

export interface RejectedFileData {
  name: string;
  reason: string;
  error?: string;
}

export interface ImportResult {
  success: boolean;
  importedFiles: ImportedFileData[];
  rejectedFiles?: RejectedFileData[];
  summary?: {
    importedNew: number;
    importedCopies: number;
    reusedExisting: number;
    totalImportedEntries: number;
  };
  error?: string;
}

export interface FileBuffer {
  name: string;
  type: string;
  size: number;
  buffer: ArrayBuffer;
}

export interface ProcessedFileInfo {
  name: string;
  path: string;
  type: string;
  extension: string;
  size: number;
}

export interface FileProcessingSlice {
  // Import methods
  importMediaFromDialog: () => Promise<ImportResult>;
  importMediaFromFiles: (files: File[]) => Promise<void>;
  importMediaFromDrop: (files: File[]) => Promise<ImportResult>;
  importMediaToTimeline: (files: File[]) => Promise<ImportResult>;
}
