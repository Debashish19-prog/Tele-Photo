declare module 'heic-decode' {
  interface Decoded {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  export default function decode(input: { buffer: ArrayBufferLike | Uint8Array }): Promise<Decoded>;
}
