export interface LshParams {
  tables: number;
  bits: number;
  componentsPerBit: number;
  seed: number;
}

export interface LshBucket {
  table: number;
  bucket: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Plane {
  indexes: number[];
  signs: number[];
}

/** Random-hyperplane LSH. Each bit is the sign of a sparse projection. */
export class LshIndex {
  private readonly planes: Plane[][];

  constructor(
    private readonly dim: number,
    private readonly params: LshParams,
  ) {
    const rand = mulberry32(params.seed ^ (dim * 997));
    this.planes = [];
    for (let table = 0; table < params.tables; table++) {
      const bits: Plane[] = [];
      for (let bit = 0; bit < params.bits; bit++) {
        const indexes: number[] = [];
        const signs: number[] = [];
        for (let c = 0; c < params.componentsPerBit; c++) {
          indexes.push(Math.floor(rand() * Math.max(1, dim)) % Math.max(1, dim));
          signs.push(rand() < 0.5 ? -1 : 1);
        }
        bits.push({ indexes, signs });
      }
      this.planes.push(bits);
    }
  }

  signature(vec: Float32Array): LshBucket[] {
    const out: LshBucket[] = [];
    for (let table = 0; table < this.params.tables; table++) {
      let bucket = 0;
      const bits = this.planes[table] ?? [];
      for (let bit = 0; bit < bits.length; bit++) {
        const plane = bits[bit]!;
        let sum = 0;
        for (let c = 0; c < plane.indexes.length; c++) {
          sum += (vec[plane.indexes[c]!] ?? 0) * (plane.signs[c] ?? 1);
        }
        if (sum >= 0) bucket |= 1 << bit;
      }
      out.push({ table, bucket });
    }
    return out;
  }

  /** Exact bucket plus one Hamming-1 neighbour: flip bit `table % bits`. */
  probes(vec: Float32Array): LshBucket[] {
    const exact = this.signature(vec);
    const probes = [...exact];
    for (const item of exact) {
      const bit = item.table % this.params.bits;
      probes.push({ table: item.table, bucket: item.bucket ^ (1 << bit) });
    }
    return probes;
  }
}
