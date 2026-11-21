import { PRIVATE_PLAYTESTING } from '../playtesting';

export type HomeMode = 'ai' | 'meta' | 'practice' | 'friend' | 'mcp';

export const homeModes: readonly HomeMode[] = PRIVATE_PLAYTESTING ? ['mcp', 'friend', 'practice', 'ai'] : ['ai', 'meta', 'practice', 'friend'];
export const defaultHomeMode = homeModes[0];
