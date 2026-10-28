import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, generateKeyPair, type CryptoKey } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StaffRole } from '../../shared/types';
import { config } from './config';
import { ApiError } from './errors';
import { db } from './db';
import { secret, sha256, uuid } from './util';

/** Компонент С1 «Доступ» (ТЗ СЧ FR-01–FR-08, NFR-19, NFR-20, NFR-24). */

export type PrincipalKind = 'participant' | 'staff' | 'results';

export interface Principal {
  kind: PrincipalKind;
  sub: string;
  sid: string;
  roles: StaffRole[];
  attemptId?: string;
  roomId?: string;
  roomIds?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const ISS = 'vp-ts-ege';
const AUD = 'vp-ts-ege-api';
let keys: { privateKey: CryptoKey; publicKey: CryptoKey } | undefined;

async function keyPair() {
  if (!keys) keys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  return keys;
}

// ---------- пароли ----------
export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string) {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const calc = scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(calc, Buffer.from(hash, 'base64'));
}

// ---------- сеансы и маркеры ----------
interface AuthSession {
  sid: string;
  principal: Omit<Principal, 'sid'>;
  refreshHash: string;
  usedHashes: Set<string>;
  expiresAt: number;
  lastActivity: number;
  revoked: boolean;
}

const sessions = new Map<string, AuthSession>();

export const REFRESH_COOKIE: Record<PrincipalKind, string> = {
  participant: 'rt_exam',
  staff: 'rt_staff',
  results: 'rt_results',
};

async function accessToken(p: Principal) {
  const { privateKey } = await keyPair();
  return new SignJWT({ kind: p.kind, roles: p.roles, sid: p.sid, attemptId: p.attemptId, roomId: p.roomId, roomIds: p.roomIds })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(p.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSec}s`)
    .sign(privateKey);
}

export async function issue(reply: FastifyReply, principal: Omit<Principal, 'sid'>) {
  const sid = uuid();
  const refresh = `${sid}.${secret(32)}`;
  sessions.set(sid, {
    sid,
    principal,
    refreshHash: sha256(refresh),
    usedHashes: new Set(),
    expiresAt: Date.now() + config.refreshTtlSec * 1000,
    lastActivity: Date.now(),
    revoked: false,
  });
  setRefreshCookie(reply, principal.kind, refresh);
  return { accessToken: await accessToken({ ...principal, sid }), expiresIn: config.accessTtlSec };
}

function setRefreshCookie(reply: FastifyReply, kind: PrincipalKind, value: string) {
  reply.setCookie(REFRESH_COOKIE[kind], value, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: config.refreshTtlSec,
  });
}

/** Ротация маркера обновления; повторное предъявление использованного маркера отзывает сеанс (FR-04). */
export async function refresh(req: FastifyRequest, reply: FastifyReply, kind: PrincipalKind) {
  const token = req.cookies[REFRESH_COOKIE[kind]];
  if (!token) throw new ApiError(401, 'TOKEN_INVALID');
  const sid = token.split('.')[0];
  const s = sessions.get(sid);
  const h = sha256(token);
  if (!s || s.revoked || s.expiresAt < Date.now()) throw new ApiError(401, 'TOKEN_INVALID');
  if (s.usedHashes.has(h)) {
    s.revoked = true;
    throw new ApiError(401, 'TOKEN_INVALID', 'Повторное использование маркера обновления — сеанс отозван');
  }
  if (s.refreshHash !== h) throw new ApiError(401, 'TOKEN_INVALID');
  if (kind === 'staff' && Date.now() - s.lastActivity > config.staffIdleSec * 1000) {
    s.revoked = true;
    throw new ApiError(401, 'TOKEN_INVALID', 'Сеанс завершён по бездействию');
  }
  if (kind === 'staff') {
    const user = db.staff.find((u) => u.id === s.principal.sub);
    if (!user || user.blocked) {
      s.revoked = true;
      throw new ApiError(401, 'TOKEN_INVALID');
    }
    s.principal.roles = user.roles;
    s.principal.roomIds = db.rooms.filter((r) => r.organizerIds.includes(user.id)).map((r) => r.id);
  }
  s.usedHashes.add(h);
  const next = `${sid}.${secret(32)}`;
  s.refreshHash = sha256(next);
  setRefreshCookie(reply, kind, next);
  return { accessToken: await accessToken({ ...s.principal, sid }), expiresIn: config.accessTtlSec };
}