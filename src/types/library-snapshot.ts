export interface LibrarySnapshot {
  format: 'baoyi-database-snapshot'; version: 1; id: string; file: string; createdAt: number;
  reason: 'upgrade' | 'manual'; fromSchema: number; targetSchema: number;
  fromVersion: string; targetVersion: string; size: number; sha256: string;
}
export interface LibrarySnapshotEntry extends LibrarySnapshot { state: 'available' | 'missing' | 'changed' }
export interface LibrarySnapshotInventory {
  directory: string; snapshots: LibrarySnapshotEntry[]; total: number; legacyBackups: number;
  recoveryDirectory: string; recoveryBackups: number; warnings: string[];
}
export interface LibraryExportInfo { file: string; createdAt: number; size: number; state: 'available' | 'missing' | 'changed' }
export interface LibrarySafetyInfo {
  version: string; schema: number; dataDirectory: string; database: string;
  inventory: LibrarySnapshotInventory; lastExport: LibraryExportInfo | null;
}
