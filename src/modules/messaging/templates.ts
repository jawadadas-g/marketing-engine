import { Liquid } from 'liquidjs';
import { MessagingError } from './errors.js';

// strictVariables and strictFilters turn a typo into an error instead of an
// empty string going out to a real phone.
const engine = new Liquid({ strictVariables: true, strictFilters: true });

/** Throws template_invalid if the body does not parse. */
export function assertParses(body: string): void {
  try {
    engine.parse(body);
  } catch (err) {
    throw new MessagingError('template_invalid', 400, (err as Error).message);
  }
}

export async function render(body: string, variables: Record<string, unknown>): Promise<string> {
  try {
    return await engine.parseAndRender(body, variables);
  } catch (err) {
    const message = (err as Error).message;
    const missing = /undefined variable:\s*([\w.]+)/i.exec(message);
    if (missing) {
      throw new MessagingError('template_variable_missing', 400, `missing variable: ${missing[1]}`, {
        variable: missing[1],
      });
    }
    throw new MessagingError('template_invalid', 400, message);
  }
}
