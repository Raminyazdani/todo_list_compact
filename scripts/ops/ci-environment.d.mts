export function createCiEnvironment(options?: {
  directory?: string;
  ci?: string;
}): Promise<{ configured: boolean; synthetic_only: boolean }>;
