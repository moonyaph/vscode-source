
export namespace Iterable {
  export function is<T = any>(arg: any): arg is Iterable<T> {
    return arg && typeof arg === 'object' && typeof arg[Symbol.iterator] === 'function'
  }
}
