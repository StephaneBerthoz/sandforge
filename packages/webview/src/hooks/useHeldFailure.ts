import { useState } from 'react';

/**
 * The failure a block shows, held while what failed is read again.
 *
 * A read clears its error as it starts again. The block that said what had
 * failed, and the Retry the keyboard was on, gave way to a loading state the
 * moment Retry was pressed: the keyboard was left on nothing, and a screen
 * reader heard the page change under it. Held, the block stays drawn until
 * the answer, its Retry saying the read is on its way.
 *
 * @param failure - What failed as the read last answered; null when nothing did, or while it reads.
 * @param reading - Whether the read is on its way again.
 * @returns The failure to show: the last one while reading, the current one otherwise.
 */
export function useHeldFailure<T>(failure: T | null, reading: boolean): T | null {
  const [held, setHeld] = useState<T | null>(failure);
  // Kept in step with every answer, as React keeps state derived from props:
  // set during the render, before anything of it is drawn.
  if (!reading && held !== failure) setHeld(failure);
  return reading ? held : failure;
}
