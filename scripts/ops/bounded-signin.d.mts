export function boundedSignIn(
  origin: string,
  credentials: { email: string; password: string },
  dependencies?: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<Response>;
