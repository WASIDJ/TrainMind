// ULID 生成(时间有序,规格 §3 "推荐 ULID")— 零依赖实现,Crockford base32
import { getRandomValues } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ENCODING[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** 26 字符 ULID:48bit 时间戳(10 字符)+ 80bit 随机(16 字符) */
export function ulid(now: number = Date.now()): string {
  let random = 0n;
  for (const b of getRandomValues(new Uint8Array(10))) random = (random << 8n) | BigInt(b);
  return encode(BigInt(now), 10) + encode(random, 16);
}
