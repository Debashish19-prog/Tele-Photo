import { Buffer } from 'buffer';

/** GramJS uses Buffer as a global throughout. This has to run before it loads. */
const scope = globalThis as unknown as { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;
