export interface R1Database {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      expiration?: number;
      metadata?: Record<string, string>;
    },
  ): Promise<void>;
}
