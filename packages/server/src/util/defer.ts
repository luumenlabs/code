/** A promise whose settlement is controlled from outside. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const handle: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (handle.settled) return;
      handle.settled = true;
      resolve(value);
    },
    reject: (reason) => {
      if (handle.settled) return;
      handle.settled = true;
      reject(reason);
    },
  };

  return handle;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
