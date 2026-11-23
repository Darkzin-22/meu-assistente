// Na versão local não há IA externa: o interpretador local em português é usado sempre.
export const claudeAvailable = () => false;
export async function parseWithClaude() { throw new Error('IA indisponível na versão local'); }
export function buildContext() { return ''; }
