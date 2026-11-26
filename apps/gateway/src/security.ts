import crypto from 'node:crypto';

export interface SessionClaims {
  sub: number;
  role: 'admin' | 'client';
  username: string;
  tv: number;
  exp: number;
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Hashes a plaintext password using scrypt with a 16-byte random salt.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verifies a plaintext password against a stored `salt:hash` value in constant time.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Encrypts sensitive strings (API keys, upstream secrets) using AES-256-GCM.
 */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts a string encrypted by `encryptSecret`.
 */
export function decryptSecret(payload: string, masterKey: Buffer): string {
  if (!payload) return '';
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function generateApiKey(): string {
  return `sbk_${crypto.randomBytes(24).toString('hex')}`;
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 3)}***${value.slice(-2)}`;
  return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

export function signSession(
  claims: Omit<SessionClaims, 'exp'>,
  masterKey: Buffer,
  ttlMs = SESSION_TTL_MS,
): string {
  const payload: SessionClaims = {
    ...claims,
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', masterKey)
    .update(encoded, 'utf8')
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySession(token: string, masterKey: Buffer): SessionClaims | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', masterKey)
    .update(encoded, 'utf8')
    .digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as SessionClaims;
    if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Simple in-memory login failure rate limiter per scope + client IP.
 */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 20,
    private readonly windowMs = 15 * 60_000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const rec = this.attempts.get(key);
    if (!rec) return false;
    if (rec.resetAt <= now) {
      this.attempts.delete(key);
      return false;
    }
    return rec.count >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const rec = this.attempts.get(key);
    if (!rec || rec.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    rec.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}
