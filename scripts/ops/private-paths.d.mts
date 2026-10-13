import type { FileHandle } from 'node:fs/promises';
export type AdmissionOptions = { repositoryRoot?: string; allowIgnoredLocal?: boolean; mustExist?: boolean };
export function admitPrivatePath(candidate: string, options?: AdmissionOptions): Promise<string>;
export function writeExclusivePrivateJson(candidate: string, value: unknown, options?: AdmissionOptions): Promise<string>;
export function withPrivateFile<T>(candidate: string, action: (file: FileHandle, path: string) => Promise<T>, options?: AdmissionOptions): Promise<T>;
export function replacePinnedContents(file: FileHandle, text: string): Promise<void>;
export function verifyLinkedProject(repositoryRoot: string, expected: { projectId: string; orgId: string; name: string }): Promise<string>;
