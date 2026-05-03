/**
 * Helpers for surfacing backend mutation failures.
 *
 * The Express routes return either `{ error: string }` or
 * `{ message: string }`. Orval throws an Axios-like error whose
 * parsed JSON body lives on `.data`, so we read both fields and
 * fall back to the JS error message.
 */
export function extractApiError(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: string; message?: string } } | null)
    ?.data;
  return (
    data?.message ??
    data?.error ??
    (err as Error | null)?.message ??
    fallback
  );
}
