import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config';

/**
 * Криптомодуль С3 (ТЗ СЧ, таблица 7.5): AES-256-GCM, ключ варианта обёрнут мастер-ключом,
 * мастер-ключ хранится вне БД и не покидает модуль. Все вызовы журналируются вызывающей стороной.
 */
let master: Buffer | undefined;

function masterKey(): Buffer {
  if (master) return master;
  if (config.masterKey) {
    master = Buffer.from(config.masterKey.trim(), 'hex');
  } else if (config.production) {
    throw new Error('Не задан мастер-ключ криптомодуля: KIM_MASTER_KEY или KIM_MASTER_KEY_FILE');
  } else {
    // Среда разработки: ключ создаётся один раз в каталоге ключей, отдельно от БД.
    const file = resolve(config.keyDir, 'kim-master.key');
    if (existsSync(file)) master = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    else {
      master = randomBytes(32);
      if (!config.memoryOnly) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, master.toString('hex'), { mode: 0o600 });
      }
    }
  }
  if (master.length !== 32) throw new Error('Мастер-ключ криптомодуля должен быть 32 байта (64 hex-символа)');
  return master;
}

export interface Sealed { iv: string; data: string }

/** Шифрование AES-256-GCM; тег аутентификации дописывается в конец (совместимо с Web Crypto API). */
export function seal(key: Buffer, plain: Buffer): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}

export function open(key: Buffer, sealed: Sealed): Buffer {
  const buf = Buffer.from(sealed.data, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}

export function newVariantKey() {
  const key = randomBytes(32);
  return { key, wrapped: seal(masterKey(), key) };
}

export function unwrapVariantKey(wrapped: Sealed): Buffer {
  return open(masterKey(), wrapped);
}
