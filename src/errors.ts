export class DomainError extends Error {
 constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export function transitionAllowed(current: string, target: string) {
 return current === 'PENDING' || current === target;
}
