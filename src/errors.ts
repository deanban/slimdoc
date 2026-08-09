/**
 * Thrown for inputs we deliberately refuse; the CLI turns these into messages.
 *
 * This lives apart from `extract.ts` so that the container readers — which sit
 * below extraction and are imported by it — can refuse a malformed file with
 * the same error type without importing their own caller.
 */
export class UnsupportedFormatError extends Error {
  readonly format: string;

  constructor(message: string, format = 'unknown') {
    super(message);
    this.name = 'UnsupportedFormatError';
    this.format = format;
  }
}
