import type { PublicError } from '../protocol/types.js';

export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export function publicError(error: unknown): PublicError {
  if (error instanceof HarnessError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: '操作失败；请检查本地环境。敏感路径、配置和堆栈未公开。' };
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
