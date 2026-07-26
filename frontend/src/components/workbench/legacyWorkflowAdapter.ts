export interface LegacyDirectoryDone {
  serverSaved?: boolean;
  directoryId?: string;
  workflowJobId?: string;
}

export function shouldClientSaveDirectory(done: LegacyDirectoryDone): boolean {
  return done.serverSaved !== true || !done.directoryId;
}
