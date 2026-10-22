/**
 * Edge Read Aloud v2 handshake token.
 *
 * SPDX-License-Identifier: LGPL-3.0-only
 * Adapted from rany2/edge-tts src/edge_tts/drm.py.
 * Copyright (c) 2025- rany <rany@riseup.net>, licensed under LGPL-3.0.
 * Source: https://github.com/rany2/edge-tts/blob/b2ffbdd9f43f28f03cc939b5de0f3964aa62d60e/src/edge_tts/drm.py
 * License: licenses/edge-tts-LICENSE
 *
 * This TypeScript adaptation uses simple SHA rounds instead of the upstream
 * unrolled Python implementation. Edge v2 combines CS64 with a SHA-256 variant
 * with a precomputed initial block; ordinary crypto.subtle.digest is not
 * interchangeable with it. All arithmetic below wraps to unsigned 32 bits.
 */

export const EDGE_TTS_DEFAULT_VERSION = "2-143.0.3650.75";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

const SHA_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];
const SHA_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA_ADJUSTMENT = 0xc9dc06a7;
const CS_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];

const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
const rotate16 = (value: number) => ((value << 16) | (value >>> 16)) >>> 0;
const sigma0 = (value: number) => (rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)) >>> 0;
const sigma1 = (value: number) => (rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)) >>> 0;
const multiply = (a: number, b: number) => Math.imul(a, b) >>> 0;

function expandSchedule(words: number[], first = 16): void {
  for (let index = first; index < 64; index++) {
    words[index] = (sigma1(words[index - 2]) + words[index - 7] + sigma0(words[index - 15]) + words[index - 16]) >>> 0;
  }
}

function shaRounds(state: number[], words: number[], first = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  for (let index = first; index < 64; index++) {
    const constant = first === 14 && index === 14 ? SHA_ADJUSTMENT : SHA_CONSTANTS[index];
    const t1 = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + (g ^ (e & (f ^ g))) + constant + words[index]) >>> 0;
    const t2 = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) | (c & (a | b)))) >>> 0;
    [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

function shaDigest(data: Buffer): Buffer {
  const words = new Array<number>(14).fill(0);
  words.push(data.readUIntBE(0, 3), data.readUInt32BE(3));
  for (let index = 16; index < 30; index++) {
    let value = SHA_SCHEDULE[index - 16];
    if (index - 2 >= 14) value += sigma1(words[index - 2]) ^ (index === 16 ? 0x000b92c0 : 0);
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) value += sigma0(words[index - 15]) ^ (index === 29 ? 0x059c0b80 : 0);
    words.push(value >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA_ADJUSTMENT - SHA_CONSTANTS[14]) >>> 0);
  expandSchedule(words, 31);
  let state = shaRounds(SHA_STATE, words, 14).map((word, index) => (word + SHA_INITIAL[index]) >>> 0);

  const length = 57 + data.length;
  const zeroPadding = ((55 - length) % 64 + 64) % 64;
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(zeroPadding + 8)]);
  padded.writeBigUInt64BE(BigInt(length) * BigInt(8), padded.length - 8);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const block = Array.from({ length: 16 }, (_, index) => padded.readUInt32BE(offset + index * 4));
    expandSchedule(block);
    state = shaRounds(state, block).map((word, index) => (word + state[index]) >>> 0);
  }
  const digest = Buffer.alloc(32);
  state.forEach((word, index) => digest.writeUInt32BE(word, index * 4));
  return digest;
}

function cs64Digest(data: Buffer, digest: Buffer): Buffer {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [multiply(keyA, 0x82893933), multiply(keyB, 0x82893933)];
  const terms = CS_COEFFICIENTS.map(([coefficient], index) => multiply(coefficient, factors[index % 2]));
  const offsets = CS_COEFFICIENTS.map(([, offset]) => offset);
  const input = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8);
  data.copy(input, 1);
  for (let index = 0; index < input.length / 4; index++) {
    const word = input.readUInt32LE(index * 4);
    let term = multiply(word, index % 2 === 0 ? keyA : keyB);
    let offset = multiply(rotate16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term = (term + multiply(0xf2f90b1a, factors[0])) >>> 0;
      offset = (offset + 0x0b1a0000) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index], y = terms[index + 1];
    let t = rotate16((offsets[index] + x) >>> 0);
    let q = multiply(t, 0x76f50f34);
    swapAcc = (swapAcc + multiply(rotate16(q), 0xc3efea97) + q) >>> 0;
    t = rotate16((offsets[index + 1] + y) >>> 0);
    q = multiply(t, 0x1881ce3c);
    swapLast = (multiply(rotate16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (multiply(state, keyA) + x) >>> 0;
    for (const factor of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) state = multiply(rotate16(state), factor);
    acc = (acc + state) >>> 0;
    t = (multiply(state, keyB) + y) >>> 0;
    for (const factor of [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]) t = multiply(rotate16(t), factor);
    state = t;
    acc = (acc + state) >>> 0;
  }
  const output = Buffer.alloc(8);
  output.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  output.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return output;
}

/** Round Windows file time down to a five-minute bucket, using integer arithmetic. */
export function generateSecMsGec(timestampMs = Date.now()): string {
  const seconds = BigInt(Math.floor(timestampMs / 1000)) + BigInt(11644473600);
  const ticks = (seconds - seconds % BigInt(300)) * BigInt(10000000);
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const digest = shaDigest(data);
  return `${cs64Digest(data, digest).toString("hex")}-${digest.toString("hex")}`.toUpperCase();
}
