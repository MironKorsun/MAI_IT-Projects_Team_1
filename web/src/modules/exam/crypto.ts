import type { VariantContent } from '../../../../shared/types';

export interface KimPackage {
  roomId: string;
  variants: { variantId: string; iv: string; data: string; checksum: string }[];
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function decryptVariant(pkg: KimPackage, variantId: string, keyB64: string): Promise<VariantContent> {
  const v = pkg.variants.find((x) => x.variantId === variantId);
  if (!v) throw new Error('Вариант отсутствует в пакете');
  const key = await crypto.subtle.importKey('raw', b64(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(v.iv) }, key, b64(v.data));
  const digest = await crypto.subtle.digest('SHA-256', plain);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== v.checksum) throw new Error('Контрольная сумма варианта не совпала');
  return JSON.parse(new TextDecoder().decode(plain)) as VariantContent;
}