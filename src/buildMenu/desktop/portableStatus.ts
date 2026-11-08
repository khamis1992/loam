import { BuildMenuError } from '../grants.js';

export interface PortableExeStatus {
  format: 'portable-exe';
  signed: false;
  built: false;
}

export function portableStatus(): PortableExeStatus {
  return {
    format: 'portable-exe',
    signed: false,
    built: false,
  };
}

export function requestPortableExeBytes(destination: string): never {
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new BuildMenuError('missing_requirement', 400);
  }
  throw new BuildMenuError('missing_requirement', 400);
}
