export const EXPECTED_PROJECT: Readonly<{
  projectId: string;
  orgId: string;
  name: string;
}>;
export function provisionSecrets(
  input: {
    environment: string;
    envPath: string;
    vercelBin: string;
    ownerEmail: string;
    productionOrigin?: string;
  },
  options?: {
    repositoryRoot?: string;
    run?: (input: {
      bin: string;
      args: string[];
      secret: string;
      cwd: string;
    }) => Promise<void>;
    report?: (message: string) => void;
  },
): Promise<{ configured: boolean; count: number; values_retained: boolean }>;
